import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CursorStream, toolUpdate } from '../lib/cursor-stream.js'
import { TurnWriter } from '../lib/turn-writer.js'

const transcript = readFileSync(new URL('./fixtures/cursor-stream-json.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

function replay(events) {
  const updates = []
  const stream = new CursorStream((update) => updates.push(update))
  for (const event of events) stream.push(event)
  return { stream, updates }
}

test('partial output streams each text once despite the whole-message repeats', () => {
  const { updates } = replay(transcript)
  const text = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('')
  assert.equal(text, transcript.at(-1).result)
})

test('a message that arrives only whole still streams', () => {
  const { updates } = replay([{ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } }])
  assert.deepEqual(updates, [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi!' } }])
})

test('thinking deltas become reasoning', () => {
  const { updates } = replay([{ type: 'thinking', subtype: 'delta', text: 'hmm' }, { type: 'thinking', subtype: 'completed' }])
  assert.deepEqual(updates, [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }])
})

test('the result reports the chat id and token usage', () => {
  const { stream } = replay(transcript)
  assert.equal(stream.sessionId, '4661edc9-67de-4973-810f-4c55d05b3216')
  assert.deepEqual(stream.usage(), { inputTokens: 12091, outputTokens: 239, cacheReadTokens: 48640, cacheWriteTokens: 0 })
})

test('shell, read and edit calls map to the shapes of native tool cards', () => {
  const { updates } = replay(transcript)
  const done = updates.filter((u) => u.sessionUpdate === 'tool_call_update')
  assert.deepEqual(done.map((u) => u.kind), ['execute', 'read', 'edit', 'read', 'edit'])
  const [shell, read, created, , edited] = done
  assert.equal(shell.title, 'echo hi')
  assert.deepEqual(shell.rawInput, { command: 'echo hi', workingDirectory: '/tmp/sjtest', timeout: 30000 })
  assert.deepEqual(shell.rawOutput, { stdout: 'hi\n', stderr: '', exitCode: 0 })
  assert.deepEqual(read.rawOutput, { content: 'hello fixture\n' })
  assert.deepEqual(created.content, [{ type: 'diff', path: '/tmp/sjtest/out.txt', oldText: null, newText: 'x\n' }])
  assert.deepEqual(edited.content, [{ type: 'diff', path: '/tmp/sjtest/out.txt', oldText: 'x\n', newText: 'y\n' }])
})

test('a failed shell call, an MCP call and a rejection keep their outcome', () => {
  const failed = toolUpdate({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls /x' }, result: { failure: { stdout: '', stderr: 'nope\n', exitCode: 2 } } } } })
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.rawOutput, { stdout: '', stderr: 'nope\n', exitCode: 2 })
  const mcp = toolUpdate({ type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: { mcpToolCall: { args: { toolName: 'echo', args: { message: 'ping' } }, result: { success: { content: [{ text: { text: 'Echo: ping' } }] } } } } })
  assert.deepEqual([mcp.kind, mcp.title, mcp.rawInput, mcp.content[0].content.text], ['other', 'echo', { message: 'ping' }, 'Echo: ping'])
  const rejected = toolUpdate({ type: 'tool_call', subtype: 'completed', call_id: 'c3', tool_call: { deleteToolCall: { args: { path: '/a' }, result: 'rejected' } } })
  assert.equal(rejected.status, 'failed')
})

test('the turn usage is recorded on its last assistant message, as a model attempt records it', () => {
  const events = []
  const session = { append: (type, data) => (events.push({ type, data }), { seq: events.length }) }
  const writer = new TurnWriter({ session, turn: 1, provider: 'aio-cursor', model: 'auto' })
  const { stream } = replay(transcript)
  for (const update of replay(transcript).updates) writer.update(update)
  writer.usage = stream.usage()
  writer.finish()
  const messages = events.filter((e) => e.type === 'assistant/message').map((e) => e.data)
  assert.ok(messages.length > 1)
  assert.deepEqual(messages.at(-1).usage, stream.usage())
  assert.deepEqual(messages.at(-1).stream.at(-2).chunk, { type: 'usage', usage: stream.usage() })
  assert.ok(messages.slice(0, -1).every((m) => m.usage === undefined))
  assert.equal(events.filter((e) => e.type === 'tool/result').length, 5)
})
