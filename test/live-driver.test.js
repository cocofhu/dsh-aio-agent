import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { provideLaunch } from '../lib/backends.js'
import { readBinding } from '../lib/sessions.js'
import { agentRuntime, userMessage, waitFor } from './helpers/agent-runtime.mjs'

// Explicit opt-in: these tests call DeepSeek through installed CLIs and cost tokens.
const enabled = process.env.DSH_AIO_LIVE_TESTS === '1' && !!process.env.DEEPSEEK_API_KEY

async function liveRuntime(t, backend) {
  const cwd = await mkdtemp(join(tmpdir(), 'aio-live-'))
  const previous = {}
  const env = (name, value) => { previous[name] = process.env[name]; process.env[name] = value }
  const model = 'deepseek-flash'
  if (backend === 'opencode') {
    env('OPENCODE_CONFIG_CONTENT', JSON.stringify({
      enabled_providers: ['aio-test'],
      model: `aio-test/${model}`, small_model: `aio-test/${model}`,
      provider: { 'aio-test': { npm: '@ai-sdk/openai-compatible', name: 'DeepSeek test', options: { baseURL: 'https://api.deepseek.com/v1', apiKey: '{env:DEEPSEEK_API_KEY}' }, models: { [model]: { name: model, limit: { context: 1048576, output: 4096 } } } } },
      permission: 'allow', autoupdate: false, share: 'disabled',
    }))
  } else {
    const config = join(cwd, 'config')
    await mkdir(config)
    await writeFile(join(config, 'models.json'), JSON.stringify({ models: [{ id: model, name: model, vendor: 'deepseek', apiKey: '${DEEPSEEK_API_KEY}', url: 'https://api.deepseek.com/v1/chat/completions', maxInputTokens: 1048576, maxOutputTokens: 4096, supportsToolCall: true }], availableModels: [model] }))
    env('CODEBUDDY_CONFIG_DIR', config)
  }
  const withdraw = provideLaunch(backend, () => ({
    command: backend === 'codebuddy' ? ['codebuddy', '--allowedTools', 'Bash'] : ['opencode', '--pure'],
    model: backend === 'opencode' ? `aio-test/${model}` : `custom-local:${model}`,
    permission: 'deny',
  }))
  const runtime = await agentRuntime(t, { backend, cwd })
  t.after(async () => {
    withdraw()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(cwd, { recursive: true, force: true })
  })
  return { ...runtime, cwd }
}

function assistantText(events) {
  return events.filter((event) => event.type === 'assistant/message').flatMap((event) => event.data.message.content).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

async function startSleep(runtime) {
  const { cwd, agent } = runtime
  agent.followup(userMessage(`Use your shell tool to execute exactly: echo $$ > ${cwd}/started; sleep 30; echo finished > ${cwd}/finished . Wait for completion. Do not run other tools.`))
  return Number(await waitFor(async () => { try { return await readFile(join(cwd, 'started'), 'utf8') } catch { return false } }, { timeout: 60000 }))
}

async function assertStopped(pid) {
  await waitFor(async () => {
    try {
      process.kill(pid, 0)
      return process.platform === 'linux' && (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z'
    } catch (error) { return error.code === 'ESRCH' || error.code === 'ENOENT' }
  }, { timeout: 5000 })
}

for (const backend of ['opencode', 'codebuddy']) {
  test(`${backend}: live DeepSeek queued turns resume the same CLI conversation`, { skip: !enabled, timeout: 180000 }, async (t) => {
    const { agent, events, errors } = await liveRuntime(t, backend)
    const messages = [
      userMessage('Remember the token AIO_MEMORY_7391. Reply exactly AIO_FIRST_OK. Do not use tools.'),
      userMessage('What token did I ask you to remember? Reply with only that token. Do not use tools.'),
      userMessage('Reply exactly AIO_THIRD_OK. Do not use tools.'),
    ]
    for (const message of messages) agent.followup(message)
    await agent.whenIdle()
    assert.deepEqual(errors, [])
    assert.deepEqual(events().filter((event) => event.type === 'user/message').map((event) => event.data.id), messages.map((message) => message.id))
    const text = assistantText(events())
    for (const marker of ['AIO_FIRST_OK', 'AIO_MEMORY_7391', 'AIO_THIRD_OK']) assert.ok(text.includes(marker), text)
    assert.equal(events().filter((event) => event.type === 'turn/start').length, 3)
    assert.ok(readBinding(agent.session)?.chatId)
  })

  test(`${backend}: live queue Send interrupts an active shell tool and runs pending input`, { skip: !enabled, timeout: 180000 }, async (t) => {
    const runtime = await liveRuntime(t, backend)
    const { agent, events, errors, updateQueue } = runtime
    const shellPid = await startSleep(runtime)
    const steering = userMessage('Cancel the sleep task. Reply exactly AIO_STEER_OK. Do not use any tools.')
    const queued = userMessage('Reply exactly AIO_QUEUE_OK. Do not use any tools.')
    agent.followup(steering)
    agent.followup(queued)
    await updateQueue(steering.id, { kind: 'steer' })
    await agent.whenIdle()
    assert.deepEqual(errors, [])
    const text = assistantText(events())
    assert.ok(text.includes('AIO_STEER_OK'), text)
    assert.ok(text.includes('AIO_QUEUE_OK'), text)
    await assertStopped(shellPid)
    assert.equal(agent.inbox.nextTurn.length + agent.inbox.nextStep.length, 0)
  })

  test(`${backend}: live Stop terminates an active shell tool and retains queued input`, { skip: !enabled, timeout: 120000 }, async (t) => {
    const runtime = await liveRuntime(t, backend)
    const { agent, stop, errors } = runtime
    const shellPid = await startSleep(runtime)
    const queued = userMessage('This must stay queued after Stop.')
    agent.followup(queued)
    const beforeStop = Date.now()
    stop()
    await agent.whenIdle()
    assert.ok(Date.now() - beforeStop < 10000)
    await assertStopped(shellPid)
    assert.deepEqual(errors, [])
    assert.equal(agent.inbox.nextTurn[0].id, queued.id)
  })
}
