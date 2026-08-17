/** Shared preference vocabulary for dsh-selection-tutor. */

export const TUTOR_PREFS_NS = 'dsh-selection-tutor'
export type TutorEffort = 'off' | 'low' | 'high' | 'max'
export const TUTOR_EFFORTS: readonly TutorEffort[] = ['off', 'low', 'high', 'max'] as const

export interface TutorPrefs {
  /** Default reasoning effort used by every newly created tutor window. */
  defaultReasoningEffort: TutorEffort
}

export const TUTOR_PREFS_DEFAULTS: TutorPrefs = {
  defaultReasoningEffort: 'off',
}
