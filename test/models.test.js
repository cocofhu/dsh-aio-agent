import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backendOfProvider, promptUsage, providerId, readModelState, setModel } from '../lib/models.js'

test('ACP prompt usage maps to DSH token usage (OpenCode shape)', () => {
  const result = { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 2, totalTokens: 7318, cachedReadTokens: 7296 } }
  assert.deepEqual(promptUsage(result), { inputTokens: 20, outputTokens: 2, totalTokens: 7318, cacheReadTokens: 7296 })
  assert.equal(promptUsage({ stopReason: 'end_turn' }), undefined)
})

test('reads the ACP models field (Cursor, Claude Code)', () => {
  const state = readModelState({
    models: { currentModelId: 'default', availableModels: [{ modelId: 'default', name: 'Default' }, { modelId: 'opus', name: 'Opus', description: 'Opus 4.6' }] },
  })
  assert.deepEqual(state, {
    models: [{ id: 'default', name: 'Default' }, { id: 'opus', name: 'Opus', description: 'Opus 4.6' }],
    current: 'default',
    control: { kind: 'set_model' },
  })
})

test('reads a model config option (OpenCode)', () => {
  const state = readModelState({
    configOptions: [
      { id: 'mode', category: 'mode', options: [{ value: 'build' }] },
      { id: 'model', category: 'model', currentValue: 'opencode/big-pickle', options: [{ value: 'opencode/big-pickle', name: 'Big Pickle' }] },
    ],
  })
  assert.deepEqual(state, { models: [{ id: 'opencode/big-pickle', name: 'Big Pickle' }], current: 'opencode/big-pickle', control: { kind: 'config', configId: 'model' } })
})

test('switches models with the method the agent advertised', async () => {
  const calls = []
  const client = { request: async (method, params) => calls.push([method, params]) }
  await setModel(client, 's1', { kind: 'set_model' }, 'opus')
  await setModel(client, 's1', { kind: 'config', configId: 'model' }, 'opencode/x')
  assert.deepEqual(calls, [
    ['session/set_model', { sessionId: 's1', modelId: 'opus' }],
    ['session/set_config_option', { sessionId: 's1', configId: 'model', value: 'opencode/x' }],
  ])
})

test('maps provider routes to backends', () => {
  assert.equal(providerId('claude-code'), 'aio-claude-code')
  assert.equal(backendOfProvider('aio-claude-code'), 'claude-code')
  assert.equal(backendOfProvider('deepseek'), undefined)
})

test('the model a turn runs without a pick is listed first', async () => {
  const { defaultFirst } = await import('../lib/catalog.js')
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(defaultFirst({ models, current: 'b' }).map((m) => m.id), ['b', 'a', 'c'])
  assert.deepEqual(defaultFirst({ models, current: 'b' }, 'c').map((m) => m.id), ['c', 'a', 'b'])
  assert.deepEqual(defaultFirst({ models, current: 'b' }, 'missing').map((m) => m.id), ['b', 'a', 'c'])
  assert.deepEqual(defaultFirst({ models }).map((m) => m.id), ['a', 'b', 'c'])
})
