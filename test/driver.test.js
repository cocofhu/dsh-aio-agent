import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { provideLaunch } from '../lib/backends.js'
import { readBinding } from '../lib/sessions.js'
import { agentRuntime, userMessage, waitFor } from './helpers/agent-runtime.mjs'

const fixture = fileURLToPath(new URL('./fixtures/mock-agent.mjs', import.meta.url))
const dialects = { cursor: 'cursor', 'claude-code': 'claude', codex: 'codex', opencode: 'open-code', codebuddy: 'claude', 'kimi-code': 'acp' }

async function harness(t, backend = 'cursor', mode, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'aio-driver-'))
  const withdraw = provideLaunch(backend, () => ({ command: [process.execPath, fixture, '--mock-dialect', dialects[backend], ...(mode ? ['--mock-mode', mode] : [])], permission: 'deny', model: mode === 'slow-model' ? 'other' : undefined }))
  const runtime = await agentRuntime(t, { backend, cwd, ...options })
  t.after(async () => { withdraw(); await rm(cwd, { recursive: true, force: true }) })
  const calls = async () => {
    try { return (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  return { ...runtime, calls, cwd }
}

function assertBalanced(events) {
  assert.deepEqual(events.filter((event) => event.type === 'step/start').map((event) => [event.data.turn, event.data.step]), events.filter((event) => event.type === 'step/end').map((event) => [event.data.turn, event.data.step]))
  assert.deepEqual(events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn), events.filter((event) => event.type === 'turn/end').map((event) => event.data.turn))
  const steps = events.filter((event) => event.type === 'step/start').map((event) => `${event.data.turn}:${event.data.step}`)
  assert.equal(new Set(steps).size, steps.length)
}

for (const backend of Object.keys(dialects)) {
  test(`${backend}: queued messages run automatically, once each in separate turns`, { timeout: 15000 }, async (t) => {
    const { agent, calls, events, errors } = await harness(t, backend)
    const messages = ['first', 'second', 'third'].map((text) => userMessage(text))
    agent.followup(messages[0])
    await waitFor(async () => (await calls()).length)
    agent.followup(messages[1])
    agent.followup(messages[2])
    await agent.whenIdle()
    assert.deepEqual(events().filter((event) => event.type === 'user/message').map((event) => event.data.id), messages.map((message) => message.id))
    assert.equal(events().filter((event) => event.type === 'turn/start').length, 3)
    assert.equal(agent.inbox.nextTurn.length, 0)
    assert.equal(agent.inbox.nextStep.length, 0)
    assert.deepEqual(errors, [])
    assertBalanced(events())
  })

  test(`${backend}: steering interrupts a running CLI and precedes ordinary follow-ups`, { timeout: 15000 }, async (t) => {
    const { agent, calls, events, errors, updateQueue, frames } = await harness(t, backend)
    const first = userMessage('hold')
    const queued = userMessage('queued later')
    const steering = userMessage('steer now')
    agent.followup(first)
    await waitFor(() => events().some((event) => event.type === 'step/start'))
    agent.followup(steering)
    agent.followup(queued)
    await updateQueue(steering.id, { kind: 'steer' })
    await agent.whenIdle()
    const inputs = events().filter((event) => event.type === 'user/message')
    assert.deepEqual(inputs.map((event) => event.data.id), [first.id, steering.id, queued.id])
    assert.deepEqual(inputs.map((event) => event.data.source), [first.source, steering.source, queued.source])
    assert.equal(agent.inbox.nextTurn.length + agent.inbox.nextStep.length, 0)
    assert.deepEqual(errors, [])
    const runCalls = (await calls()).filter((call) => call.prompt !== undefined || call.method === 'session/prompt')
    assert.equal(runCalls.length, 3)
    if (backend !== 'kimi-code') assert.ok(runCalls.slice(1).every((call) => call.resume === '11111111-1111-1111-1111-111111111111'))
    assert.equal(events().filter((event) => event.type === 'turn/start').length, 2)
    const firstSteps = events().filter((event) => event.type === 'step/start' && event.data.turn === 1).map((event) => event.data.step)
    assert.deepEqual(firstSteps, [1, 2])
    assert.ok(frames.every((frame, index) => index === 0 || frame.revision > frames[index - 1].revision))
    assertBalanced(events())
  })
}

test('stop preserves queued input without automatically running it, then a fresh send wakes it', { timeout: 15000 }, async (t) => {
  const { agent, calls, events, errors } = await harness(t)
  agent.followup(userMessage('hold'))
  await waitFor(() => events().some((event) => event.type === 'step/start'))
  const queued = userMessage('queued')
  agent.followup(queued)
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await agent.whenIdle()
  assert.equal((await calls()).length, 1)
  assert.equal(agent.inbox.nextTurn[0].id, queued.id)
  assert.equal(events().find((event) => event.type === 'turn/end').data.reason.kind, 'aborted')
  agent.followup(userMessage('wake'))
  await agent.whenIdle()
  assert.deepEqual((await calls()).map((call) => call.prompt), ['hold', 'queued', 'wake'])
  assert.deepEqual(errors, [])
  assertBalanced(events())
})

test('stop kills a descendant holding inherited output pipes after the leader exits', { timeout: 15000, skip: process.platform === 'win32' }, async (t) => {
  const { agent, cwd, events } = await harness(t)
  agent.followup(userMessage('hold tree'))
  await waitFor(async () => { try { return await readFile(join(cwd, 'worker.pid'), 'utf8') } catch { return false } })
  await waitFor(() => events().some((event) => event.type === 'plugin:dsh-aio-agent/stream' && event.data.type === 'worker-ready'))
  const worker = Number(await readFile(join(cwd, 'worker.pid'), 'utf8'))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await agent.whenIdle()
  await waitFor(async () => {
    try { return (await readFile(`/proc/${worker}/stat`, 'utf8')).split(' ')[2] === 'Z' } catch (error) { return error.code === 'ENOENT' }
  })
  assertBalanced(events())
})

test('stop escalates when the print process ignores SIGTERM', { timeout: 15000, skip: process.platform === 'win32' }, async (t) => {
  const { agent, events } = await harness(t)
  agent.followup(userMessage('hold ignore-term'))
  await waitFor(() => events().some((event) => event.type === 'step/start'))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await agent.whenIdle()
  assert.equal(agent.status, 'idle')
  assertBalanced(events())
})

test('ACP cancellation has a forced termination fallback and reloads the bound session', { timeout: 15000 }, async (t) => {
  const { agent, calls, errors, events } = await harness(t, 'kimi-code', 'ignore-cancel')
  agent.followup(userMessage('hold'))
  await waitFor(() => events().some((event) => event.type === 'step/start'))
  agent.steer(userMessage('after forced stop'))
  await agent.whenIdle()
  const methods = (await calls()).map((call) => call.method)
  assert.ok(methods.includes('session/cancel'))
  assert.ok(methods.includes('session/load'))
  assert.deepEqual(errors, [])
  assertBalanced(events())
})

test('ACP can stop during initialization before a session id exists', { timeout: 10000 }, async (t) => {
  const { agent, calls, errors, events } = await harness(t, 'kimi-code', 'slow-init')
  agent.followup(userMessage('never reaches prompt'))
  await waitFor(async () => (await calls()).some((call) => call.method === 'initialize'))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await agent.whenIdle()
  assert.ok(!(await calls()).some((call) => call.method === 'session/prompt'))
  assert.deepEqual(errors, [])
  assertBalanced(events())
})

test('a queued CLI failure stops further automatic work and retains pending messages', { timeout: 10000 }, async (t) => {
  const { agent, calls, errors } = await harness(t)
  agent.followup(userMessage('first'))
  await waitFor(async () => (await calls()).length)
  agent.followup(userMessage('fail'))
  const pending = userMessage('later')
  agent.followup(pending)
  await agent.whenIdle()
  assert.deepEqual((await calls()).map((call) => call.prompt), ['first', 'fail'])
  assert.match(errors[0].message, /mock failure/)
  assert.equal(agent.inbox.nextTurn[0].id, pending.id)
})

test('steered images survive the handoff and temporary files are removed after the CLI finishes', { timeout: 10000 }, async (t) => {
  const { agent, calls, events } = await harness(t)
  agent.followup(userMessage('hold'))
  await waitFor(() => events().some((event) => event.type === 'step/start'))
  const image = { type: 'image', mimeType: 'image/png', data: Buffer.from('mock image').toString('base64') }
  const steering = userMessage('look', [image])
  agent.steer(steering)
  await agent.whenIdle()
  const call = (await calls())[1]
  const path = /\[Attached image: (.*?)\]/.exec(call.prompt)?.[1]
  assert.ok(path)
  await assert.rejects(stat(path), { code: 'ENOENT' })
  assert.deepEqual(events().find((event) => event.type === 'user/message' && event.data.id === steering.id).data.content, steering.content)
  assert.ok(readBinding(agent.session)?.chatId)
})

test('a user stop after steering keeps both steering and ordinary input parked', { timeout: 10000 }, async (t) => {
  const { agent, calls, events, stop } = await harness(t)
  agent.followup(userMessage('hold'))
  await waitFor(() => events().some((event) => event.type === 'step/start'))
  const steering = userMessage('steer')
  const queued = userMessage('queued')
  agent.followup(queued)
  agent.steer(steering)
  stop()
  await agent.whenIdle()
  assert.equal((await calls()).length, 1)
  assert.equal(agent.inbox.nextStep[0].id, steering.id)
  assert.equal(agent.inbox.nextTurn[0].id, queued.id)
  assertBalanced(events())
})

test('steering submitted while the loop assembles its first step is not missed', { timeout: 10000 }, async (t) => {
  const steering = userMessage('early steer')
  let injected = false
  const { agent, calls, events } = await harness(t, 'cursor', undefined, { setup(ctx) {
    ctx.on('agent/inbox/claimed', ({ agent }) => {
      if (!injected) { injected = true; agent.steer(steering) }
    })
  } })
  agent.followup(userMessage('hold'))
  await agent.whenIdle()
  assert.deepEqual((await calls()).map((call) => call.prompt), ['early steer'])
  assert.equal(events().filter((event) => event.type === 'user/message').length, 2)
  assertBalanced(events())
})

test('messages arriving as the final transcript commits are automatically continued', { timeout: 10000 }, async (t) => {
  let injected = false
  const later = userMessage('at boundary')
  const { agent, calls, ctx } = await harness(t)
  ctx.on('agent/assistant-stream', ({ frame }) => {
    if (frame.type === 'end' && !injected) { injected = true; agent.followup(later) }
  })
  agent.followup(userMessage('first'))
  await agent.whenIdle()
  assert.deepEqual((await calls()).map((call) => call.prompt), ['first', 'at boundary'])
})

test('stop during skill loading never launches a CLI', { timeout: 10000 }, async (t) => {
  let loading
  const started = new Promise((resolve) => { loading = resolve })
  const skills = { get(_name, { signal }) {
    loading()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } }
  const { agent, calls, errors, stop } = await harness(t, 'cursor', undefined, { skills })
  agent.followup(userMessage('/wait'))
  await started
  stop()
  await agent.whenIdle()
  assert.deepEqual(await calls(), [])
  assert.deepEqual(errors, [])
})

test('ACP can stop while changing its model', { timeout: 10000 }, async (t) => {
  const { agent, calls, errors, stop } = await harness(t, 'kimi-code', 'slow-model')
  agent.followup(userMessage('never reaches prompt'))
  await waitFor(async () => (await calls()).some((call) => call.method === 'session/set_model'))
  stop()
  await agent.whenIdle()
  assert.ok(!(await calls()).some((call) => call.method === 'session/prompt'))
  assert.deepEqual(errors, [])
})

for (const backend of ['cursor', 'kimi-code']) {
  test(`${backend}: disposing the Agent terminates an active CLI`, { timeout: 10000 }, async (t) => {
    const { agent, calls, events, dispose } = await harness(t, backend)
    agent.followup(userMessage('hold'))
    await waitFor(() => events().some((event) => event.type === 'step/start'))
    const pid = (await calls())[0].pid
    await dispose()
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  })
}

for (const kind of ['quiet-tree', 'detached-tree', 'quiet-tree detached-tree']) test(`stop escalates against ${kind} descendants after the leader exits`, { timeout: 15000, skip: process.platform === 'win32' }, async (t) => {
  const { agent, cwd, stop } = await harness(t)
  agent.followup(userMessage(`hold ${kind}`))
  await waitFor(async () => { try { return await readFile(join(cwd, 'worker-ready'), 'utf8') } catch { return false } })
  const worker = Number(await readFile(join(cwd, 'worker.pid'), 'utf8'))
  stop()
  await agent.whenIdle()
  await waitFor(async () => {
    try {
      process.kill(worker, 0)
      return process.platform === 'linux' && (await readFile(`/proc/${worker}/stat`, 'utf8')).split(' ')[2] === 'Z'
    } catch (error) { return error.code === 'ESRCH' || error.code === 'ENOENT' }
  })
})

test('a missing print executable fails the turn without leaving a pending child', { timeout: 10000 }, async (t) => {
  const { agent, errors } = await harness(t)
  const withdraw = provideLaunch('cursor', () => ({ command: [join(tmpdir(), 'aio-command-that-does-not-exist')], permission: 'deny' }))
  t.after(withdraw)
  agent.followup(userMessage('hello'))
  await agent.whenIdle()
  assert.equal(agent.status, 'idle')
  assert.match(errors[0].message, /command not found/)
})
