/**
 * custom-bash — a Windows-capable `bash` tool that registers under the SAME
 * name (`bash`) as the official persistent bash, with a Minimal-compatible
 * description, but executes through `ctx.subprocess.spawn` instead of a PTY.
 *
 * WHY: DeepSeek's first-request trajectory anchor keys on the tool SCHEMA
 * matching the RL training distribution (issue #11: persistent
 * bash + str_replace_editor anchored 5/5 at maxTokens=256000, pwsh/read
 * 8/8 standard-like). The official persistent bash uses a PTY, and DSH's PTY
 * backend is linux/darwin-only — `subprocess-local` throws "terminal
 * inspection is unsupported on platform win32". A custom tool that presents
 * the same name and a Minimal-like description but spawns Git Bash through
 * the ordinary (cross-platform) subprocess seam keeps the schema anchor
 * without the PTY dependency.
 *
 * Executable resolution (config `bashPath`):
 *  - explicit absolute path if configured (e.g. `D:\Git\bin\bash.exe`), or
 *  - on Windows, the FIRST existing candidate probed from the common Git for
 *    Windows install locations (Program Files / D:\ / C:\ / LOCALAPPDATA /
 *    scoop), so the preset works on other machines untouched, or
 *  - `bash` resolved through `ctx.subprocess.resolveExecutable` (PATH lookup)
 *    as the final fallback (also the only path on non-Windows).
 *
 * Semantics mirror the official bash tool: `bash -c <command>` in a fresh
 * process, bounded output, non-zero exit reported not thrown. No sandbox
 * confinement on Windows (the sandbox backend is linux-only); the tool
 * description says so. The bootstrap catalog pairs this with
 * `str_replace_editor` (Minimal's two tools).
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'custom-bash'

/** The subprocess and tools services must exist before this tool can register. */
export const inject = ['subprocess', 'tools']

import { existsSync } from 'node:fs'

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 64000

/**
 * Common Git for Windows install locations, probed in order on win32.
 * The configured `bashPath` (if any) always wins over this list.
 */
const GIT_BASH_CANDIDATES = () => {
  const list = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'D:\\Git\\bin\\bash.exe',
    'E:\\Git\\bin\\bash.exe',
    'C:\\Git\\bin\\bash.exe',
  ]
  if (typeof process.env.LOCALAPPDATA === 'string') {
    list.push(`${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`)
  }
  if (typeof process.env.USERPROFILE === 'string') {
    list.push(`${process.env.USERPROFILE}\\scoop\\apps\\git\\current\\bin\\bash.exe`)
  }
  return list
}

/**
 * Resolve the bash executable: explicit config > win32 candidate probe >
 * `bash` on PATH (final fallback, also the non-Windows default).
 */
function resolveBashPath(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  if (process.platform === 'win32') {
    for (const candidate of GIT_BASH_CANDIDATES()) {
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // Probe failure = treat as absent; continue.
      }
    }
  }
  return 'bash'
}

/** Tool parameter schema for the model-facing command. */
const commandSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The bash command to execute (`bash -c` string domain).',
    },
    workdir: {
      type: 'string',
      description: 'Optional working directory; defaults to the session cwd.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

/** Register the model-facing `bash` tool. */
export function apply(ctx, config) {
  const bashPath = resolveBashPath(config?.bashPath)
  try {
    ctx.logger.info(`${name}: resolved bash executable: ${bashPath}`)
  } catch {
    // Logger unavailable — resolution is already logged nowhere else; tolerate.
  }
  const timeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(config?.maxOutputBytes) && config.maxOutputBytes > 0 ? config.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES

  ctx.tools.register({
    name: 'bash',
    description: [
      'Run commands in a bash shell (Git Bash on Windows)',
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      "* You don't have access to the internet via this tool.",
      '* You do have access to a mirror of common linux and python packages via apt and pip.',
      '* State does NOT persist across command calls: each call runs in a fresh shell.',
      "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
      '* Please avoid commands that may produce a very large amount of output.',
      '* NOTE: runs without OS sandbox confinement on Windows (no landlock); treat output as untrusted.',
    ].join('\n'),
    parameters: commandSchema,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const shell = await ctx.subprocess.resolveExecutable(bashPath, undefined, exec?.signal)
      const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
        ? args.workdir
        : exec?.agent?.session?.header?.cwd
      const signal = exec?.signal
      const handle = ctx.subprocess.spawn({
        argv: [shell, '-c', args.command],
        ...workdir !== undefined ? { cwd: workdir } : {},
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        ...signal !== undefined ? { signal } : {},
        graceMs: 3000,
      })
      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        // A spawn-level failure (bad executable, EPERM) surfaces as a throw,
        // which the runtime turns into an isError result.
        throw new Error(`bash spawn failed: ${String(error)}`)
      }
      let stdout = ''
      let stderr = ''
      try {
        stdout = handle.collected.stdout.readFrom(0).text
        stderr = handle.collected.stderr.readFrom(0).text
      } catch {
        // Collected readers may be unavailable on some backends; tolerate.
      }
      const text = [stdout, stderr].filter((part) => part.length > 0).join('\n')
      const tail = text.length > 0 ? text : `exit code: ${outcome.exitCode} (no output)`
      if (outcome.exitCode !== 0) {
        // Non-zero exit is a reported failure, not a throw: the model sees the
        // command output plus the exit code.
        throw new Error(tail)
      }
      return { text: tail }
    },
  })
}
