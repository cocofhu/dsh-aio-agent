import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CodexStream, codexAuthRejected } from '../lib/codex-stream.js'

const transcript = readFileSync(new URL('./fixtures/codex-exec-json.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

function replay(events) {
  const updates = []
  const stream = new CodexStream((update) => updates.push(update))
  for (const event of events) stream.push(event)
  return { stream, updates }
}

const ofType = (updates, type) => updates.filter((u) => u.sessionUpdate === type)

test('a thread turn streams its reply, tools and usage', () => {
  const { stream, updates } = replay(transcript)
  assert.equal(stream.sessionId, '01a1940a-5215-7842-bf1b-463f7060307a')
  assert.equal(ofType(updates, 'agent_message_chunk').map((u) => u.content.text).join(''), 'finished')
  const calls = ofType(updates, 'tool_call')
  assert.deepEqual(calls.map((c) => [c.kind, c.title]), [
    ['execute', "/bin/bash -lc 'cat notes.txt'"],
    ['edit', '/tmp/cxf/out.txt'],
  ])
  assert.deepEqual(calls[1].locations, [{ path: '/tmp/cxf/out.txt' }])
  const results = ofType(updates, 'tool_call_update')
  assert.deepEqual(results[0].rawOutput, { stdout: 'hello\n', stderr: '', exitCode: 0 })
  assert.equal(results[1].status, 'completed')
  assert.equal(results[1].content[0].content.text, '/tmp/cxf/out.txt')
  assert.equal(stream.failure(), undefined)
  assert.deepEqual(stream.usage(), { inputTokens: 43155 - 36352, outputTokens: 114, cacheReadTokens: 36352, cacheWriteTokens: 0, reasoningTokens: 25 })
})

test('a failed turn reports its error, not the fallback-metadata warning', () => {
  const { stream, updates } = replay([
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `gpt-5.5` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } },
    { type: 'turn.started' },
    { type: 'error', message: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." },
    { type: 'turn.failed', error: { message: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." } },
  ])
  assert.equal(stream.failure(), "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.")
  assert.equal(ofType(updates, 'agent_message_chunk').length, 0)
})

test('an error the turn recovered from does not fail it', () => {
  const { stream } = replay([
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `x` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } },
    { type: 'error', message: 'Reconnecting... 1/5' },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'ok' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } },
  ])
  assert.equal(stream.failure(), undefined)
})

test('a rejected ChatGPT login says how to sign in again', () => {
  const { stream } = replay([{ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: https://api.openai.com/v1/responses' } }])
  assert.match(stream.failure(), /run `codex login`/)
  assert.ok(codexAuthRejected('Failed to refresh token'))
  assert.ok(!codexAuthRejected('401 Unauthorized from my proxy'))
})

test('the legacy envelope still streams text, tools and usage', () => {
  const { stream, updates } = replay([
    { msg: { type: 'session_configured', session_id: 's-1' } },
    { msg: { type: 'agent_reasoning', text: 'think' } },
    { msg: { type: 'exec_command_begin', call_id: 'c-1', command: 'ls' } },
    { msg: { type: 'exec_command_end', call_id: 'c-1', output: 'a\n' } },
    { msg: { type: 'agent_message', message: 'done' } },
    { msg: { type: 'token_count', info: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 2 } } },
    { msg: { type: 'task_complete' } },
  ])
  assert.equal(stream.sessionId, 's-1')
  assert.deepEqual(updates.map((u) => u.sessionUpdate), ['agent_thought_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk'])
  assert.deepEqual(stream.usage(), { inputTokens: 5, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 })
  assert.equal(stream.failure(), undefined)
})
