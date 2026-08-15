/**
 * dsh-file-launcher — 双击 Ctrl 唤起全盘文件名搜索框（DSH host 插件）。
 *
 * 后端职责：
 *  1. 通过 Everything 引擎（es.exe CLI）秒级全盘搜索文件名；
 *  2. 收藏 + 常用打分持久化（~/.dsh/file-launcher/state.json）；
 *  3. 通过 webServer 服务暴露搜索框 UI 页面 + JSON API。
 *
 * 搜索框 UI 由 DshShell（WebView2 桌面壳）以无边框置顶窗口加载，
 * 因此即使 DSH 最小化到托盘，双击 Ctrl 也能唤起。
 */
import { execFile, exec } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVERYTHING_DIR = join(HERE, 'everything')
const ES_EXE = join(EVERYTHING_DIR, 'es.exe')
const EVERYTHING_EXE = join(EVERYTHING_DIR, 'everything.exe')
const STATE_PATH = dshHomePath('file-launcher', 'state.json')

export const name = 'file-launcher'
export const inject = ['webServer']

// ---------------------------------------------------------------------------
// Everything 搜索（es.exe CLI + 系统 Everything 服务）
// ---------------------------------------------------------------------------

let codePage = null

/** 读取系统 ANSI 代码页（中文 Windows 为 936 = GBK）。 */
function detectCodePage() {
  return new Promise((resolve) => {
    execFile('chcp', { encoding: 'utf8', windowsHide: true, timeout: 2000 }, (err, stdout) => {
      if (err) return resolve('936')
      const m = String(stdout).match(/(\d+)/)
      resolve(m ? m[1] : '936')
    })
  })
}

async function decodeBuffer(buf) {
  if (codePage === null) codePage = await detectCodePage()
  if (codePage === '65001') return buf.toString('utf8')
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return buf.toString('utf8')
  }
}

/** 执行 es.exe，返回 stdout Buffer；失败（如 IPC 未连接）返回 null。 */
function runEs(args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(ES_EXE, args, {
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      timeout,
      encoding: 'buffer',
    }, (err, stdout) => {
      if (err) resolve(null)
      else resolve(stdout)
    })
  })
}

/** 解析 es.exe -csv 输出：Size,Date Modified,Attributes,Filename */
function parseCsv(stdout) {
  const lines = stdout.trim().split('\n')
  if (lines.length < 2) return []
  const out = []
  for (const line of lines.slice(1)) {
    const parts = []
    let cur = ''
    let inQuotes = false
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue }
      if (ch === ',' && !inQuotes) { parts.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    parts.push(cur.trim())
    const size = parts[0] ? parseInt(parts[0], 10) : undefined
    const modified = parts[1] || undefined
    const attrs = parts[2] || ''
    const fullPath = parts[3] || ''
    if (!fullPath) continue
    const name = fullPath.split('\\').pop() || fullPath
    const dir = fullPath.substring(0, fullPath.lastIndexOf('\\')) || fullPath
    out.push({ name, dir, fullPath, size, modified, isFolder: attrs.includes('D') })
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 独立 Everything 实例：系统服务管道名是 "Everything Service"，es.exe 默认连不上；
// 因此用专属命名实例 "dshfl"（自有索引），es.exe 通过 -instance dshfl 稳定连接。
const EVERYTHING_INI = join(EVERYTHING_DIR, 'Everything.ini')

let everythingInit = null

/** 后台拉起捆绑的独立 Everything 实例（便携配置 + 自有索引）。 */
function startEverythingInstance() {
  if (!existsSync(EVERYTHING_EXE)) return
  execFile(EVERYTHING_EXE, ['-startup', '-config', EVERYTHING_INI], { windowsHide: true }, () => {})
}

/** 确保独立实例可连接（单次在途初始化，避免并发重复拉起；每次探测，实例挂了会自动重启）。 */
function ensureEverything() {
  if (everythingInit) return everythingInit
  everythingInit = (async () => {
    try {
      let ok = await runEs(['-n', '1', 'zzz_no_such_file_probe'], 1500)
      if (ok === null) {
        startEverythingInstance()
        for (let i = 0; i < 8; i++) {
          await sleep(300)
          ok = await runEs(['-n', '1', 'zzz_no_such_file_probe'], 800)
          if (ok !== null) break
        }
      }
      return ok !== null
    } finally {
      everythingInit = null
    }
  })()
  return everythingInit
}

/** 全盘搜索文件名，返回匹配项（名称 + 路径 + 大小 + 修改时间 + 是否目录）。 */
async function everythingSearch(query, max = 30) {
  const ok = await ensureEverything()
  if (!ok) return []
  const stdout = await runEs(['-n', String(max), '-csv', '-size', '-date-modified', '-attributes', query], 4000)
  if (stdout === null) return []
  return parseCsv(await decodeBuffer(stdout))
}

// ---------------------------------------------------------------------------
// 持久化：收藏 + 使用打分 + 查询历史
// ---------------------------------------------------------------------------

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return {
      favorites: {},
      usage: {},
      queries: {},
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
    }
  } catch {
    return { favorites: {}, usage: {}, queries: {} }
  }
}

function saveState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch { /* ignore */ }
}

function normalize(t) {
  return String(t).toLowerCase().replace(/[\\/_\-.\s]+/g, '')
}

/** 对一条搜索结果打分：收藏 > 文件名匹配质量 > 常用(打开次数) > 最近打开。 */
function scoreEntry(entry, query, state) {
  const nName = normalize(entry.name)
  const nPath = normalize(entry.fullPath)
  const nQuery = normalize(query)
  let score = 0

  if (state.favorites[entry.fullPath]) score += 1000

  if (nName === nQuery) score += 100
  else if (nName.startsWith(nQuery)) score += 70
  else if (nName.includes(nQuery)) score += 50
  else {
    let any = false
    for (const part of query.toLowerCase().split(/\s+/)) {
      if (part && nName.includes(normalize(part))) { any = true; break }
    }
    if (!any) return 0
    score += 30
  }

  if (nPath.includes(nQuery)) score += 8

  const u = state.usage[entry.fullPath]
  if (u) {
    score += Math.min(u.count || 0, 20) * 30
    const ageDays = Math.max(0, (Date.now() - (u.lastOpenedAt || 0)) / 86400000)
    score += Math.max(0, 20 - ageDays)
  }

  if (entry.isFolder) score += 5
  return score
}

function fmtSize(n) {
  if (n === undefined || Number.isNaN(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function decorate(entry, state, source) {
  return {
    name: entry.name,
    dir: entry.dir,
    fullPath: entry.fullPath,
    isFolder: entry.isFolder,
    size: fmtSize(entry.size),
    modified: entry.modified,
    favorite: Boolean(state.favorites[entry.fullPath]),
    usageCount: (state.usage[entry.fullPath] && state.usage[entry.fullPath].count) || 0,
    score: Math.round(entry.score || 0),
    source: source || 'everything',
  }
}

/** 空查询的"首页"：收藏 + 最近打开，按使用热度排序。 */
function homeItems(state, limit) {
  const items = []
  const seen = new Set()
  for (const [fullPath, meta] of Object.entries(state.favorites)) {
    const name = fullPath.split('\\').pop() || fullPath
    const dir = fullPath.substring(0, fullPath.lastIndexOf('\\')) || fullPath
    items.push({ name, dir, fullPath, isFolder: false, favorite: true, usageCount: (state.usage[fullPath]?.count) || 0, score: 1000 + ((state.usage[fullPath]?.count) || 0) * 30, source: 'favorite', meta })
    seen.add(fullPath)
  }
  const usage = Object.entries(state.usage)
    .sort((a, b) => (b[1].lastOpenedAt || 0) - (a[1].lastOpenedAt || 0))
  for (const [fullPath, u] of usage) {
    if (seen.has(fullPath)) continue
    if (!existsSync(fullPath)) continue
    const name = fullPath.split('\\').pop() || fullPath
    const dir = fullPath.substring(0, fullPath.lastIndexOf('\\')) || fullPath
    let isFolder = false
    try { isFolder = statSync(fullPath).isDirectory() } catch { /* ignore */ }
    items.push({ name, dir, fullPath, isFolder, favorite: false, usageCount: u.count || 0, score: (u.count || 0) * 30, source: 'recent' })
  }
  return items.slice(0, limit).map((i) => decorate({ ...i, size: undefined, modified: undefined }, state, i.source))
}

// ---------------------------------------------------------------------------
// 打开文件 / 目录
// ---------------------------------------------------------------------------

function openPath(fullPath) {
  return new Promise((resolve) => {
    exec(`start "" "${fullPath}"`, { shell: 'cmd.exe', windowsHide: true }, (err) => resolve(!err))
  })
}

function revealPath(fullPath) {
  return new Promise((resolve) => {
    exec(`explorer.exe /select,"${fullPath}"`, { windowsHide: true }, (err) => resolve(!err))
  })
}

// ---------------------------------------------------------------------------
// 插件入口：注册 webServer 路由
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const state = loadState()

  const recordUsage = (fullPath) => {
    const u = state.usage[fullPath] || { count: 0 }
    u.count = (u.count || 0) + 1
    u.lastOpenedAt = Date.now()
    state.usage[fullPath] = u
    saveState(state)
  }

  const setFavorite = (fullPath, fav) => {
    if (fav) state.favorites[fullPath] = { addedAt: Date.now() }
    else delete state.favorites[fullPath]
    saveState(state)
  }

  const recordQuery = (q) => {
    if (!q) return
    const r = state.queries[q] || { count: 0 }
    r.count = (r.count || 0) + 1
    r.lastUsedAt = Date.now()
    state.queries[q] = r
    saveState(state)
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      try { resolve(data.trim() === '' ? {} : JSON.parse(data)) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })

  // UI 页面
  ctx.webServer.register({
    kind: 'exact',
    path: '/file-launcher',
    handler: (req, res) => {
      try {
        let html = readFileSync(join(HERE, 'launcher.html'), 'utf8')
        // 绑定 DSH 主题：读取 ui-theme 偏好，注入 boot theme script
        let pref = 'system'
        try {
          const settings = ctx.get('settings')
          const section = settings && settings.get('ui-theme')
          if (section && typeof section.preference === 'string') pref = section.preference
        } catch { /* ignore */ }
        const boot = `<script>(()=>{const p=${JSON.stringify(pref)};const dark=p==='dark'||(p==='system'&&typeof matchMedia!=='undefined'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.style.colorScheme=dark?'dark':'light';document.documentElement.toggleAttribute('data-ds-dark-theme',dark)})()</script>`
        html = html.replace('</head>', boot + '</head>')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('launcher.html missing')
      }
    },
  })

  // 搜索 API
  ctx.webServer.register({
    kind: 'exact',
    path: '/file-launcher/api/search',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const q = (url.searchParams.get('q') || '').trim()
      const limit = Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20)

      if (q === '') {
        return json(res, 200, { ok: true, engine: 'everything', items: [] })
      }

      const results = await everythingSearch(q, limit * 3)
      const scored = results
        .map((r) => ({ ...r, score: scoreEntry(r, q, state) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => decorate(r, state, 'everything'))

      return json(res, 200, { ok: true, engine: 'everything', items: scored })
    },
  })

  // 打开（记录使用打分）
  ctx.webServer.register({
    kind: 'exact',
    path: '/file-launcher/api/open',
    handler: async (req, res) => {
      const body = await readBody(req)
      const fullPath = typeof body.path === 'string' ? body.path : ''
      if (!fullPath) return json(res, 400, { ok: false, message: 'path required' })
      recordUsage(fullPath)
      if (typeof body.query === 'string' && body.query.trim()) recordQuery(body.query.trim())
      const ok = await openPath(fullPath)
      return json(res, 200, { ok })
    },
  })

  // 在文件夹中显示
  ctx.webServer.register({
    kind: 'exact',
    path: '/file-launcher/api/reveal',
    handler: async (req, res) => {
      const body = await readBody(req)
      const fullPath = typeof body.path === 'string' ? body.path : ''
      if (!fullPath) return json(res, 400, { ok: false, message: 'path required' })
      const ok = await revealPath(fullPath)
      return json(res, 200, { ok })
    },
  })

  // 收藏 / 取消收藏
  ctx.webServer.register({
    kind: 'exact',
    path: '/file-launcher/api/favorite',
    handler: async (req, res) => {
      const body = await readBody(req)
      const fullPath = typeof body.path === 'string' ? body.path : ''
      if (!fullPath) return json(res, 400, { ok: false, message: 'path required' })
      const fav = body.favorite === true
      setFavorite(fullPath, fav)
      return json(res, 200, { ok: true, favorite: fav })
    },
  })

  // 状态（收藏 + 使用 + 查询历史，供 UI 初始化）
  ctx.webServer.register({
    kind: 'exact',
    path: '/file-launcher/api/state',
    handler: (req, res) => {
      const favorites = Object.keys(state.favorites)
      const usage = Object.entries(state.usage)
        .sort((a, b) => (b[1].lastOpenedAt || 0) - (a[1].lastOpenedAt || 0))
        .slice(0, 50)
        .map(([fullPath, u]) => ({ path: fullPath, count: u.count || 0, lastOpenedAt: u.lastOpenedAt || 0 }))
      const queries = Object.entries(state.queries)
        .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
        .slice(0, 50)
        .map(([q, r]) => ({ query: q, count: r.count || 0 }))
      return json(res, 200, { ok: true, favorites, usage, queries })
    },
  })

  // 启动时即探测并拉起独立 Everything 实例（后台索引，避免首次搜索卡顿）
  void ensureEverything()

  // 启动自检：探测专属实例可达性（非阻塞，结果写入 DSH 日志便于排障）
  setTimeout(() => {
    runEs(['-n', '1', 'zzzz_no_such_file_probe'], 4000).then((buf) => {
      console.log('[file-launcher] Everything ' + (buf !== null ? 'reachable OK' : 'NOT reachable'))
    })
  }, 3000)
}
