/** Shared preference vocabulary for dsh-selection-tutor. */

export const TUTOR_PREFS_NS = 'dsh-selection-tutor'
export type TutorEffort = 'off' | 'high' | 'max'
export const TUTOR_EFFORTS: readonly TutorEffort[] = ['off', 'high', 'max'] as const

/** Previously accepted effort value; kept schema-valid so old settings documents do not refuse to load. */
export type LegacyTutorEffort = 'low'
export const TUTOR_LEGACY_EFFORTS: readonly LegacyTutorEffort[] = ['low'] as const

export type TutorTranslateTarget = 'auto' | 'en' | 'zh' | 'ja' | 'ko' | 'fr' | 'de' | 'es'
export const TUTOR_TRANSLATE_TARGETS: readonly TutorTranslateTarget[] = ['auto', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es'] as const

export interface TutorPrefs {
  /** Default reasoning effort used by every newly created tutor window. */
  defaultReasoningEffort: TutorEffort
  /** Default target language for translation windows. `auto` keeps the legacy auto-detect behavior. */
  translateTarget: TutorTranslateTarget
}

export const TUTOR_PREFS_DEFAULTS: TutorPrefs = {
  defaultReasoningEffort: 'off',
  translateTarget: 'auto',
}

/**
 * Resolve a stored preference into the current three-level vocabulary.
 * @param value - raw stored value, possibly absent or a legacy effort.
 * @returns a current effort; legacy `low` maps to `high`, anything else falls back to the default.
 */
export function normalizeTutorEffort(value: unknown): TutorEffort {
  if (value === 'off' || value === 'high' || value === 'max') return value
  if (value === 'low') return 'high'
  return TUTOR_PREFS_DEFAULTS.defaultReasoningEffort
}

/** Whether a raw string is a current effort value. */
export function isTutorEffort(value: unknown): value is TutorEffort {
  return value === 'off' || value === 'high' || value === 'max'
}

/** Resolve a stored translate target into the supported vocabulary; anything unknown falls back to auto. */
export function normalizeTutorTranslateTarget(value: unknown): TutorTranslateTarget {
  return TUTOR_TRANSLATE_TARGETS.includes(value as TutorTranslateTarget) ? value as TutorTranslateTarget : TUTOR_PREFS_DEFAULTS.translateTarget
}
