/**
 * dsh-workspace-session Host entry.
 *
 * Keeps the native `$DSH_HOME/sessions` store as the runtime store, mirrors
 * sessions owned by a workspace into `<workspace>/.dsh/sessions` as text
 * snapshots for git sync, and imports those snapshots back into the native
 * store on this machine.
 *
 * @module @local/dsh-workspace-session
 */

import { ConfigStore } from './lib/config.js'
import { StateStore } from './lib/state.js'
import { Syncer } from './lib/sync.js'
import { registerApi } from './lib/api.js'
import { resolveDshHome } from './lib/util.js'

/** Cordis plugin name. */
export const name = 'dsh-workspace-session'

/**
 * Services required before activation. The workspace registry is required so
 * this plugin activates only in compositions that actually have workspaces.
 */
export const inject = ['sessionPersistence', 'workspaceRegistry']

/**
 * Host plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export async function apply(ctx) {
  const logger = ctx.logger
  const home = resolveDshHome()

  const configStore = new ConfigStore({ home, logger })
  await configStore.load()
  const state = new StateStore({ home, logger })
  await state.load()

  const syncer = new Syncer(ctx, { configStore, state, logger })
  await state.save()
  syncer.start()
  ctx.effect(() => () => {
    syncer.stop()
  }, 'dsh-workspace-session: timers')

  registerApi(ctx, { syncer, configStore })

  try {
    logger?.info?.(
      `dsh-workspace-session: ready (machine ${state.machineId}, `
      + `autoExport=${configStore.value.autoExport}, autoImport=${configStore.value.autoImportOnStart})`,
    )
  } catch {
    // Logging is best-effort.
  }
}
