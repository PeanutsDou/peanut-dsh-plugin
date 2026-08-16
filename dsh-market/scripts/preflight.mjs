#!/usr/bin/env node
/**
 * Pre-pack guard: every place that must carry the npm package name actually
 * does. Both 1.0.0 (bundle patch name) and 1.0.1 (client loader id) shipped
 * broken after the dsh-market → dshmarket rename because these are plain
 * strings no compiler checks.
 */
import fs from 'node:fs'

const name = JSON.parse(fs.readFileSync('package.json', 'utf8')).name

const failures = []

const patch = fs.readFileSync('cordis.patch.yml', 'utf8')
if (!patch.includes(`name: '${name}'`)) {
  failures.push(`cordis.patch.yml must insert by package name '${name}'`)
}

const client = fs.readFileSync('client/client.js', 'utf8')
if (!client.startsWith(`window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}`)) {
  failures.push(`client/client.js must register __ModuleLoader__ id ${JSON.stringify(name)}`)
}

if (failures.length > 0) {
  console.error('preflight failed:\n- ' + failures.join('\n- '))
  process.exit(1)
}
console.log(`preflight ok: ${name}`)
