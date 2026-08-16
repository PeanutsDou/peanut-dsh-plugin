/**
 * #58: the market's boot shim for client-only packages (dsh.client without
 * dsh.bundle) must NOT re-mount packages the USER's patch layer
 * (cordis.patch.yml) already manages — e.g. a plugin disabled through
 * dsh-web-plugin-manager. The shim subtree is independent of the patch
 * layer, so re-mounting overrides the user's "disabled" choice on every
 * restart. Reported with a verified fix by @vikna919.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hotUnmount, listHotMounts, mountClientOnlyDeps } from '../src/hot.ts'

// The harness-vendored Include class is not importable in the unit lane;
// a minimal stand-in lets hotMount succeed so the skip logic is observable.
vi.mock('@deepseek-ai/cordis-plugin-include', () => ({
  Include: class {
    write(): void {}
    import(name: string): unknown { return { name, apply: () => {} } }
  },
}))

const ctx = { plugin: () => ({ await: () => Promise.resolve(), dispose: () => {} }) }

function clientOnlyPkg(dir: string, name: string): void {
  mkdirSync(join(dir, 'node_modules', name), { recursive: true })
  writeFileSync(join(dir, 'node_modules', name, 'package.json'),
    JSON.stringify({ name, dsh: { client: './client.js' } }))
}

afterEach(async () => {
  for (const name of listHotMounts()) await hotUnmount(name)
})

describe('mountClientOnlyDeps vs the user patch layer (#58)', () => {
  it('skips packages cordis.patch.yml already manages; still shims unmanaged ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        dependencies: {
          '@deepseek-ai/dsh-client-ui-aqua': '^1.0.0',
          'dsh-free-plugin': '^1.0.0',
        },
      }))
      clientOnlyPkg(dir, '@deepseek-ai/dsh-client-ui-aqua')
      clientOnlyPkg(dir, 'dsh-free-plugin')
      // A plugin-manager disable row (id follows its slugify convention:
      // strip @, non-alphanumerics → '-', lowercase). The user turned the
      // plugin OFF — the market must leave it to the patch layer.
      writeFileSync(join(dir, 'cordis.patch.yml'),
        '- id: deepseek-ai-dsh-client-ui-aqua\n  disabled: true\n')

      const mounted = await mountClientOnlyDeps(ctx, dir)
      expect(mounted).toContain('dsh-free-plugin')
      expect(mounted).not.toContain('@deepseek-ai/dsh-client-ui-aqua')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
