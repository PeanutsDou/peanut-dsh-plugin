'use strict'

/**
 * Offline maintenance: remove archived `tutor-*` session records left behind by
 * dsh-selection-tutor crashes/restarts before it gained stale-window reclamation.
 *
 * Idempotent and deterministic:
 *  - drops `tutor-*` ids from the workspace domain's archivedSessionIds list;
 *  - drops `tutor-*` rows from the session projection cache (a cache, safe to trim);
 *  - deletes `<sessionsRoot>/<workspace>/tutor-*` session directories.
 *
 * Run only while the DSH process that owns this home is stopped:
 *   node scripts/cleanup-tutor-orphans.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function dshHome() {
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') return path.resolve(process.env.DSH_HOME)
  const base = process.env.USERPROFILE !== undefined && process.env.USERPROFILE !== ''
    ? process.env.USERPROFILE
    : os.homedir()
  return path.join(base, '.dsh')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tutor-cleanup.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

function cleanWorkspaceArchive(home) {
  const file = path.join(home, 'storages', 'workspace.json')
  const document = readJson(file)
  if (document === undefined) return { file, removed: 0 }
  const archived = Array.isArray(document?.global?.archivedSessionIds) ? document.global.archivedSessionIds : []
  const kept = archived.filter(id => typeof id !== 'string' || !id.startsWith('tutor-'))
  if (kept.length === archived.length) return { file, removed: 0 }
  document.global.archivedSessionIds = kept
  writeJsonAtomic(file, document)
  return { file, removed: archived.length - kept.length }
}

function cleanProjectionCache(home) {
  const file = path.join(home, 'storages', 'session_projcache.json')
  const document = readJson(file)
  if (document === undefined) return { file, removed: 0 }
  const sessions = document?.tables?.sessions
  if (sessions === undefined || typeof sessions !== 'object') return { file, removed: 0 }
  let removed = 0
  for (const key of Object.keys(sessions)) {
    if (key.startsWith('tutor-')) {
      delete sessions[key]
      removed += 1
    }
  }
  if (removed > 0) writeJsonAtomic(file, document)
  return { file, removed }
}

function cleanSessionDirectories(home) {
  const sessionsRoot = path.join(home, 'sessions')
  let removed = 0
  const names = []
  let workspaces
  try {
    workspaces = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return { sessionsRoot, removed: 0, names }
    throw error
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = path.join(sessionsRoot, workspace.name)
    for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('tutor-')) continue
      const target = path.join(workspaceDir, entry.name)
      fs.rmSync(target, { recursive: true, force: true })
      removed += 1
      names.push(target)
    }
  }
  return { sessionsRoot, removed, names }
}

const home = dshHome()
const archive = cleanWorkspaceArchive(home)
const projection = cleanProjectionCache(home)
const directories = cleanSessionDirectories(home)
console.log(JSON.stringify({ home, archive, projection, directories }, null, 2))
