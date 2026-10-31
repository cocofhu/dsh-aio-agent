import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backendOfProvider, providerId, readModelState, setModel } from '../lib/models.js'

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
