import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acpErrorMessage } from '../lib/acp-client.js'

test('an ACP error keeps the cause the agent put in data.message', () => {
  const body = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.", code: 'model_not_found' } })
  assert.equal(acpErrorMessage({ code: -32603, message: 'Internal error', data: { message: body, codex_error_info: 'other' } }),
    "Internal error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.")
  assert.equal(acpErrorMessage({ code: -32603, message: 'Internal error', data: { message: 'rate limited' } }), 'Internal error: rate limited')
  assert.equal(acpErrorMessage({ code: -32000, message: 'Authentication required' }), 'Authentication required')
  assert.equal(acpErrorMessage({ message: 'same', data: { message: 'same' } }), 'same')
  assert.equal(acpErrorMessage({}), 'ACP error')
})
