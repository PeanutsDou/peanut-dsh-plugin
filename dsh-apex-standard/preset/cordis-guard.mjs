/**
 * cordis-guard — idempotent Host Cordis Inspect provider registration.
 *
 * WHY: `dsh-tool-cordis` registers its Inspect providers (Service / Event /
 * Builtin / Tool …) into the PROCESS-GLOBAL `cordisInspect` registry and
 * throws when a provider id already exists. Two presets that both mount the
 * toolset — the official `cordis` preset and this one — therefore collide in
 * one DSH process: whichever standing mount composes second fails entirely,
 * taking every session on that preset with it. The provider manifests are
 * identical and every query is resolved against the REQUESTING agent, so
 * sharing one global registration is the correct semantics; skipping a
 * duplicate is safe, and the tools keep working whichever preset registered
 * first.
 *
 * This row must sit BEFORE `tool-cordis`. It replaces the global registry's
 * `register` method for the lifetime of this preset's fiber so duplicate
 * provider ids become a no-op; every later caller — including the official
 * `cordis` preset's tool-cordis — then composes safely in either mount
 * order. The effect disposer restores the original method.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cordis-guard'

/** The inspect registry must exist before the patch can apply. */
export const inject = ['cordisInspect']

/** Make Host Inspect provider registration idempotent for this fiber's lifetime. */
export function apply(ctx) {
  const registry = ctx.cordisInspect
  const original = registry.register.bind(registry)
  const patched = (registration) => {
    const id = registration?.manifest?.id
    if (typeof id === 'string' && id.length > 0) {
      try {
        for (const provider of registry.list()) {
          if (provider.platform === 'host' && provider.id === id) return () => {}
        }
      } catch {
        // Registry listing unavailable — fall through to the real register.
      }
    }
    return original(registration)
  }
  registry.register = patched
  ctx.effect(() => () => {
    // Restore only if this patch is still the installed one (a later fiber
    // may have replaced it; never clobber someone else's method).
    if (registry.register === patched) registry.register = original
  }, 'cordis-guard: restore inspect register')
}
