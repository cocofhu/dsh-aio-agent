import z from '@deepseek-ai/schemastery'
import { BACKENDS, currentBackend, provideLaunch } from './backends.js'
import { registerCatalog } from './catalog.js'
import { providerId } from './models.js'

/**
 * Editable on the row's page under Plugins. The fields are volatile: the driver and
 * the model catalog read them on every CLI launch, so a save applies to the next
 * turn without reloading the row.
 */
export const Config = z.object({
  command: z.string().default('').description('Launch line of the ACP agent; blank uses the built-in command.').volatile(),
  model: z.string().default('').description('Model used when the session has not picked one; blank uses the CLI default.').volatile(),
  permission: z.union(['allow', 'deny']).default('allow').description('Answer to the CLI permission requests, recorded in the session log either way.').volatile(),
})

/**
 * One switchable Plugins-page row per external agent: it lists the CLI's models
 * in the native model picker and registers the agent preset whose driver runs
 * every turn of a session in that CLI over ACP. Switching the row off removes both.
 * @param backendId - key of BACKENDS.
 * @returns the plugin module members.
 */
export function agentPlugin(backendId) {
  const { label, description, order } = BACKENDS[backendId]
  return {
    name: `dsh-aio-agent-${backendId}`,
    inject: ['llm', 'agentPresets'],
    Config,
    apply(ctx, config) {
      ctx.effect(() => provideLaunch(backendId, () => ({
        command: config.command.get(),
        model: config.model.get(),
        permission: config.permission.get(),
      })), `dsh-aio-agent: ${label} launch settings`)
      registerCatalog(ctx, () => currentBackend(backendId))
      ctx.effect(async function* () {
        yield await ctx.agentPresets.register({
          id: providerId(backendId),
          name: label,
          description,
          order,
          plugins: [{ id: 'aio-driver', name: '@cocofhu/dsh-aio-agent/driver', config: { backend: backendId } }],
        })
      }, `dsh-aio-agent: ${label} preset`)
    },
  }
}
