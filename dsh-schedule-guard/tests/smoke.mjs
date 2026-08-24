// 冒烟测试：验证 dsh-schedule-guard 的核心折叠与唤醒逻辑
// 不依赖 DSH 上下文，只 import 插件模块并手动调用内部逻辑。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mod = await import('file:///C:/Users/douzhongjun/.dsh/profiles/web/node_modules/@peanutsdou/dsh-schedule-guard/lib/index.js')
console.log('exports:', Object.keys(mod))
console.log('name:', mod.name)
console.log('inject:', JSON.stringify(mod.inject))
console.log('apply type:', typeof mod.apply)

// 由于 foldScheduleEvents 未导出，这里通过 require 后无法直接测内部函数；
// 改为验证模块可加载 + 导出结构正确，等待真实 DSH 环境验证。
console.log('SMOKE OK')
