// 冒烟测试：验证 dsh-file-launcher 的路由注册、HTML 服务、收藏/状态持久化。
// 使用临时 DSH_HOME 隔离状态，不触发 es.exe（沙箱内无法连接 Everything IPC）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-launcher-smoke-'))

const mod = await import('file:///C:/Users/DELL/.dsh/profiles/web/node_modules/@peanutsdou/dsh-file-launcher/index.js')

const routes = new Map()
const mockCtx = {
  webServer: {
    register(route) { routes.set(route.path, route); return () => {} },
  },
}

mod.apply(mockCtx)

let failures = 0
function check(label, cond, extra = '') {
  const ok = Boolean(cond)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}

const expected = [
  '/file-launcher',
  '/file-launcher/api/search',
  '/file-launcher/api/open',
  '/file-launcher/api/reveal',
  '/file-launcher/api/favorite',
  '/file-launcher/api/state',
]
check('注册了 6 条路由', routes.size === 6, `got ${routes.size}`)
for (const p of expected) check(`路由存在 ${p}`, routes.has(p))

function mockRes() {
  const r = { status: 0, headers: {}, body: '' }
  r.writeHead = (s, h) => { r.status = s; r.headers = h || {}; }
  r.end = (b) => { r.body = b || ''; }
  return r
}
function mockReq(method, url, body) {
  const listeners = {}
  const req = { method, url: url || '/', on: (ev, cb) => { listeners[ev] = cb; return req; } }
  setTimeout(() => {
    if (body !== undefined && listeners.data) listeners.data(JSON.stringify(body))
    if (listeners.end) listeners.end()
  }, 0)
  return req
}
const invoke = (path, req, res) => routes.get(path).handler(req, res)

// 1. HTML 页面
{
  const res = mockRes()
  await invoke('/file-launcher', mockReq('GET', '/file-launcher'), res)
  check('HTML 返回 200', res.status === 200)
  check('HTML 含搜索框标记', res.body.includes('文件搜索') || res.body.includes('搜索文件名'), '')
}

// 2. 初始状态
{
  const res = mockRes()
  await invoke('/file-launcher/api/state', mockReq('GET', '/file-launcher/api/state'), res)
  const data = JSON.parse(res.body)
  check('state 返回 ok', data.ok === true)
  check('state 初始收藏为空', Array.isArray(data.favorites) && data.favorites.length === 0)
}

// 3. 收藏 toggle
{
  const p = 'D:\\demo\\report.pdf'
  const res1 = mockRes()
  await invoke('/file-launcher/api/favorite', mockReq('POST', '/file-launcher/api/favorite', { path: p, favorite: true }), res1)
  const d1 = JSON.parse(res1.body)
  check('收藏添加成功', d1.ok === true && d1.favorite === true)

  const res2 = mockRes()
  await invoke('/file-launcher/api/state', mockReq('GET', '/file-launcher/api/state'), res2)
  const d2 = JSON.parse(res2.body)
  check('收藏已持久化到 state', Array.isArray(d2.favorites) && d2.favorites.includes(p))

  const res3 = mockRes()
  await invoke('/file-launcher/api/favorite', mockReq('POST', '/file-launcher/api/favorite', { path: p, favorite: false }), res3)
  const d3 = JSON.parse(res3.body)
  check('取消收藏成功', d3.ok === true && d3.favorite === false)
}

// 4. 空查询首页（不触发 es.exe）
{
  const res = mockRes()
  await invoke('/file-launcher/api/search', mockReq('GET', '/file-launcher/api/search?q='), res)
  const data = JSON.parse(res.body)
  check('空查询返回 ok', data.ok === true && Array.isArray(data.items))
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
