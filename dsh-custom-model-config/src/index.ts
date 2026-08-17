/**
 * dsh-custom-model-config — host half (deliberately empty).
 *
 * This plugin only contributes a settings page from its client half. The host
 * module exists so the package resolves through the normal bundle patch path.
 */
export const name = 'dsh-custom-model-config'
export const inject: readonly string[] = []
export function apply(_ctx: unknown): void {}
