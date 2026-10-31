/** DSH provider route that lists one backend's models in the native model picker. */
export const providerId = (backendId) => `aio-${backendId}`

/** Backend id of an aio provider route, or undefined for any other provider. */
export const backendOfProvider = (provider) => (typeof provider === 'string' && provider.startsWith('aio-') ? provider.slice(4) : undefined)

/**
 * Read the model list and the way to switch models from an ACP `session/new` or
 * `session/load` result. Agents report either the `models` field (switched with
 * `session/set_model`) or a `configOptions` entry of category `model` (switched
 * with `session/set_config_option`).
 * @returns {{ models: { id: string, name: string, description?: string }[], current?: string, control?: { kind: 'set_model' } | { kind: 'config', configId: string } }}
 */
export function readModelState(result) {
  if (Array.isArray(result?.models?.availableModels)) {
    return {
      models: result.models.availableModels.map((m) => ({ id: m.modelId, name: m.name ?? m.modelId, ...(m.description ? { description: m.description } : {}) })),
      current: result.models.currentModelId,
      control: { kind: 'set_model' },
    }
  }
  const option = result?.configOptions?.find((o) => o.category === 'model' && Array.isArray(o.options))
  if (option) {
    return {
      models: option.options.map((o) => ({ id: o.value, name: o.name ?? o.value, ...(o.description ? { description: o.description } : {}) })),
      current: option.currentValue,
      control: { kind: 'config', configId: option.id },
    }
  }
  return { models: [] }
}

/** Switch the model of one ACP session. */
export function setModel(client, sessionId, control, modelId) {
  if (control?.kind === 'config') return client.request('session/set_config_option', { sessionId, configId: control.configId, value: modelId })
  return client.request('session/set_model', { sessionId, modelId })
}
