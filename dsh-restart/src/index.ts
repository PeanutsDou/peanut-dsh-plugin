/**
 * dsh-restart — permanent "restart the whole DeepSeek Harness" plugin.
 *
 * Registers a model-callable `restart_harness` tool and a `/restart` command
 * that reload plugins and configuration by restarting the DSH node process.
 *
 * Restart mechanism (Node-native):
 *   - discovery is unnecessary: this plugin runs INSIDE the DSH node process, so
 *     `process.pid` / `process.cwd()` / `process.execPath` / `process.execArgv` /
 *     `process.argv` are read directly.
 *   - relaunch: spawn a detached `node -e` helper (survives the parent's exit via
 *     `detached: true` + `stdio: 'ignore'` + `unref()`), which waits until the old
 *     process releases the listen port, then spawns the new DSH (same argv + cwd,
 *     stdout/stderr appended to timestamped logs). The old process then
 *     `process.exit(0)`s after `delayMs` so the tool result can flush first.
 *   - a "process index" file (`$DSH_HOME/dsh-process.json`) is still written at
 *     boot for external inspection (pid + cwd + command line).
 *
 * @module dsh-restart
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { spawn } from 'node:child_process'
import process from 'node:process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-restart'
export const inject = ['tools', 'commands', 'agents', 'shell', 'sandboxPolicy']

/** Plugin configuration (editable via settings.yaml and, later, the UI card). */
interface RestartConfig {
  legacyRestart: boolean
  continuePrompt: string
  watchdogEnabled: boolean
  watchdogCooldownMs: number
  watchdogPollMs: number
}

const RestartConfigSchema: z<RestartConfig> = z.object({
  legacyRestart: z.boolean().default(false),
  continuePrompt: z.string().default('（系统已重启完成）请继续之前未完成的工作。'),
  watchdogEnabled: z.boolean().default(false),
  watchdogCooldownMs: z.number().default(60000),
  watchdogPollMs: z.number().default(1000),
})

const DEFAULT_CONFIG: RestartConfig = {
  legacyRestart: false,
  continuePrompt: '（系统已重启完成）请继续之前未完成的工作。',
  watchdogEnabled: false,
  watchdogCooldownMs: 60000,
  watchdogPollMs: 1000,
}

/** Offline-mission artifacts: the "work while DSH is down" phase between process exit and relaunch. */
const OFFLINE_ROOT = 'offline'
const MISSION_FILENAME = 'mission.json'
const RUNNER_FILENAME = 'dsh-offline-runner.cjs'
const DEFAULT_PORT_TIMEOUT_MS = 30000

/** The "process file index": boot facts for external inspection. */
const INDEX_FILENAME = 'dsh-process.json'

/** The "resume marker": the in-progress session to restore after a restart. */
const RESUME_FILENAME = 'dsh-resume.json'

/** Watchdog artifact filenames (supervisor script + its pid lock). */
const WATCHDOG_FILENAME = 'dsh-watchdog.cjs'
const WATCHDOG_PID_FILENAME = 'dsh-watchdog.pid'

/** Restart-in-progress flag: stops the watchdog from racing a deliberate restart. */
const RESTARTING_FLAG_FILENAME = 'dsh-restarting.flag'

function homeDir(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function indexFilePath(): string {
  return path.join(homeDir(), INDEX_FILENAME)
}

function resumeFilePath(): string {
  return path.join(homeDir(), RESUME_FILENAME)
}

function watchdogFilePath(): string {
  return path.join(homeDir(), WATCHDOG_FILENAME)
}

function watchdogPidFilePath(): string {
  return path.join(homeDir(), WATCHDOG_PID_FILENAME)
}

function restartingFlagFilePath(): string {
  return path.join(homeDir(), RESTARTING_FLAG_FILENAME)
}

function offlineRootDir(): string {
  return path.join(homeDir(), OFFLINE_ROOT)
}

function missionDir(id: string): string {
  return path.join(offlineRootDir(), 'missions', id)
}

function missionFilePath(id: string): string {
  return path.join(missionDir(id), MISSION_FILENAME)
}

function runnerFilePath(): string {
  return path.join(homeDir(), RUNNER_FILENAME)
}

/** The web port this process listens on (parsed from its own argv), for port-down detection. */
function parseOwnPort(): number | undefined {
  const argv = process.argv
  for (const arg of argv) {
    if (arg.startsWith('--port=')) {
      const n = Number(arg.slice('--port='.length))
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const n = Number(argv[i + 1])
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return undefined
}

function writeRestartingFlag(): void {
  try { fs.writeFileSync(restartingFlagFilePath(), String(Date.now()), 'utf8') } catch { /* best-effort */ }
}

function clearRestartingFlag(): void {
  try { fs.unlinkSync(restartingFlagFilePath()) } catch { /* already gone */ }
}

/** Record the in-progress sessions before restart (for auto-resume after reboot). */
function writeResumeMarker(sessionIds: string[], continuePrompt?: string): void {
  try {
    fs.writeFileSync(resumeFilePath(), JSON.stringify({
      sessionIds,
      ...(continuePrompt !== undefined ? { continuePrompt } : {}),
      restartAt: new Date().toISOString(),
      pid: process.pid,
    }, null, 2) + '\n', 'utf8')
  } catch (error) {
    console.error('[dsh-restart] failed to write resume marker:', error)
  }
}

/** Read a session id defensively from an agent-shaped object. */
function sessionIdOf(agent: unknown): string | undefined {
  const session = (agent as { session?: { id?: unknown; header?: { id?: unknown } } } | undefined)?.session
  const id = session?.id ?? session?.header?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Read the resume marker recorded before the last restart (list or legacy single form). */
function readResumeMarker(): { sessionIds: string[]; continuePrompt?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(resumeFilePath(), 'utf8'))
    const record = parsed as { sessionIds?: unknown; sessionId?: unknown; continuePrompt?: unknown }
    let sessionIds: string[] = []
    if (Array.isArray(record.sessionIds)) {
      sessionIds = record.sessionIds.filter((id): id is string => typeof id === 'string' && id !== '')
    } else if (typeof record.sessionId === 'string' && record.sessionId !== '') {
      sessionIds = [record.sessionId]
    }
    const continuePrompt = typeof record.continuePrompt === 'string' ? record.continuePrompt : undefined
    return { sessionIds, continuePrompt }
  } catch {
    return { sessionIds: [] }
  }
}

/** Append a line to the plugin's own debug log for diagnosing auto-continue. */
function debugLog(message: string): void {
  try {
    fs.appendFileSync(path.join(homeDir(), 'dsh-restart-auto.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch { /* best-effort */ }
}

/** Remove the resume marker once it has been consumed. */
function clearResumeMarker(): void {
  try { fs.unlinkSync(resumeFilePath()) } catch { /* already gone */ }
}

/**
 * After a restart, wait for the recorded session to be resumed (the client
 * re-opens it) and then inject one "continue" follow-up so the agent picks up
 * the interrupted work without a manual prompt. Polls the live agent registry;
 * gives up after ~60s and clears the marker.
 */
function tryAutoContinue(ctx: Context, dynamic: () => RestartConfig): void {
  const { sessionIds, continuePrompt } = readResumeMarker()
  debugLog(`auto-continue: marker has ${sessionIds.length} session(s) ${JSON.stringify(sessionIds)}`)
  if (sessionIds.length === 0) return
  const pending = new Set(sessionIds)
  const prompt = continuePrompt ?? dynamic().continuePrompt
  let attempts = 0
  const interval = setInterval(() => {
    attempts += 1
    for (const sessionId of [...pending]) {
      const agent = ctx.agents.get(sessionId as never)
      if (agent === undefined) continue
      debugLog(`auto-continue: agent for ${sessionId} is live, following up`)
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: name, form: 'instructions' },
        }))
      } catch (error) {
        console.error('[dsh-restart] auto-continue failed:', error)
        debugLog(`auto-continue: followup error for ${sessionId}: ${String(error)}`)
      }
      pending.delete(sessionId)
    }
    if (pending.size === 0) {
      debugLog('auto-continue: all sessions continued')
      clearInterval(interval)
      clearResumeMarker()
    } else if (attempts >= 120) {
      debugLog(`auto-continue: timed out after 60s, ${pending.size} session(s) never resumed: ${JSON.stringify([...pending])}`)
      clearInterval(interval)
      clearResumeMarker()
    }
  }, 500)
  ctx.effect(() => () => clearInterval(interval))
}

/**
 * The supervisor script (written to $DSH_HOME/dsh-watchdog.cjs and run detached):
 * polls whether the DSH web server answers on its port, and relaunches it when
 * the port goes down. Liveness is PORT-based (not pid-based), so a stale process
 * index can never cause a double spawn. A `dsh-restarting.flag` (written by both
 * the restart tool and the watchdog's own relaunch) suppresses relaunch while a
 * restart is already in flight. A `dsh-stop.flag` file stops the watchdog.
 */
function watchdogScript(cooldownMs: number, pollMs: number): string {
  return String.raw`// dsh-watchdog: monitors the DSH web port and relaunches it on death.
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const indexFile = path.join(home, 'dsh-process.json')
const stopFile = path.join(home, 'dsh-stop.flag')
const restartFlag = path.join(home, 'dsh-restarting.flag')
const pidFile = path.join(home, 'dsh-watchdog.pid')
const logFile = path.join(home, 'dsh-watchdog.log')
const PORT = (function () {
  const m = String(process.env.DSH_WEB_URL || '').match(/:(\d+)/)
  return m ? Number(m[1]) : 3080
})()

function log(msg) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n', 'utf8') } catch {}
}

try { fs.writeFileSync(pidFile, String(process.pid), 'utf8') } catch {}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')) } catch { return null }
}

function portUp(cb) {
  const s = net.connect({ port: PORT, host: '127.0.0.1', timeout: 400 })
  s.once('connect', function () { s.destroy(); cb(true) })
  s.once('timeout', function () { s.destroy(); cb(false) })
  s.once('error', function () { cb(false) })
}

function restartInProgress() {
  try {
    const t = Number(fs.readFileSync(restartFlag, 'utf8'))
    return Number.isFinite(t) && (Date.now() - t) < ${cooldownMs}
  } catch { return false }
}

function relaunch() {
  const idx = readIndex()
  if (!idx || !idx.execPath) { log('relaunch: no usable index'); return }
  try { fs.writeFileSync(restartFlag, String(Date.now()), 'utf8') } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = path.join(os.tmpdir(), 'dsh-watchdog-' + stamp + '.out.log')
  const err = path.join(os.tmpdir(), 'dsh-watchdog-' + stamp + '.err.log')
  try {
    const o = fs.openSync(out, 'a')
    const e = fs.openSync(err, 'a')
    const argv = [].concat(idx.execArgv || [], idx.argv || [])
    const child = spawn(idx.execPath, argv, { cwd: idx.cwd, detached: true, stdio: ['ignore', o, e], env: process.env })
    child.once('error', function (er) { log('relaunch spawn error: ' + String(er)) })
    child.unref()
    log('relaunch: spawned pid ' + child.pid + ' cwd=' + idx.cwd)
  } catch (er) {
    log('relaunch failed: ' + String(er))
  }
}

let checking = false
setInterval(function () {
  if (fs.existsSync(stopFile)) {
    log('stop flag present, exiting')
    try { fs.unlinkSync(pidFile) } catch {}
    process.exit(0)
  }
  if (checking) return
  checking = true
  portUp(function (up) {
    if (up) { checking = false; return }
    if (restartInProgress()) { checking = false; return }
    log('port ' + PORT + ' down, relaunching')
    relaunch()
    checking = false
  })
}, ${pollMs})

log('watchdog started, pid ' + process.pid)
`
}

/** Spawn the supervisor once (guarded by its pid lock) so DSH comes back on death. */
function ensureWatchdog(dynamic: () => RestartConfig): void {
  if (!dynamic().watchdogEnabled) return
  try {
    const pid = Number.parseInt(fs.readFileSync(watchdogPidFilePath(), 'utf8'), 10)
    if (!Number.isNaN(pid) && pid > 0) {
      try { process.kill(pid, 0); return } catch { /* stale pid file — spawn a fresh one */ }
    }
  } catch { /* no pid file yet */ }
  try {
    fs.writeFileSync(watchdogFilePath(), watchdogScript(dynamic().watchdogCooldownMs, dynamic().watchdogPollMs), 'utf8')
    const child = spawn(process.execPath, [watchdogFilePath()], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.once('error', () => {})
    child.unref()
    debugLog('watchdog spawned pid ' + child.pid)
  } catch (error) {
    console.error('[dsh-restart] failed to spawn watchdog:', error)
  }
}

/** Quote one argv element for a cmd-runnable command line. */
function quoteArg(value: string): string {
  return /[\s"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value
}

/** Reconstruct the launch command line from the running node process. */
function launchCommandLine(): string {
  return [process.execPath, ...process.execArgv, ...process.argv.slice(1)]
    .map(quoteArg)
    .join(' ')
}

/** Write pid + cwd + command line at boot (kept for external inspection). */
function writeProcessIndex(): void {
  try {
    const file = indexFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      pid: process.pid,
      cwd: process.cwd(),
      commandLine: launchCommandLine(),
      execPath: process.execPath,
      execArgv: process.execArgv,
      argv: process.argv.slice(1),
      startedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8')
  } catch (error) {
    console.error('[dsh-restart] failed to write process index:', error)
  }
}

interface RestartInfo {
  ok: boolean
  pid: number
  cwd: string
  commandLine: string
  delayMs: number
  logOut: string
  logErr: string
  port?: number
}

/** One offline step: a pre-written automation script executed while DSH is down. */
interface OfflineStep {
  id: string
  script: string
  args?: string[]
  timeoutMs?: number
  required?: boolean
}

/** The offline mission: the plan the detached runner executes between exit and relaunch. */
interface OfflineMission {
  id: string
  mode: 'auto' | 'prepare'
  createdAt: string
  steps: OfflineStep[]
  port?: number
  portTimeoutMs?: number
  phase: string
  relaunch: boolean
}

/**
 * The offline-runner supervisor (written to $DSH_HOME/dsh-offline-runner.cjs and
 * spawned detached by the restart tool): waits for the old process to release its
 * port, executes every mission step in order (per-step log + exit code captured),
 * writes results/summary.json, then — in auto mode — relaunches DSH from the
 * process index exactly like the watchdog does. In prepare mode it stops after the
 * tasks and lets a human finish the rest before restarting manually.
 */
export function offlineRunnerScript(missionPath: string): string {
  const literal = missionPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return String.raw`// dsh-offline-runner: executes the offline mission between DSH exit and relaunch.
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const os = require('node:os')
const MISSION_PATH = '${literal}'
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const indexFile = path.join(home, 'dsh-process.json')
const runnerLog = MISSION_PATH + '.runner.log'
let idx = null

function log(msg) {
  try { fs.appendFileSync(runnerLog, new Date().toISOString() + ' ' + msg + '\n', 'utf8') } catch {}
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJson(file, obj) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8') } catch (e) { log('write ' + file + ' failed: ' + e) }
}

function setPhase(m, phase) {
  m.phase = phase
  m.phaseAt = new Date().toISOString()
  writeJson(MISSION_PATH, m)
}

function portUp(port, cb) {
  const s = net.connect({ port: port, host: '127.0.0.1', timeout: 400 })
  s.once('connect', function () { s.destroy(); cb(true) })
  s.once('timeout', function () { s.destroy(); cb(false) })
  s.once('error', function () { cb(false) })
}

function waitPortDown(port, timeoutMs, cb) {
  const start = Date.now()
  function poll() {
    portUp(port, function (up) {
      if (!up) { cb(true); return }
      if (Date.now() - start > timeoutMs) { cb(false); return }
      setTimeout(poll, 500)
    })
  }
  poll()
}

function spawnDsh(attempt, cb) {
  const maxAttempts = 5
  if (attempt > maxAttempts) {
    log('relaunch: giving up after ' + maxAttempts + ' attempts')
    cb(false)
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outLog = path.join(os.tmpdir(), 'dsh-offline-' + stamp + '.out.log')
  const errLog = path.join(os.tmpdir(), 'dsh-offline-' + stamp + '.err.log')
  let out, err, child
  try {
    out = fs.openSync(outLog, 'a')
    err = fs.openSync(errLog, 'a')
    const argv = [].concat(idx.execArgv || [], idx.argv || [])
    child = spawn(idx.execPath, argv, { cwd: idx.cwd || process.cwd(), detached: true, stdio: ['ignore', out, err], env: process.env, windowsHide: true })
  } catch (e) {
    log('relaunch spawn threw: ' + String(e))
    try { if (out) fs.closeSync(out) } catch {}
    try { if (err) fs.closeSync(err) } catch {}
    setTimeout(function () { spawnDsh(attempt + 1, cb) }, 1200)
    return
  }
  let settled = false
  function retry(reason) {
    if (settled) return
    settled = true
    try { fs.closeSync(out) } catch {}
    try { fs.closeSync(err) } catch {}
    log(reason + '; retrying relaunch')
    setTimeout(function () { spawnDsh(attempt + 1, cb) }, 1200)
  }
  child.once('error', function (e) { retry('relaunch spawn error: ' + String(e)) })
  child.once('exit', function (code, signal) {
    retry('relaunched process exited early (code=' + String(code) + ' signal=' + String(signal) + ')')
  })
  setTimeout(function () {
    if (settled) return
    settled = true
    try { fs.closeSync(out) } catch {}
    try { fs.closeSync(err) } catch {}
    log('relaunched pid ' + child.pid + ' and alive after grace period')
    child.unref()
    cb(true)
  }, 3000)
}

function quoteArg(v) {
  const s = String(v)
  return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s
}

function idxCwd() {
  return idx && idx.cwd ? idx.cwd : process.cwd()
}

function findOnPath(exeName) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts = String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
  for (let d = 0; d < dirs.length; d++) {
    for (let x = 0; x < exts.length; x++) {
      const candidate = path.join(dirs[d], exeName + exts[x])
      try { if (fs.existsSync(candidate)) return candidate } catch {}
    }
  }
  return null
}

/**
 * .ps1 invocation strategy:
 *  - Prefer pwsh.exe (-File): PowerShell 7 reads BOM-less UTF-8 correctly, so
 *    scripts with non-ASCII comments just work.
 *  - Fall back to Windows PowerShell 5.1 with -EncodedCommand: the script text
 *    is read as UTF-8 by Node, wrapped in a small ASCII bootstrap that decodes
 *    and invokes it via [scriptblock]::Create(). This avoids the ANSI/GBK
 *    mis-decoding of BOM-less .ps1 files that made 5.1 report "unexpected }".
 *    (Rarely-used $PSScriptRoot resolves to nothing in this fallback; scripts
 *    that rely on it should be run with pwsh present.)
 */
function ps1Invocation(script, args) {
  const pwsh = findOnPath('pwsh.exe')
  if (pwsh) {
    return { file: pwsh, argv: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args) }
  }
  let code = ''
  try { code = fs.readFileSync(script, 'utf8') } catch (e) { throw new Error('cannot read script ' + script + ': ' + e) }
  if (code.charCodeAt(0) === 0xFEFF) code = code.slice(1)
  const scriptB64 = Buffer.from(code, 'utf8').toString('base64')
  const argsLiteral = args.length === 0
    ? '@()'
    : '@(' + args.map(function (a) { return "'" + String(a).replace(/'/g, "''") + "'" }).join(', ') + ')'
  const wrapper = [
    "$ErrorActionPreference = 'Stop'",
    "$s = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + scriptB64 + "'))",
    "$a = " + argsLiteral,
    "try {",
    "  & ([scriptblock]::Create($s)) @a",
    "  if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
    "} catch {",
    "  Write-Error $_",
    "  exit 1",
    "}",
    "exit 0",
  ].join('\n')
  const wrapperB64 = Buffer.from(wrapper, 'utf16le').toString('base64')
  return { file: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', wrapperB64] }
}

function runStep(step, resultsDir, cb) {
  const id = String(step.id || 'step')
  const logPath = path.join(resultsDir, id + '.log')
  const timeoutMs = step.timeoutMs || 120000
  const args = Array.isArray(step.args) ? step.args.map(String) : []
  const script = String(step.script)
  const ext = path.extname(script).toLowerCase()
  let file, argv
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    file = process.execPath
    argv = [script].concat(args)
  } else if (ext === '.ps1') {
    const ps = ps1Invocation(script, args)
    file = ps.file
    argv = ps.argv
  } else {
    file = 'cmd.exe'
    argv = ['/d', '/s', '/c', [script].concat(args).map(quoteArg).join(' ')]
  }
  const out = fs.openSync(logPath, 'a')
  let child
  try {
    child = spawn(file, argv, { cwd: idxCwd(), stdio: ['ignore', out, out], windowsHide: true })
  } catch (e) {
    fs.closeSync(out)
    cb({ id: id, ok: false, error: String(e), logPath: logPath })
    return
  }
  const startedAt = new Date().toISOString()
  let timedOut = false
  const killer = setTimeout(function () {
    timedOut = true
    try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], function () {}) } catch {}
    try { child.kill() } catch {}
  }, timeoutMs)
  child.once('error', function (e) {
    clearTimeout(killer)
    fs.closeSync(out)
    cb({ id: id, ok: false, error: String(e), logPath: logPath, startedAt: startedAt, finishedAt: new Date().toISOString() })
  })
  child.once('exit', function (code) {
    clearTimeout(killer)
    fs.closeSync(out)
    cb({ id: id, ok: code === 0 && !timedOut, exitCode: code, timedOut: timedOut, logPath: logPath, startedAt: startedAt, finishedAt: new Date().toISOString() })
  })
}

function runAll(m, cb) {
  const resultsDir = path.join(path.dirname(MISSION_PATH), 'results')
  fs.mkdirSync(resultsDir, { recursive: true })
  const summary = { missionId: m.id, mode: m.mode, startedAt: new Date().toISOString(), steps: [], ok: true }
  let missionOk = true
  let i = 0
  function finish() {
    summary.ok = missionOk
    summary.finishedAt = new Date().toISOString()
    writeJson(path.join(resultsDir, 'summary.json'), summary)
    cb(summary)
  }
  function next() {
    if (i >= m.steps.length) { finish(); return }
    const step = m.steps[i++]
    runStep(step, resultsDir, function (r) {
      summary.steps.push(r)
      if (!r.ok && step.required !== false) {
        missionOk = false
        summary.abortedAt = new Date().toISOString()
        summary.abortedStep = r.id
        finish()
        return
      }
      next()
    })
  }
  next()
}

function portOfIndex() {
  if (!idx || !idx.commandLine) return 0
  const m = String(idx.commandLine).match(/--port(?:\s+|=)(\d+)/)
  return m ? Number(m[1]) : 0
}

const m = readJson(MISSION_PATH)
if (!m) { log('no mission at ' + MISSION_PATH); process.exit(0) }
log('runner start: mission ' + m.id + ' mode=' + m.mode + ' steps=' + m.steps.length)
idx = readJson(indexFile)
const port = Number(m.port) || portOfIndex() || 3080
const portTimeout = Number(m.portTimeoutMs) || ${DEFAULT_PORT_TIMEOUT_MS}
setPhase(m, 'down')
waitPortDown(port, portTimeout, function (down) {
  if (!down) {
    log('port ' + port + ' still up after ' + portTimeout + 'ms; aborting (old process may still be alive)')
    setPhase(m, 'aborted')
    process.exit(1)
  }
  setPhase(m, 'tasks')
  runAll(m, function (summary) {
    if (!summary.ok) {
      setPhase(m, 'failed')
      log('mission failed; not relaunching: ' + JSON.stringify(summary))
      process.exit(1)
    }
    if (m.mode !== 'auto') {
      setPhase(m, 'prepare-done')
      log('prepare mode: tasks done, NOT relaunching — human finishes the rest, then restarts manually')
      process.exit(0)
    }
    if (!idx || !idx.execPath) {
      setPhase(m, 'relaunch-failed')
      log('no process index; cannot relaunch')
      process.exit(1)
    }
    setPhase(m, 'relaunching')
    spawnDsh(1, function (ok) {
      if (!ok) {
        setPhase(m, 'relaunch-failed')
        log('relaunch failed after retries')
        process.exit(1)
      }
      setPhase(m, 'relaunched')
      log('relaunch confirmed')
    })
  })
})
`
}

/** Persist the mission manifest (temp + rename) and return its path. */
function writeMissionFile(mission: OfflineMission): string {
  const file = missionFilePath(mission.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(mission, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return file
}

/** Write the runner script and spawn it detached; it survives this process's exit. */
function spawnOfflineRunner(missionPath: string): void {
  const file = runnerFilePath()
  fs.writeFileSync(file, offlineRunnerScript(missionPath), 'utf8')
  const child = spawn(process.execPath, [file], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.once('error', () => {})
  child.unref()
}

/**
 * Build the detached `node -e` helper used by plain restarts.
 *
 * The helper polls the old process's listen port until it is released (instead
 * of trusting a fixed delay), then spawns the new DSH with the same argv/cwd.
 * It keeps a short grace window to catch early spawn failures (EADDRINUSE /
 * ENOENT / bad cwd), retries a few times, and writes a diagnostic log to the
 * restart error log. Exported for unit tests.
 */
export function buildRestartHelperScript(
  argv: string[],
  cwd: string,
  logOut: string,
  logErr: string,
  delayMs: number,
  port: number | undefined,
): string {
  const waitTimeoutMs = Math.max(30000, Math.min(120000, delayMs + 15000))
  const retryAttempts = 5
  const retryDelayMs = 1200
  const graceMs = 3000
  const flagPath = restartingFlagFilePath()
  return [
    "'use strict'",
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const argv = ${JSON.stringify(argv)}`,
    `const cwd = ${JSON.stringify(cwd)}`,
    `const logOut = ${JSON.stringify(logOut)}`,
    `const logErr = ${JSON.stringify(logErr)}`,
    `const port = ${port === undefined ? 'undefined' : JSON.stringify(port)}`,
    `const waitTimeoutMs = ${waitTimeoutMs}`,
    `const retryAttempts = ${retryAttempts}`,
    `const retryDelayMs = ${retryDelayMs}`,
    `const graceMs = ${graceMs}`,
    `const restartingFlag = ${JSON.stringify(flagPath)}`,
    "function log(msg) {",
    "  try { fs.appendFileSync(logErr, new Date().toISOString() + ' [dsh-restart-helper] ' + msg + '\\n', 'utf8') } catch {}",
    "}",
    "function portUp(cb) {",
    "  const s = net.connect({ port: port, host: '127.0.0.1', timeout: 300 })",
    "  let done = false",
    "  function finish(up) { if (done) return; done = true; s.destroy(); cb(up) }",
    "  s.once('connect', function () { finish(true) })",
    "  s.once('timeout', function () { finish(false) })",
    "  s.once('error', function () { finish(false) })",
    "}",
    "function waitPortDown(timeoutMs, cb) {",
    "  if (!port) { cb(true); return }",
    "  const start = Date.now()",
    "  function poll() {",
    "    portUp(function (up) {",
    "      if (!up) { cb(true); return }",
    "      if (Date.now() - start > timeoutMs) {",
    "        log('port ' + port + ' still up after ' + timeoutMs + 'ms; attempting spawn anyway')",
    "        cb(false)",
    "        return",
    "      }",
    "      setTimeout(poll, 250)",
    "    })",
    "  }",
    "  poll()",
    "}",
    "let attempts = 0",
    "function spawnNew() {",
    "  attempts += 1",
    "  if (attempts > retryAttempts) {",
    "    log('giving up after ' + (attempts - 1) + ' spawn attempts; clearing restarting flag')",
    "    try { fs.rmSync(restartingFlag, { force: true }) } catch {}",
    "    return",
    "  }",
    "  log('spawn attempt ' + attempts)",
    "  let out, err, child",
    "  try {",
    "    out = fs.openSync(logOut, 'a')",
    "    err = fs.openSync(logErr, 'a')",
    "    child = spawn(process.execPath, argv, { cwd: cwd, detached: true, stdio: ['ignore', out, err], env: process.env, windowsHide: true })",
    "  } catch (e) {",
    "    log('spawn threw: ' + String(e))",
    "    try { if (out) fs.closeSync(out) } catch {}",
    "    try { if (err) fs.closeSync(err) } catch {}",
    "    setTimeout(spawnNew, retryDelayMs)",
    "    return",
    "  }",
    "  let settled = false",
    "  function retry(reason) {",
    "    if (settled) return",
    "    settled = true",
    "    try { fs.closeSync(out) } catch {}",
    "    try { fs.closeSync(err) } catch {}",
    "    log(reason + '; retrying in ' + retryDelayMs + 'ms')",
    "    setTimeout(spawnNew, retryDelayMs)",
    "  }",
    "  child.once('error', function (e) { retry('spawn error: ' + String(e)) })",
    "  child.once('exit', function (code, signal) {",
    "    retry('new process exited early (code=' + String(code) + ' signal=' + String(signal) + ')')",
    "  })",
    "  const grace = setTimeout(function () {",
    "    if (settled) return",
    "    settled = true",
    "    try { fs.closeSync(out) } catch {}",
    "    try { fs.closeSync(err) } catch {}",
    "    log('new process pid ' + child.pid + ' alive after ' + graceMs + 'ms; helper done')",
    "    child.unref()",
    "  }, graceMs)",
    "  grace.unref && grace.unref()",
    "}",
    "log('helper start pid=' + process.pid + ' cwd=' + cwd + ' port=' + port + ' waitTimeoutMs=' + waitTimeoutMs)",
    "waitPortDown(waitTimeoutMs, function (down) {",
    "  log(down ? 'port released' : 'port wait timed out')",
    "  spawnNew()",
    "})",
    "const safety = setTimeout(function () { log('safety exit') }, 60000)",
    "safety.unref()",
  ].join('\n')
}

/**
 * Node-native self-restart. Spawns a detached helper that waits for the old
 * process to release its port, then relaunches DSH with the same argv + cwd.
 * The current process then exits after delayMs so the tool result can flush.
 */
function restart(delayMs: number, mission?: OfflineMission): RestartInfo {
  writeRestartingFlag()
  const argv = [...process.execArgv, ...process.argv.slice(1)]
  const cwd = process.cwd()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = path.join(os.tmpdir(), `dsh-restart-${stamp}.out.log`)
  const logErr = path.join(os.tmpdir(), `dsh-restart-${stamp}.err.log`)
  const port = parseOwnPort()

  if (mission !== undefined) {
    // Offline mission: persist the mission and spawn the detached runner, which
    // waits for this process to exit, executes the steps, then relaunches DSH.
    const missionPath = writeMissionFile(mission)
    spawnOfflineRunner(missionPath)
    debugLog(`offline mission scheduled: ${missionPath} mode=${mission.mode} steps=${mission.steps.length}`)
  } else {
    // Plain restart: detached helper waits for the old process to release its
    // port, then spawns the new DSH with the same argv + cwd, output appended
    // to the log files.
    const helperCode = buildRestartHelperScript(argv, cwd, logOut, logErr, delayMs, port)
    const helper = spawn(process.execPath, ['-e', helperCode], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    helper.once('error', () => {})
    helper.unref()
    debugLog(`plain restart scheduled: pid=${process.pid} port=${String(port)} helper=node -e`)
  }

  // Exit the old process after the tool/command result has had time to flush.
  setTimeout(() => process.exit(0), delayMs)

  return {
    ok: true,
    pid: process.pid,
    cwd,
    commandLine: launchCommandLine(),
    delayMs,
    logOut,
    logErr,
    ...(port !== undefined ? { port } : {}),
  }
}

/** Accept the privileged restart action only from this Web host on loopback. */
function isTrustedWebRestart(req: { socket: { remoteAddress?: string }; headers: { origin?: string; host?: string } }): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const { origin, host } = req.headers
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/** Session ids that should resume after a deliberate restart. */
function runningSessionIds(ctx: Context): string[] {
  return [...new Set(
    ctx.agents.roots()
      .filter(agent => agent.status === 'running')
      .map(agent => String(agent.id)),
  )]
}

/**
 * Legacy restart (PowerShell + WMI + taskkill), kept for compatibility: reads
 * the process index, writes a helper .ps1, launches it detached via WMI, and
 * lets it taskkill the tree before relaunching via cmd /c.
 */
function buildLegacyScript(indexPath: string, delayMs: number): string {
  const indexPathLiteral = indexPath.replace(/'/g, "''")
  return `$ErrorActionPreference = 'Stop'
$indexPath = '${indexPathLiteral}'
if (-not (Test-Path -LiteralPath $indexPath)) { throw "process index not found: $indexPath" }
$idx = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json
$pid0 = [int]$idx.pid
$cwd = [string]$idx.cwd
$cmdline = [string]$idx.commandLine
if (-not (Get-Process -Id $pid0 -ErrorAction SilentlyContinue)) { throw "recorded pid $pid0 is not alive" }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logOut = Join-Path $env:TEMP ("dsh-restart-" + $stamp + ".out.log")
$logErr = Join-Path $env:TEMP ("dsh-restart-" + $stamp + ".err.log")
$cwdB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cwd))
$cmdB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cmdline))
$logOutB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($logOut))
$logErrB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($logErr))
$helperTemplate = @'
$ErrorActionPreference = 'Continue'
$nodePid = __PID__
$cwdB64 = '__CWDB64__'
$cmdB64 = '__CMDB64__'
$logOutB64 = '__LOGOUTB64__'
$logErrB64 = '__LOGERRB64__'
$delayMs = __DELAY__
$cwd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($cwdB64))
$cmdline = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($cmdB64))
$logOut = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($logOutB64))
$logErr = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($logErrB64))
Start-Sleep -Milliseconds $delayMs
taskkill /F /T /PID $nodePid 2>&1 | Out-Null
Start-Sleep -Milliseconds 500
try {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/s','/c', $cmdline -WorkingDirectory $cwd -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr
} catch {
  Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline; CurrentDirectory = $cwd } | Out-Null
}
'@
$helper = $helperTemplate.Replace('__PID__', [string]$pid0).Replace('__CWDB64__', $cwdB64).Replace('__CMDB64__', $cmdB64).Replace('__LOGOUTB64__', $logOutB64).Replace('__LOGERRB64__', $logErrB64).Replace('__DELAY__', [string]${delayMs})
$helperPath = Join-Path $env:TEMP 'dsh-restart-helper.ps1'
Set-Content -LiteralPath $helperPath -Value $helper -Encoding UTF8
$launch = 'pwsh.exe -NoProfile -NonInteractive -File "' + $helperPath + '"'
$r = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = $launch }
$result = [ordered]@{ pid = $pid0; cwd = $cwd; commandLine = $cmdline; delayMs = ${delayMs}; helperReturnValue = [int]$r.ReturnValue; helperPid = [int]$r.ProcessId; logOut = $logOut; logErr = $logErr }
$result | ConvertTo-Json -Compress`
}

/** Run the legacy PowerShell/WMI restart through the shell service. */
async function restartLegacy(ctx: Context, delayMs: number, policy: unknown): Promise<unknown> {
  writeRestartingFlag()
  const request: Record<string, unknown> = {
    command: buildLegacyScript(indexFilePath(), delayMs),
    timeoutMs: 30000,
  }
  if (policy !== undefined) request.sandboxPolicy = policy
  const spec = ctx.shell.resolve(request as never)
  const result = await ctx.shell.run(spec)
  const stdout = result.stdout && typeof result.stdout.text === 'string' ? result.stdout.text : ''
  const stderr = result.stderr && typeof result.stderr.text === 'string' ? result.stderr.text : ''
  if (result.exitCode !== 0) {
    return { ok: false, error: 'legacy restart failed', exitCode: result.exitCode, stdout, stderr }
  }
  try {
    return { ok: true, ...JSON.parse(stdout.trim()) }
  } catch {
    return { ok: false, error: 'failed to parse legacy restart output', stdout, stderr }
  }
}

export function apply(ctx: Context): void {
  debugLog(`apply: start pid=${process.pid}`)
  try {
    writeProcessIndex()
    debugLog('apply: index written')
  } catch (error) {
    debugLog('apply: writeProcessIndex THREW: ' + String(error))
  }
  clearRestartingFlag()

  let resolveConfig: () => RestartConfig = () => DEFAULT_CONFIG
  const dynamic = (): RestartConfig => resolveConfig()
  try {
    installSettingsSection(ctx, settingsNamespace('dsh-restart'), RestartConfigSchema, DEFAULT_CONFIG, {
      setSource: (get) => { resolveConfig = get },
      onChange: () => {},
    })
    debugLog('apply: settings installed')
  } catch (error) {
    debugLog('apply: installSettingsSection THREW: ' + String(error))
  }

  try {
    tryAutoContinue(ctx, dynamic)
    debugLog('apply: auto-continue scheduled')
  } catch (error) {
    debugLog('apply: tryAutoContinue THREW: ' + String(error))
  }
  try {
    ensureWatchdog(dynamic)
    debugLog('apply: watchdog ensured')
  } catch (error) {
    debugLog('apply: ensureWatchdog THREW: ' + String(error))
  }

  const webServer = ctx.get('webServer') as { register: (route: WebRoute) => () => void } | undefined
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-restart/restart',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end('method not allowed')
          return
        }
        if (!isTrustedWebRestart(req)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        const sessionIds = runningSessionIds(ctx)
        if (sessionIds.length > 0) writeResumeMarker(sessionIds)
        const result = restart(2000)
        res.writeHead(202, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ ...result, sessionIds }))
      },
    }), 'dsh-restart: same-origin restart endpoint')
  }

  try {
    ctx.tools.register(defineTool({
    name: 'restart_harness',
    description:
      '重启整个 DeepSeek Harness 进程，用于重新加载插件与配置（profile 的 cordis 组合、settings 等）。'
      + '直接读取当前 node 进程的 pid/工作目录/启动命令行，派生一个 detach 的 helper，'
      + '在旧进程退出并释放端口后以原命令行在原目录重新拉起，然后旧进程退出。'
      + '触发后当前会话连接会短暂中断，网页随后自动重连到新进程。'
      + '返回旧进程 pid、cwd、命令行与日志文件路径。',
    parameters: {
      delayMs: { type: 'number', description: '旧进程退出前等待的毫秒数（给当前结果留出回传时间），默认 2000。' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const a = (args ?? {}) as { delayMs?: number }
      const delayMs = Number(a.delayMs) > 0 ? Math.floor(Number(a.delayMs)) : 2000
      // Only resume sessions that were mid-turn (running) at restart time. Idle
      // (already-ended) conversations are left alone — the client re-opens them.
      const sessionIds = runningSessionIds(ctx)
      if (sessionIds.length > 0) writeResumeMarker(sessionIds)
      if (dynamic().legacyRestart) {
        let policy: unknown
        if (exec?.agent?.session) {
          try { policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session }) } catch { policy = undefined }
        }
        const result = await restartLegacy(ctx, delayMs, policy)
        return { ...(result as object), sessionIds }
      }
      return { ...restart(delayMs), sessionIds }
    },
  }))
    debugLog('apply: restart_harness tool registered')
  } catch (error) {
    debugLog('apply: tools.register THREW: ' + String(error))
  }

  try {
    ctx.tools.register(defineTool({
    name: 'restart_with_tasks',
    description:
      '安排一次"停机离线任务 + 重启"的 DSH 重启：旧进程退出后、新进程拉起前，由独立 runner 依次执行预写的自动化脚本'
      + '（确定性、无需人工交互的步骤），每步日志与退出码写入 <missionDir>/results/，汇总写 results/summary.json；'
      + '随后以原命令行自动重启 DSH，重启后向本会话注入续跑提示词继续未完成的工作。'
      + 'mode=auto：全部步骤成功（或仅非必选步骤失败）后自动重启；mode=prepare：步骤执行完即停止、不自动重启，'
      + '等待用户完成剩余人工步骤后手动重启。'
      + '使用前必须评估每个步骤的复杂度：可脚本化的确定性步骤（文件操作、迁移、备份、测试运行、外部服务调用、'
      + '等待端口/条件）才可放入 tasks；需要人工判断、交互或提供新信息的步骤绝不能放进 tasks，'
      + '应直接在对话中告知用户，等用户完成后手动重启或再次调用本工具。'
      + '脚本必须预先写到磁盘（.js/.cjs/.mjs/.ps1/.cmd/.bat），传绝对路径。'
      + '触发后当前会话连接会短暂中断，网页随后自动重连到新进程。',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: '离线任务步骤，按顺序执行；每步必须引用磁盘上已存在的脚本',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            script: { type: 'string', required: true, description: '脚本绝对路径（.js/.cjs/.mjs/.ps1/.cmd/.bat）' },
            args: { type: 'array', items: { type: 'string' }, description: '传给脚本的参数（可选）' },
            timeoutMs: { type: 'number', description: '单步超时毫秒数，默认 120000' },
            required: { type: 'boolean', description: '失败是否中止后续步骤并放弃自动重启，默认 true' },
          },
        },
      },
      mode: { type: 'string', enum: ['auto', 'prepare'], description: 'auto=成功即自动重启；prepare=跑完即停，等人完成后手动重启' },
      resumePrompt: { type: 'string', description: '重启后注入给 agent 的续跑提示词；默认提示读取 results/summary.json 后继续' },
      delayMs: { type: 'number', description: '旧进程退出前等待的毫秒数，默认 2000' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const a = (args ?? {}) as {
        tasks?: Array<{ script?: string; args?: string[]; timeoutMs?: number; required?: boolean }>
        mode?: string
        resumePrompt?: string
        delayMs?: number
      }
      const failure = (error: string) => ({ ok: false, error })
      const tasks = Array.isArray(a.tasks) ? a.tasks : []
      if (tasks.length === 0) {
        return failure('tasks 不能为空：至少提供一个可脚本化的步骤')
      }
      const missing = tasks.filter((t) => typeof t.script !== 'string' || !fs.existsSync(t.script))
      if (missing.length > 0) {
        return failure('以下脚本不存在（请先写脚本再调度）：' + missing.map((t) => String(t.script)).join(', '))
      }
      const mission: OfflineMission = {
        id: 'mission-' + Date.now(),
        mode: a.mode === 'prepare' ? 'prepare' : 'auto',
        createdAt: new Date().toISOString(),
        steps: tasks.map((t, i) => ({
          id: 'step-' + (i + 1),
          script: String(t.script),
          ...(t.args !== undefined ? { args: t.args } : {}),
          ...(t.timeoutMs !== undefined ? { timeoutMs: t.timeoutMs } : {}),
          ...(t.required !== undefined ? { required: t.required } : {}),
        })),
        port: parseOwnPort(),
        portTimeoutMs: DEFAULT_PORT_TIMEOUT_MS,
        phase: 'planned',
        relaunch: true,
      }
      const delayMs = Number(a.delayMs) > 0 ? Math.floor(Number(a.delayMs)) : 2000
      const sessionIds = runningSessionIds(ctx)
      if (sessionIds.length > 0) {
        const resumePrompt = a.resumePrompt ?? (
          '（DSH 已通过停机离线任务重启完成）请读取本次离线任务的执行结果并汇报：'
          + `汇总文件在 ${path.join(missionDir(mission.id), 'results', 'summary.json')}`
          + '，逐步日志在同目录 results/step-*.log。'
        )
        writeResumeMarker(sessionIds, resumePrompt)
      }
      const result = restart(delayMs, mission)
      return { ...result, ok: true, missionPath: missionFilePath(mission.id), sessionIds, error: null }
    },
  }))
    debugLog('apply: restart_with_tasks tool registered')
  } catch (error) {
    debugLog('apply: restart_with_tasks THREW: ' + String(error))
  }

  try {
    ctx.commands.register({
    name: 'restart',
    description: '重启 DeepSeek Harness（重载插件与配置）',
    recordInput: false,
    async handler(invocation) {
      // Only resume sessions that were mid-turn (running); idle conversations stay put.
      const sessionIds = runningSessionIds(ctx)
      if (sessionIds.length > 0) writeResumeMarker(sessionIds)
      let result: unknown
      if (dynamic().legacyRestart) {
        let policy: unknown
        if (invocation?.agent?.session) {
          try { policy = ctx.sandboxPolicy.resolve({ session: invocation.agent.session }) } catch { policy = undefined }
        }
        result = await restartLegacy(ctx, 2000, policy)
      } else {
        result = restart(2000)
      }
      const r = result as { ok?: boolean; pid?: number; delayMs?: number; logOut?: string; error?: string }
      if (r.ok === false) {
        return { kind: 'error', text: r.error ?? '重启失败' }
      }
      return {
        kind: 'success',
        text: `重启已安排：DSH 进程 PID ${r.pid} 将在约 ${r.delayMs}ms 后重启，将恢复 ${sessionIds.length} 个会话，新进程日志见 ${r.logOut}`,
      }
    },
  })
    debugLog('apply: restart command registered')
  } catch (error) {
    debugLog('apply: commands.register THREW: ' + String(error))
  }

  debugLog('apply: complete')
}
