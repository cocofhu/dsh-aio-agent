import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { OpenCodeStream } from '../lib/opencode-stream.js'

const transcript = readFileSync(new URL('./fixtures/opencode-run-json.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

function replay(events) {
  const updates = []
  const stream = new OpenCodeStream((update) => updates.push(update))
  for (const event of events) stream.push(event)
  return { stream, updates }
}

const ofType = (updates, type) => updates.filter((u) => u.sessionUpdate === type)

test('a run streams its reasoning, reply and tools', () => {
  const { stream, updates } = replay(transcript)
  assert.equal(stream.sessionId, 'ses_e6bf5a38fffeEUeOX2hI9b15wI')
  const reply = transcript.filter((e) => e.type === 'text').map((e) => e.part.text).join('')
  assert.equal(ofType(updates, 'agent_message_chunk').map((u) => u.content.text).join(''), reply)
  assert.ok(ofType(updates, 'agent_thought_chunk').length > 0)
  const calls = ofType(updates, 'tool_call')
  assert.deepEqual(calls.map((c) => c.kind), ['read', 'edit', 'execute'])
  assert.equal(calls[2].title, 'cat out.txt')
  assert.deepEqual(calls[1].locations, [{ path: '/tmp/ocf/out.txt' }])
  const results = ofType(updates, 'tool_call_update')
  assert.deepEqual(results.map((r) => r.status), ['completed', 'completed', 'completed'])
  assert.equal(results[2].rawOutput.stdout.trim(), 'done')
  assert.equal(results[2].rawOutput.exitCode, 0)
  assert.equal(stream.failure(), undefined)
  assert.ok(stream.result)
})

test('usage sums every step of the run', () => {
  const { stream } = replay(transcript)
  const steps = transcript.filter((e) => e.type === 'step_finish').map((e) => e.part.tokens)
  const sum = (pick) => steps.reduce((total, t) => total + pick(t), 0)
  assert.deepEqual(stream.usage(), {
    inputTokens: sum((t) => t.input),
    outputTokens: sum((t) => t.output),
    cacheReadTokens: sum((t) => t.cache.read),
    cacheWriteTokens: sum((t) => t.cache.write),
    reasoningTokens: sum((t) => t.reasoning),
  })
})

test('a failed tool and a run error are reported', () => {
  const { stream, updates } = replay([
    { type: 'tool_use', sessionID: 's', part: { tool: 'read', callID: 'c-1', state: { status: 'running', input: { filePath: '/x' } } } },
    { type: 'tool_use', sessionID: 's', part: { tool: 'read', callID: 'c-1', state: { status: 'error', input: { filePath: '/x' }, error: 'no such file' } } },
    { type: 'step_finish', sessionID: 's', part: { reason: 'tool-calls', tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } } },
    { type: 'error', sessionID: 's', error: { name: 'ProviderAuthError', data: { message: 'invalid api key' } } },
  ])
  assert.equal(ofType(updates, 'tool_call').length, 1)
  const [result] = ofType(updates, 'tool_call_update')
  assert.equal(result.status, 'failed')
  assert.equal(result.content[0].content.text, 'no such file')
  assert.equal(stream.result, undefined)
  assert.equal(stream.failure(), 'invalid api key')
})
