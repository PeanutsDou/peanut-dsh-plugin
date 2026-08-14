/**
 * Wrap the CommonJS-compiled client entry into the DSH web boot handoff:
 * `window.__ModuleLoader__.load({ id, factory })`. The factory receives the
 * module-table `require` (resolving `react` and `react/jsx-runtime`) and returns
 * the plugin exports (`apply` / `inject`).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ID = '@deepseek-ai/dsh-schedule-ui'
const src = readFileSync('lib/client-tmp/index.js', 'utf8')
const body = src.split('\n').map((line) => `\t\t${line}`).join('\n')
const out = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(ID)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  body,
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')
writeFileSync('lib/client.js', out)
