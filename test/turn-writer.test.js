import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnWriter } from '../lib/turn-writer.js'

function fakeSession() {
  const events = []
  return {
    events,
    append(type, data, options) {
      events.push({ type, data, options })
      return { seq: events.length }
    },
  }
}

function runTool(tool) {
  const session = fakeSession()
  const writer = new TurnWriter({ session, turn: 1, provider: 'aio-test', model: 'default', cwd: '/work' })
  writer.update({ sessionUpdate: 'tool_call', toolCallId: 't1', status: 'pending', ...tool })
  writer.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', ...tool })
  writer.finish()
  const call = session.events.find((e) => e.type === 'tool/call').data
  const result = session.events.find((e) => e.type === 'tool/result').data
  return { session, call, args: JSON.parse(call.arguments), result }
}

test('admits the claimed messages unchanged and leaves turn bookkeeping to the loop', () => {
  const session = fakeSession()
  const writer = new TurnWriter({ session, turn: 3, provider: 'aio-test', model: 'default' })
  const message = Object.freeze({ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', rpcId: 'r1' } })
  writer.admit([message])
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })
  writer.finish()
  assert.equal(session.events[0].data, message)
  assert.deepEqual(session.events.map((e) => e.type), ['user/message', 'step/start', 'assistant/message', 'step/end'])
  assert.equal(session.events[1].data.turn, 3)
})

test('execute maps to the native bash call with an exit-code marker', () => {
  const { call, args, result } = runTool({ kind: 'execute', title: 'List files', rawInput: { command: 'ls' }, rawOutput: { exitCode: 2, stdout: 'a.txt\n', stderr: '' } })
  assert.equal(call.name, 'bash')
  assert.deepEqual(args, { command: 'ls', description: 'List files' })
  assert.equal(result.message.content[0].text, 'a.txt\n\n[exit code: 2]')
  assert.equal(result.meta.cwd, '/work')
})

test('a Cursor new-file diff maps to write without leaked diff headers', () => {
  const { call, args, result } = runTool({
    kind: 'edit',
    title: 'Edit note.md',
    content: [{ type: 'diff', path: '/work/note.md', oldText: '-- /dev/null', newText: '++ b//work/note.md\nnative ui' }],
  })
  assert.equal(call.name, 'write')
  assert.deepEqual(args, { file_path: '/work/note.md', content: 'native ui' })
  assert.deepEqual(result.meta.diffs, [{ path: '/work/note.md', oldText: null, newText: 'native ui' }])
  assert.equal(result.meta.path, '/work/note.md')
})

test('an ordinary diff maps to edit and keeps text that merely looks like a header', () => {
  const { call, args } = runTool({
    kind: 'edit',
    title: 'Edit q.sql',
    content: [{ type: 'diff', path: '/work/q.sql', oldText: '-- note\nselect 1', newText: '++ counter\nselect 2' }],
  })
  assert.equal(call.name, 'edit')
  assert.deepEqual(args, { file_path: '/work/q.sql', old_string: '-- note\nselect 1', new_string: '++ counter\nselect 2' })
})

test('edits without ACP diff content fall back to rawInput (OpenCode and Claude Code shapes)', () => {
  const write = runTool({ kind: 'edit', title: 'write', locations: [{ path: '/work/oc.txt' }], rawInput: { filePath: '/work/oc.txt', content: 'opencode' } })
  assert.equal(write.call.name, 'write')
  assert.deepEqual(write.args, { file_path: '/work/oc.txt', content: 'opencode' })
  const edit = runTool({ kind: 'edit', title: 'Edit', rawInput: { file_path: '/work/a.js', old_string: 'a', new_string: 'b' } })
  assert.equal(edit.call.name, 'edit')
  assert.deepEqual(edit.args, { file_path: '/work/a.js', old_string: 'a', new_string: 'b' })
  assert.deepEqual(edit.result.meta.diffs, [{ path: '/work/a.js', oldText: 'a', newText: 'b' }])
})

test('a skill tool maps to the native skill card', () => {
  const { call, args } = runTool({ kind: 'skill', title: 'Skill', rawInput: { skill: 'review' } })
  assert.equal(call.name, 'skill')
  assert.deepEqual(args, { name: 'review' })
  const slash = runTool({ kind: 'skill', title: 'SlashCommand', rawInput: { command: '/ship' } })
  assert.equal(slash.call.name, 'skill')
  assert.equal(slash.args.name, 'ship')
})

test('kinds without a native tool keep an aio_ name', () => {
  const { call, args } = runTool({ kind: 'search', title: 'Search TODO', rawInput: { pattern: 'TODO' } })
  assert.equal(call.name, 'aio_search')
  assert.equal(args.description, 'Search TODO')
  assert.equal(args.pattern, 'TODO')
})

function liveWriter(session = fakeSession()) {
  const frames = []
  let revision = 0
  let attempt = 0
  const writer = new TurnWriter({
    session,
    turn: 1,
    provider: 'aio-test',
    model: 'default',
    live: { emit: (frame) => frames.push({ frame, events: session.events.length }), nextRevision: () => ++revision, nextAttemptId: () => `s:aio-${++attempt}` },
  })
  return { session, writer, frames }
}

test('text streams live before the step commits, and the end frame names the commit', () => {
  const { session, writer, frames } = liveWriter()
  writer.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } })
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } })
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
  assert.deepEqual(session.events.map((e) => e.type), ['step/start'])
  assert.deepEqual(frames.map((f) => f.frame.chunk?.type ?? f.frame.type), ['start', 'block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'text-delta'])
  writer.finish()
  const kinds = frames.map((f) => f.frame.type)
  assert.equal(kinds.at(-1), 'end')
  const end = frames.at(-1).frame
  const message = session.events.find((e) => e.type === 'assistant/message')
  assert.deepEqual(end.outcome, { kind: 'committed', eventType: 'assistant/message', seq: session.events.indexOf(message) + 1 })
  assert.equal(end.index, frames.filter((f) => f.frame.type === 'chunk').length)
  assert.deepEqual(frames.map((f) => f.frame.revision), frames.map((_, i) => i + 1))
  assert.deepEqual(frames.filter((f) => f.frame.type === 'chunk').map((f) => f.frame.index), [...Array(end.index).keys()])
  assert.deepEqual(message.data.message.content, [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'Hello' }])
  assert.equal(message.data.stream.find((r) => r.type === 'text-chunks').texts.join(''), 'Hello')
})

test('a step after a running tool buffers until the tool settles, then streams in order', () => {
  const { session, writer, frames } = liveWriter()
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running ls.' } })
  writer.update({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } })
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })
  assert.equal(frames.filter((f) => f.frame.type === 'start').length, 1)
  assert.ok(!frames.some((f) => f.frame.chunk?.text === 'Done.'))
  writer.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { exitCode: 0, stdout: 'a\n' } })
  const starts = frames.filter((f) => f.frame.type === 'start').map((f) => f.frame)
  assert.deepEqual(starts.map((s) => [s.attemptId, s.step]), [['s:aio-1', 1], ['s:aio-2', 2]])
  const firstEnd = frames.findIndex((f) => f.frame.type === 'end')
  assert.ok(firstEnd < frames.findIndex((f) => f.frame.type === 'start' && f.frame.step === 2))
  assert.ok(frames.some((f) => f.frame.attemptId === 's:aio-2' && f.frame.chunk?.text === 'Done.'))
  const toolChunk = frames.find((f) => f.frame.chunk?.type === 'tool-call-delta').frame.chunk
  assert.equal(toolChunk.name, 'bash')
  writer.finish()
  assert.deepEqual(session.events.map((e) => e.type), ['step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'step/start', 'assistant/message', 'step/end'])
})

test('running tool calls commit while they run, together when one message carries them', async () => {
  const { session, writer, frames } = liveWriter()
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking.' } })
  writer.update({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput: { command: 'ls' }, status: 'in_progress' })
  writer.update({ sessionUpdate: 'tool_call', toolCallId: 't2', kind: 'execute', rawInput: { command: 'pwd' }, status: 'in_progress' })
  assert.deepEqual(session.events.map((e) => e.type), ['step/start'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(session.events.map((e) => e.type), ['step/start', 'assistant/message', 'tool/call', 'tool/call'])
  assert.equal(frames.filter((f) => f.frame.type === 'end').length, 1)
  writer.update({ sessionUpdate: 'tool_call', toolCallId: 't3', kind: 'execute', rawInput: { command: 'id' }, status: 'in_progress' })
  writer.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { exitCode: 0, stdout: 'a' } })
  writer.update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed', rawOutput: { exitCode: 0, stdout: '/' } })
  assert.deepEqual(session.events.slice(4).map((e) => e.type), ['tool/result', 'tool/result', 'step/end', 'step/start'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session.events.at(-1).type, 'tool/call')
  writer.update({ sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'completed', rawOutput: { exitCode: 0, stdout: 'root' } })
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })
  writer.finish()
  assert.deepEqual(session.events.slice(8).map((e) => e.type), ['assistant/message', 'tool/call', 'tool/result', 'step/end', 'step/start', 'assistant/message', 'step/end'])
})

test('a failed commit abandons the live attempt and still closes the step', () => {
  const session = fakeSession()
  const append = session.append
  session.append = (type, ...rest) => {
    if (type === 'assistant/message') throw new Error('disk full')
    return append(type, ...rest)
  }
  const { writer, frames } = liveWriter(session)
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
  assert.throws(() => writer.finish(), /disk full/)
  assert.deepEqual(frames.at(-1).frame.outcome, { kind: 'abandoned' })
  assert.deepEqual(session.events.map((e) => e.type), ['step/start', 'step/end'])
})

function pacedWriter() {
  const session = fakeSession()
  const frames = []
  const live = { emit: (frame) => frames.push(frame), nextRevision: () => frames.length + 1, nextAttemptId: () => 'a-1' }
  const writer = new TurnWriter({ session, turn: 1, provider: 'aio-test', model: 'default', pace: true, live })
  const deltas = () => frames.filter((f) => f.chunk?.type === 'text-delta').map((f) => f.chunk.text)
  return { session, writer, frames, deltas }
}

test('paced text arriving as one whole message streams out over several ticks', async () => {
  const { session, writer, deltas } = pacedWriter()
  const text = '长江是中国第一长河，'.repeat(12)
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  assert.equal(deltas().length, 1)
  assert.ok(deltas()[0].length < text.length / 5)
  await writer.drain()
  assert.ok(deltas().length > 10)
  assert.equal(deltas().join(''), text)
  writer.finish()
  assert.equal(session.events.find((e) => e.type === 'assistant/message').data.message.content[0].text, text)
})

test('updates queued behind paced text keep their order', async () => {
  const { session, writer } = pacedWriter()
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before the tool runs' } })
  writer.update({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput: { command: 'ls' }, status: 'in_progress' })
  writer.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { stdout: 'a', exitCode: 0 } })
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } })
  assert.equal(session.events.filter((e) => e.type === 'tool/call').length, 0)
  await writer.drain()
  writer.finish()
  const messages = session.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content.map((b) => b.text ?? b.name))
  assert.deepEqual(messages, [['before the tool runs', 'bash'], ['after']])
})

test('finishing without draining releases paced text at once, whole code points intact', () => {
  const { session, writer, deltas } = pacedWriter()
  const text = '😀'.repeat(40)
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  writer.finish()
  assert.equal(deltas().join(''), text)
  assert.ok(deltas().every((d) => !/[\uD800-\uDBFF]$/.test(d)))
  assert.equal(session.events.find((e) => e.type === 'assistant/message').data.message.content[0].text, text)
})
