import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-turn-ui'
export const inject = ['settings']

export interface TurnUiConfig {
  turnFoldEnabled: boolean
  turnRailEnabled: boolean
}

export const ConfigSchema: z<TurnUiConfig> = z.object({
  turnFoldEnabled: z.boolean().default(true),
  turnRailEnabled: z.boolean().default(true),
})

export const DEFAULT_CONFIG: TurnUiConfig = {
  turnFoldEnabled: true,
  turnRailEnabled: true,
}

export function apply(ctx: Context): void {
  try {
    installSettingsSection(ctx, settingsNamespace('dsh-turn-ui'), ConfigSchema, DEFAULT_CONFIG, {
      setSource: () => {},
      onChange: () => {},
    })
  } catch (error) {
    console.error('[dsh-turn-ui] settings section unavailable:', error)
  }
}
