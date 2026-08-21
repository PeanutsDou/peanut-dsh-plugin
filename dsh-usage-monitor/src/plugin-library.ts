/**
 * dsh-usage-monitor — personal plugin library scanner.
 *
 * Reads the machine-readable library manifest created under
 * `D:\douzhongjun\dsh-plugin-library\library.json`, executes git queries
 * against each local repository, and compares source packages with the
 * web profile's installed copies.
 *
 * No credentials are touched; git commands are read-only except an explicit
 * refresh operation.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface LibraryRepoConfig {
  id: string
  name: string
  url: string
  localPath: string
  type: 'monorepo' | 'single-plugin'
  branch?: string
  displayName?: string
  baseBranch?: string
  plugins?: string[]
}

export interface DeployTargetConfig {
  id: string
  profile: string
  nodeModules: string
  patchFile: string
  pluginDir: string
}

export interface LibraryManifest {
  version: number
  name?: string
  root?: string
  updatedAt?: string
  repositories: LibraryRepoConfig[]
  deployTargets: DeployTargetConfig[]
}

export interface PluginLibraryPackageStatus {
  dir: string
  name: string
  version: string
  sourceExists: boolean
  installed: boolean
  installedVersion?: string
  deployed: boolean
  enabled: boolean
  status: 'deployed' | 'installed-mismatch' | 'source-only' | 'not-deployed'
  deployPath?: string
}

export interface PluginLibraryRepoStatus {
  id: string
  name: string
  displayName: string
  localPath: string
  type: string
  branch: string
  head: string
  remoteHead?: string
  ahead: number
  behind: number
  dirtyFiles: number
  dirtyList: string[]
  syncState: 'synced' | 'ahead' | 'behind' | 'diverged' | 'unknown'
  error?: string
  plugins: PluginLibraryPackageStatus[]
}

export interface PluginLibraryStatus {
  generatedAt: number
  manifestPath: string
  libraryRoot: string
  repositories: PluginLibraryRepoStatus[]
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim() || error.message))
        return
      }
      resolve(String(stdout).trim())
    })
  })
}

async function gitOr(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await runGit(cwd, args)
  } catch {
    return undefined
  }
}

export function readManifest(libraryRoot: string): LibraryManifest {
  const file = path.join(libraryRoot, 'library.json')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as LibraryManifest
}

/** Parse a package.json without throwing, used for source and deployed copies. */
function readPackage(dir: string): { name?: string; version?: string } | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { name?: string; version?: string }
    return parsed
  } catch {
    return undefined
  }
}

function installedPathFor(name: string, nodeModules: string): string {
  if (name.startsWith('@')) {
    const parts = name.split('/')
    const scope = parts[0]
    if (scope === undefined) return path.join(nodeModules, name)
    const pkg = parts[1] ?? ''
    return path.join(nodeModules, scope, pkg)
  }
  return path.join(nodeModules, name)
}

function patchContains(patchFile: string, needle: string): boolean {
  try {
    const text = fs.readFileSync(patchFile, 'utf8')
    return text.includes(needle)
  } catch {
    return false
  }
}

function dependencyContains(packageJsonFile: string, needle: string): boolean {
  try {
    const raw = fs.readFileSync(packageJsonFile, 'utf8')
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, unknown> }
    const dependencies = parsed.dependencies ?? {}
    return Object.keys(dependencies).some(key => key.includes(needle))
  } catch {
    return false
  }
}

function isEnabled(pkg: { name: string }, deployTarget: DeployTargetConfig | undefined): boolean {
  if (deployTarget === undefined) return false
  const name = pkg.name
  const short = name.includes('/') ? (name.split('/')[1] ?? name) : name
  const patchNeedles = [name, short, name.replace('@', '').replace('/', '-')]
  const packageJsonFile = path.join(deployTarget.nodeModules, '..', 'package.json')
  return patchNeedles.some(needle => patchContains(deployTarget.patchFile, needle) || dependencyContains(packageJsonFile, needle))
}

async function packageStatusFor(dir: string, deployTarget: DeployTargetConfig | undefined): Promise<PluginLibraryPackageStatus> {
  const pkg = readPackage(dir)
  const name = pkg?.name ?? path.basename(dir)
  const version = pkg?.version ?? ''
  const deployPath = deployTarget === undefined ? undefined : installedPathFor(name, deployTarget.nodeModules)
  const installedPkg = deployPath === undefined ? undefined : readPackage(deployPath)
  const installed = installedPkg !== undefined
  const deployed = installed && installedPkg?.version === version
  const enabled = isEnabled({ name }, deployTarget)

  let status: PluginLibraryPackageStatus['status']
  if (!installed) status = 'source-only'
  else if (!deployed) status = 'installed-mismatch'
  else status = 'deployed'

  return {
    dir,
    name,
    version,
    sourceExists: true,
    installed,
    installedVersion: installedPkg?.version,
    deployed,
    enabled,
    status,
    deployPath,
  }
}

async function packageStatusesForRepo(repo: LibraryRepoConfig, deployTarget: DeployTargetConfig | undefined): Promise<PluginLibraryPackageStatus[]> {
  const result: PluginLibraryPackageStatus[] = []
  const searchDirs = (): string[] => {
    if (repo.type === 'single-plugin') return [repo.localPath]
    const entries = (repo.plugins ?? []).map(entry => path.join(repo.localPath, entry))
    return entries
  }

  const dirs = searchDirs()
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue
    result.push(await packageStatusFor(dir, deployTarget))
  }
  return result
}

/** Remote HEAD with a short process-local cache, so UI polling does not hammer GitHub. */
const remoteHeadCache = new Map<string, { at: number; head?: string }>()

async function remoteHeadOf(repo: LibraryRepoConfig, branch: string): Promise<string | undefined> {
  const key = `${repo.url}:${branch}`
  const cached = remoteHeadCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < 30000) return cached.head
  const url = repo.url.replace(/\.git$/, '')
  const output = await gitOr(repo.localPath, ['ls-remote', '--heads', url, branch])
  const head = output?.split(/\s+/)[0]
  remoteHeadCache.set(key, { at: Date.now(), head })
  return head
}

async function repoStatus(repo: LibraryRepoConfig, deployTarget: DeployTargetConfig | undefined): Promise<PluginLibraryRepoStatus> {
  const branch = (await gitOr(repo.localPath, ['branch', '--show-current'])) || repo.branch || 'main'
  const head = (await gitOr(repo.localPath, ['rev-parse', 'HEAD'])) || ''
  const dirtyLines = (await gitOr(repo.localPath, ['status', '--porcelain'])) || ''
  const dirtyList = dirtyLines.split(/\r?\n/).filter(line => line !== '')
  const remoteHead = await remoteHeadOf(repo, branch)

  let ahead = 0
  let behind = 0
  if (head !== '' && remoteHead !== undefined) {
    const aheadOut = await gitOr(repo.localPath, ['rev-list', '--count', `${remoteHead}..${head}`])
    const behindOut = await gitOr(repo.localPath, ['rev-list', '--count', `${head}..${remoteHead}`])
    ahead = Number(aheadOut ?? 0)
    behind = Number(behindOut ?? 0)
  }

  let syncState: PluginLibraryRepoStatus['syncState'] = 'unknown'
  if (remoteHead !== undefined) {
    if (ahead === 0 && behind === 0) syncState = 'synced'
    else if (ahead > 0 && behind === 0) syncState = 'ahead'
    else if (behind > 0 && ahead === 0) syncState = 'behind'
    else if (ahead > 0 && behind > 0) syncState = 'diverged'
  }

  return {
    id: repo.id,
    name: repo.name,
    displayName: repo.displayName ?? repo.name,
    localPath: repo.localPath,
    type: repo.type,
    branch,
    head,
    remoteHead,
    ahead,
    behind,
    dirtyFiles: dirtyList.length,
    dirtyList,
    syncState,
    plugins: await packageStatusesForRepo(repo, deployTarget),
  }
}

export async function buildLibraryStatus(libraryRoot: string): Promise<PluginLibraryStatus> {
  const manifest = readManifest(libraryRoot)
  const deployTarget = manifest.deployTargets?.[0]
  const repositories: PluginLibraryRepoStatus[] = []
  for (const repo of manifest.repositories ?? []) {
    try {
      repositories.push(await repoStatus(repo, deployTarget))
    } catch (error) {
      repositories.push({
        id: repo.id,
        name: repo.name,
        displayName: repo.displayName ?? repo.name,
        localPath: repo.localPath,
        type: repo.type,
        branch: repo.branch ?? '',
        head: '',
        ahead: 0,
        behind: 0,
        dirtyFiles: 0,
        dirtyList: [],
        syncState: 'unknown',
        error: error instanceof Error ? error.message : String(error),
        plugins: [],
      })
    }
  }
  return {
    generatedAt: Date.now(),
    manifestPath: path.join(libraryRoot, 'library.json'),
    libraryRoot,
    repositories,
  }
}

/** Explicitly refresh remote-tracking refs (called by a sync button, not by polling). */
export async function refreshLibrary(libraryRoot: string): Promise<PluginLibraryStatus> {
  const manifest = readManifest(libraryRoot)
  for (const repo of manifest.repositories ?? []) {
    try {
      await runGit(repo.localPath, ['fetch', 'origin', '--quiet'])
      await runGit(repo.localPath, ['remote', 'update', 'origin', '--prune'])
      remoteHeadCache.delete(`${repo.url}:${repo.branch ?? 'main'}`)
    } catch {
      // per-repo errors are surfaced through the status response
    }
  }
  return buildLibraryStatus(libraryRoot)
}
