import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ClaudeStream } from '../lib/claude-stream.js'

const transcript = readFileSync(new URL('./fixtures/codebuddy-stream-json.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

function replay(events, options) {
  const updates = []
  const stream = new ClaudeStream((update) => updates.push(update), options)
  for (const event of events) stream.push(event)
  return { stream, updates }
}

const ofType = (updates, type) => updates.filter((u) => u.sessionUpdate === type)

test('partial messages stream reply text and reasoning once despite the whole-message repeats', () => {
  const { updates } = replay(transcript)
  assert.equal(ofType(updates, 'agent_message_chunk').map((u) => u.content.text).join(''), transcript.at(-1).result)
  const thinking = transcript.filter((e) => e.event?.delta?.type === 'thinking_delta').map((e) => e.event.delta.thinking).join('')
  assert.equal(ofType(updates, 'agent_thought_chunk').map((u) => u.content.text).join(''), thinking)
})

test('each tool runs once, in order, even when blocks share an index without a stop', () => {
  const { updates } = replay(transcript)
  const calls = ofType(updates, 'tool_call')
  assert.deepEqual(calls.map((c) => [c.kind, c.title]), [
    ['execute', 'echo hi'],
    ['read', 'Read /tmp/sjtest/notes.txt'],
    ['edit', 'Write /tmp/sjtest/out.txt'],
    ['edit', 'Edit /tmp/sjtest/out.txt'],
  ])
  assert.deepEqual(calls[0].rawInput, { command: 'echo hi', description: 'Echo hi' })
  assert.deepEqual(calls[3].rawInput, { file_path: '/tmp/sjtest/out.txt', old_string: 'x', new_string: 'y' })
  assert.deepEqual(calls[3].locations, [{ path: '/tmp/sjtest/out.txt' }])
})

test('tool results complete their calls; shell output splits into streams and exit code', () => {
  const { updates } = replay(transcript)
  const results = ofType(updates, 'tool_call_update').filter((u) => u.status)
  assert.equal(results.length, 4)
  assert.deepEqual(results[0], { sessionUpdate: 'tool_call_update', toolCallId: 'call_00_Dqx5SXyccFbPar83OjFb8320', status: 'completed', rawOutput: { stdout: 'hi', stderr: '', exitCode: 0 } })
  assert.match(results[1].content[0].content.text, /hello fixture/)
})

test('a failed tool fails its call', () => {
  const { updates } = replay([
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'no such dir' }] } },
  ])
  assert.deepEqual(updates.at(-1), { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'no such dir' } }] })
  assert.equal(updates[0].kind, 'search')
})

test('subagent lines stay out of the turn', () => {
  const { updates } = replay([{ type: 'assistant', parent_tool_use_id: 't1', message: { id: 'm2', content: [{ type: 'text', text: 'inner' }] } }])
  assert.deepEqual(updates, [])
})

test('the result reports the session id and usage without counting cache reads as fresh input', () => {
  const { stream } = replay(transcript, { inputIncludesCache: true })
  assert.equal(stream.sessionId, '01a1933f-9701-7238-aa1f-282f98bb6c24')
  assert.deepEqual(stream.usage(), { inputTokens: 209, outputTokens: 267, cacheReadTokens: 92416, cacheWriteTokens: 0 })
  assert.equal(stream.failure(), undefined)
  assert.equal(stream.recordable(transcript[1]), false)
  assert.equal(stream.recordable(transcript.at(-1)), true)
})

test('an error result names its errors', () => {
  const { stream } = replay([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Authentication required. Please use /login'] }])
  assert.equal(stream.failure(), 'Authentication required. Please use /login')
})
