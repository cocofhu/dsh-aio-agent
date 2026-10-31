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

/**
 * Read the reasoning-effort selector of an ACP `session/new`, `session/load` or
 * `session/set_config_option` result: a select `configOptions` entry of category
 * `thought_level`, switched with `session/set_config_option`.
 * @returns {{ configId: string, efforts: { id: string, name: string }[], current?: string } | undefined}
 */
export function readEffortState(result) {
  const option = result?.configOptions?.find((o) => o.category === 'thought_level' && o.id)
  if (!option) return
  const values = [...(option.options ?? []), ...(option.groups ?? []).flatMap((g) => g.options ?? [])]
  const efforts = values.filter((v) => typeof v?.value === 'string').map((v) => ({ id: v.value, name: v.name ?? v.value }))
  if (efforts.length === 0) return
  return { configId: option.id, efforts, current: option.currentValue }
}

/**
 * Token usage of an ACP `session/prompt` result in DSH's shape. ACP counts input
 * without cache reads, as DSH does.
 * @returns the usage, or undefined when the agent reported none.
 */
export function promptUsage(result) {
  const u = result?.usage
  if (!u || typeof u !== 'object') return
  const n = (v) => (Number.isFinite(v) ? v : undefined)
  const usage = {
    inputTokens: n(u.inputTokens) ?? 0,
    outputTokens: n(u.outputTokens) ?? 0,
    ...(n(u.totalTokens) !== undefined && { totalTokens: u.totalTokens }),
    ...(n(u.cachedReadTokens) !== undefined && { cacheReadTokens: u.cachedReadTokens }),
    ...(n(u.cachedWriteTokens) !== undefined && { cacheWriteTokens: u.cachedWriteTokens }),
    ...(n(u.thoughtTokens) !== undefined && { reasoningTokens: u.thoughtTokens }),
  }
  return usage
}

/** Switch the model of one ACP session. */
export function setModel(client, sessionId, control, modelId) {
  if (control?.kind === 'config') return client.request('session/set_config_option', { sessionId, configId: control.configId, value: modelId })
  return client.request('session/set_model', { sessionId, modelId })
}
