import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { buildRestartHelperScript, offlineRunnerScript } from '../lib/index.js'

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function portUp(port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const attempt = () => {
      const s = net.connect({ port, host: '127.0.0.1', timeout: 300 })
      let done = false
      const finish = (up) => {
        if (done) return
        done = true
        s.destroy()
        if (up) return resolve(true)
        if (Date.now() - start > timeoutMs) return resolve(false)
        setTimeout(attempt, 150)
      }
      s.once('connect', () => finish(true))
      s.once('timeout', () => finish(false))
      s.once('error', () => finish(false))
    }
    attempt()
  })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

function waitForFile(file, timeoutMs = 15000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(file)) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${file}`))
      setTimeout(poll, 150)
    }
    poll()
  })
}

function waitForFileContaining(file, needle, timeoutMs = 15000) {
  const start = Date.now()
  return new Promise((resolve) => {
    const poll = () => {
      try {
        if (fs.readFileSync(file, 'utf8').includes(needle)) return resolve(true)
      } catch { /* not written yet */ }
      if (Date.now() - start > timeoutMs) return resolve(false)
      setTimeout(poll, 150)
    }
    poll()
  })
}

function kill(pid) {
  if (!pid) return
  try { process.kill(pid) } catch { /* already gone */ }
}

test('restart helper waits for the old process to release the port, then relaunches', async () => {
  const tmp = makeTmp('dsh-restart-helper-')
  const port = await freePort()
  const oldPidFile = path.join(tmp, 'old.pid')
  const newPidFile = path.join(tmp, 'new.pid')
  const outLog = path.join(tmp, 'out.log')
  const errLog = path.join(tmp, 'err.log')

  const oldCode = `
    const net = require('node:net')
    const fs = require('node:fs')
    fs.writeFileSync(${JSON.stringify(oldPidFile)}, String(process.pid))
    const s = net.createServer(() => {})
    s.listen(${port}, '127.0.0.1', () => console.log('old up'))
    // Hold the port much longer than any fixed pre-exit delay.
    setTimeout(() => process.exit(0), 5000)
  `
  const newCode = `
    const net = require('node:net')
    const fs = require('node:fs')
    fs.writeFileSync(${JSON.stringify(newPidFile)}, String(process.pid))
    const s = net.createServer(() => {})
    s.listen(${port}, '127.0.0.1', () => console.log('new up'))
    setInterval(() => {}, 1000)
  `
  fs.writeFileSync(path.join(tmp, 'old.cjs'), oldCode)
  fs.writeFileSync(path.join(tmp, 'new.cjs'), newCode)

  const old = spawn(process.execPath, [path.join(tmp, 'old.cjs')], {
    cwd: tmp,
    stdio: 'ignore',
    windowsHide: true,
  })
  assert.ok(await portUp(port, 8000), 'old process should bind the port')

  const helperCode = buildRestartHelperScript(
    [path.join(tmp, 'new.cjs')],
    tmp,
    outLog,
    errLog,
    300, // the old implementation used delayMs+800 and would fire while old still held the port
    port,
  )
  spawn(process.execPath, ['-e', helperCode], { stdio: 'ignore', detached: true, windowsHide: true }).unref()

  await waitForFile(newPidFile, 20000)
  assert.ok(await portUp(port, 3000), 'new process should bind the released port')
  const newPid = Number(fs.readFileSync(newPidFile, 'utf8'))
  assert.notEqual(newPid, old.pid)

  // The success line lands once the new process binds the port.
  const doneSeen = await waitForFileContaining(errLog, 'helper done', 8000)
  assert.ok(doneSeen, 'helper should confirm the new process came up')

  kill(old.pid)
  kill(newPid)
})

test('offline runner executes a BOM-less UTF-8 .ps1 on PowerShell 5.1 and relaunches', async () => {
  const tmp = makeTmp('dsh-offline-ps1-')
  const home = path.join(tmp, 'home')
  const missionDir = path.join(home, 'offline', 'missions', 'test-mission')
  const resultsDir = path.join(missionDir, 'results')
  fs.mkdirSync(resultsDir, { recursive: true })

  const port = await freePort()
  const stepMarker = path.join(tmp, 'step-marker.txt')
  const ps1 = path.join(tmp, 'utf8-script.ps1')
  // Deliberately BOM-less UTF-8 with Chinese comments: Windows PowerShell 5.1
  // mis-reads this file as ANSI and fails with a parser error (the original bug).
  fs.writeFileSync(ps1, `param([string]$Out)\r\n# 中文注释：这条注释在旧 runner 里会让 powershell.exe 解析报错\r\nSet-Content -LiteralPath $Out -Value 'ok-中文' -Encoding UTF8\r\n`, 'utf8')

  const newPidFile = path.join(tmp, 'new.pid')
  const newProcess = path.join(tmp, 'fake-dsh.cjs')
  fs.writeFileSync(newProcess, `
    const fs = require('node:fs')
    const net = require('node:net')
    fs.writeFileSync(${JSON.stringify(newPidFile)}, String(process.pid))
    // Bind the mission port so the runner's relaunch poll sees it come up.
    const s = net.createServer(() => {})
    s.listen(${port}, '127.0.0.1', () => {})
    setInterval(() => {}, 1000)
  `)

  fs.writeFileSync(path.join(home, 'dsh-process.json'), JSON.stringify({
    pid: 123456,
    cwd: tmp,
    commandLine: `node ${newProcess}`,
    execPath: process.execPath,
    execArgv: [],
    argv: [newProcess],
  }, null, 2))

  const missionPath = path.join(missionDir, 'mission.json')
  fs.writeFileSync(missionPath, JSON.stringify({
    id: 'test-mission',
    mode: 'auto',
    createdAt: new Date().toISOString(),
    steps: [{ id: 'step-1', script: ps1, args: [stepMarker], required: true }],
    port,
    portTimeoutMs: 5000,
    phase: 'planned',
    relaunch: true,
  }, null, 2))

  const runnerPath = path.join(tmp, 'runner.cjs')
  fs.writeFileSync(runnerPath, offlineRunnerScript(missionPath))

  // Hide pwsh from PATH so the runner is forced down the PowerShell 5.1
  // -EncodedCommand fallback.
  const env = {
    ...process.env,
    DSH_HOME: home,
    PATH: [
      process.env.SystemRoot + '\\System32',
      process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0',
    ].join(path.delimiter),
  }
  const result = spawnSync(process.execPath, [runnerPath], {
    env,
    windowsHide: true,
    timeout: 30000,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, `runner failed: ${result.stdout}\n${result.stderr}\nrunner log: ${readIfExists(missionPath + '.runner.log')}`)
  assert.equal(fs.readFileSync(stepMarker, 'utf8').trim(), 'ok-中文')
  assert.equal(await waitForFile(newPidFile, 10000).then(() => true), true)
  const mission = JSON.parse(fs.readFileSync(missionPath, 'utf8'))
  assert.equal(mission.phase, 'relaunched')
  const summary = JSON.parse(fs.readFileSync(path.join(resultsDir, 'summary.json'), 'utf8'))
  assert.equal(summary.ok, true)

  kill(Number(fs.readFileSync(newPidFile, 'utf8')))
})

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '<missing>' }
}
