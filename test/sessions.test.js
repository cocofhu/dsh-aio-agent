import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { handleResume } from '../lib/driver.js'
import { bindingProjection, buildDiagnosticTrace, serveSessions, serveTrace } from '../lib/index.js'
import { cursorWorkspaceHash, escapeProjectDir, foldClaudeTranscript, foldCodebuddyTranscript, isSessionId, listBackendSessions, parseCodexIndex, parseOpenCodeList, readBinding } from '../lib/sessions.js'

test('project directories and the Cursor workspace hash follow each CLI', () => {
  assert.equal(escapeProjectDir('/work/app'), '-work-app')
  assert.equal(cursorWorkspaceHash('/root'), '887904812217cca9bc2b9adb875daf42')
  assert.equal(isSessionId('ses_e6bf5a38fffeEUeOX2hI9b15wI'), true)
  assert.equal(isSessionId('--resume'), false)
  assert.equal(isSessionId('../etc/passwd'), false)
})

test('Claude titles prefer a custom title, then the last prompt, then the first user line', () => {
  const folded = foldClaudeTranscript([
    { type: 'user', message: { content: [{ type: 'text', text: 'first question' }] } },
    { type: 'last-prompt', lastPrompt: 'latest prompt' },
    { type: 'custom-title', customTitle: 'Chosen title' },
    { type: 'user', isSidechain: true, message: { content: 'side' } },
  ])
  assert.equal(folded.title, 'Chosen title')
  assert.equal(foldClaudeTranscript([{ type: 'last-prompt', lastPrompt: 'only prompt' }]).title, 'only prompt')
  assert.equal(foldClaudeTranscript([{ type: 'user', message: { content: 'hello' } }]).title, 'hello')
})

test('CodeBuddy titles come from the first user message', () => {
  const folded = foldCodebuddyTranscript([
    { type: 'session-meta', cwd: '/work/app' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }], cwd: '/work/app' },
  ])
  assert.equal(folded.title, '你好')
  assert.equal(folded.cwd, '/work/app')
})

test('Codex and OpenCode indexes keep ids, titles and the current workspace', () => {
  const codex = parseCodexIndex('{"id":"01a13442-75d3-7ca2-b758-2a6044a30f39","thread_name":"继续处理任务","updated_at":"2026-10-13T08:02:23.000Z"}\nnot json\n', '/work/app')
  assert.equal(codex.length, 1)
  assert.equal(codex[0].title, '继续处理任务')
  assert.equal(codex[0].currentWorkspace, false)
  assert.ok(codex[0].updatedAt > 0)
  const open = parseOpenCodeList(JSON.stringify([{ id: 'ses_current', title: 'Here', updated: '2026-02-01T00:00:00Z', directory: '/work/app' }, { id: 'ses_other', title: 'Away', updated: 10, directory: '/else' }]), '/work/app')
  assert.equal(open[0].currentWorkspace, true)
  assert.equal(open[1].currentWorkspace, false)
})

test('each backend scanner reads only its own directory under home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aio-sessions-'))
  const cwd = '/work/app'
  try {
    const claudeDir = join(home, '.claude', 'projects', escapeProjectDir(cwd))
    const otherDir = join(home, '.claude', 'projects', '-else')
    await mkdir(claudeDir, { recursive: true })
    await mkdir(otherDir, { recursive: true })
    await writeFile(join(claudeDir, '11111111-1111-1111-1111-111111111111.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'current workspace' }, cwd }),
      'x'.repeat(300_000),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'current prompt' }),
    ].join('\n'))
    await writeFile(join(otherDir, '22222222-2222-2222-2222-222222222222.jsonl'), JSON.stringify({ type: 'user', message: { content: 'other workspace' }, cwd: '/else' }))
    const claude = await listBackendSessions('claude-code', cwd, { home })
    assert.equal(claude[0].id, '11111111-1111-1111-1111-111111111111')
    assert.equal(claude[0].title, 'current prompt')
    assert.equal(claude[0].currentWorkspace, true)
    assert.equal(claude[1].currentWorkspace, false)

    const codebuddyDir = join(home, '.codebuddy', 'projects', escapeProjectDir(cwd))
    await mkdir(codebuddyDir, { recursive: true })
    await writeFile(join(codebuddyDir, '33333333-3333-3333-3333-333333333333.jsonl'), JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'buddy' }], cwd }))
    const codebuddy = await listBackendSessions('codebuddy', cwd, { home })
    assert.equal(codebuddy[0].title, 'buddy')
    assert.equal(codebuddy[0].currentWorkspace, true)

    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex', 'session_index.jsonl'), '{"id":"01a13442-75d3-7ca2-b758-2a6044a30f39","thread_name":"codex thread","updated_at":"2026-10-13T08:02:23.000Z"}\n')
    const codex = await listBackendSessions('codex', cwd, { home })
    assert.equal(codex[0].title, 'codex thread')

    const hash = cursorWorkspaceHash(cwd)
    const chat = '44444444-4444-4444-4444-444444444444'
    await mkdir(join(home, '.cursor', 'chats', hash, chat), { recursive: true })
    await writeFile(join(home, '.cursor', 'chats', hash, chat, 'meta.json'), JSON.stringify({ title: 'cursor chat', updatedAtMs: 50, cwd }))
    await mkdir(join(home, '.cursor', 'chats', 'abc', '55555555-5555-5555-5555-555555555555'), { recursive: true })
    await writeFile(join(home, '.cursor', 'chats', 'abc', '55555555-5555-5555-5555-555555555555', 'meta.json'), JSON.stringify({ title: 'elsewhere', updatedAtMs: 90, cwd: '/else' }))
    const cursor = await listBackendSessions('cursor', cwd, { home })
    assert.equal(cursor[0].id, chat)
    assert.equal(cursor[0].currentWorkspace, true)
    assert.equal(cursor[1].currentWorkspace, false)

    const open = await listBackendSessions('opencode', cwd, {
      home,
      spawn: async (command, args) => {
        assert.equal(command, 'opencode')
        assert.deepEqual(args, ['session', 'list', '--format', 'json', '-n', '50'])
        return JSON.stringify([{ id: 'ses_current', title: 'open', updated: 20, directory: cwd }])
      },
    })
    assert.equal(open[0].title, 'open')
    assert.equal(open[0].currentWorkspace, true)
    assert.deepEqual(await listBackendSessions('kimi-code', cwd, { home }), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

function fakeSession(events = []) {
  return {
    header: { cwd: '/work/app' },
    snapshotEvents: () => events,
    append(type, data) {
      events.push({ type, data })
    },
  }
}

test('/resume writes a print binding and the source title when the DSH session has none', async () => {
  const events = []
  const session = fakeSession(events)
  const recorded = []
  let closed = false
  const result = await handleResume({
    session,
    backend: { id: 'claude-code', printArgv() {} },
    rawInput: ' 11111111-1111-1111-1111-111111111111 ',
    record: (type, data) => recorded.push({ type, data }),
    close: () => { closed = true },
    lookup: async () => [{ id: '11111111-1111-1111-1111-111111111111', title: 'Chosen title' }],
  })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'Resuming "Chosen title" (11111111-1111-1111-1111-111111111111).')
  assert.equal(closed, true)
  assert.deepEqual(recorded[0].data, { backend: 'claude-code', cwd: '/work/app', chatId: '11111111-1111-1111-1111-111111111111', resumed: true })
  assert.equal(recorded[1].data.title, 'Chosen title')
  assert.equal(events.at(-1).type, 'session/title')
  assert.equal(events.at(-1).data.title, 'Chosen title')
  const again = await handleResume({
    session,
    backend: { id: 'claude-code', printArgv() {} },
    rawInput: '22222222-2222-2222-2222-222222222222',
    record: (type, data) => recorded.push({ type, data }),
    lookup: async () => [{ id: '22222222-2222-2222-2222-222222222222', title: 'Other' }],
  })
  assert.equal(again.text, 'Resuming "Other" (22222222-2222-2222-2222-222222222222).')
  assert.equal(events.filter((event) => event.type === 'session/title').at(-1).data.title, 'Other')
})

test('/resume stores an ACP session id for Kimi and rejects a flag-like id', async () => {
  const session = fakeSession()
  const recorded = []
  const bound = await handleResume({
    session,
    backend: { id: 'kimi-code' },
    rawInput: 'kimi123',
    record: (type, data) => recorded.push(data),
    lookup: async () => [],
  })
  assert.equal(bound.kind, 'success')
  assert.deepEqual(recorded[0], { backend: 'kimi-code', cwd: '/work/app', acpSessionId: 'kimi123', resumed: true })
  const rejected = await handleResume({
    session,
    backend: { id: 'claude-code', printArgv() {} },
    rawInput: '--help',
    record: () => { throw new Error('should not record') },
  })
  assert.equal(rejected.kind, 'error')
  const empty = await handleResume({
    session: fakeSession([{ type: 'plugin:dsh-aio-agent/binding', data: { backend: 'claude-code', chatId: 'abc' } }]),
    backend: { id: 'claude-code', printArgv() {} },
    rawInput: '   ',
    record: () => { throw new Error('should not record') },
  })
  assert.match(empty.text, /abc/)
  const clearedEvents = [{ type: 'plugin:dsh-aio-agent/binding', data: { backend: 'claude-code', chatId: 'abc' } }]
  const cleared = await handleResume({
    session: fakeSession(clearedEvents),
    backend: { id: 'claude-code', printArgv() {} },
    rawInput: 'off',
    record: (type, data) => clearedEvents.push({ type, data }),
  })
  assert.equal(cleared.kind, 'success')
  assert.equal(cleared.text, 'Cleared resumed session (abc).')
  assert.equal(readBinding(fakeSession(clearedEvents)), undefined)
})

test('the binding projection keeps a title when a later turn records the same id', () => {
  const projection = bindingProjection()
  let state = projection.init()
  assert.equal(projection.wire.viewSchema.parse(projection.wire.view(state)), null)
  state = projection.apply(state, { type: 'command/run', data: { name: 'resume', args: ' legacy-id' } })
  assert.deepEqual(state, { backend: '', id: 'legacy-id', title: null, resumed: true })
  state = projection.apply(state, { type: 'plugin:dsh-aio-agent/binding', data: { backend: 'claude-code', cwd: '/work', chatId: 'legacy-id' } })
  assert.deepEqual(state, { backend: 'claude-code', id: 'legacy-id', title: null, resumed: true })
  state = projection.apply(state, { type: 'agent-preset/selected', data: { agentPreset: 'aio-codex' } })
  assert.equal(state, null)
  state = projection.apply(state, { type: 'plugin:dsh-aio-agent/binding', data: { backend: 'claude-code', cwd: '/work', chatId: 'abc', title: 'Chosen title', resumed: true } })
  assert.deepEqual(projection.stateSchema.parse(state), { backend: 'claude-code', id: 'abc', title: 'Chosen title', resumed: true })
  state = projection.apply(state, { type: 'plugin:dsh-aio-agent/binding', data: { backend: 'claude-code', cwd: '/work', chatId: 'abc' } })
  assert.equal(state.title, 'Chosen title')
  assert.equal(state.resumed, true)
  state = projection.apply(state, { type: 'plugin:dsh-aio-agent/binding', data: { backend: 'kimi-code', acpSessionId: 'kimi123' } })
  assert.deepEqual(state, { backend: 'kimi-code', id: 'kimi123', title: null, resumed: false })
  state = projection.apply(state, { type: 'plugin:dsh-aio-agent/binding', data: { backend: 'kimi-code', cleared: true } })
  assert.equal(state, null)
  state = projection.apply(state, { type: 'session/title', data: { title: 'ignored' } })
  assert.equal(state, null)
})

test('the sessions route lists the preset backend and reports the active id', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aio-route-'))
  try {
    const cwd = '/work/app'
    const dir = join(home, '.claude', 'projects', escapeProjectDir(cwd))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'), JSON.stringify({ type: 'user', message: { content: 'routed' }, cwd }))
    const sessionEvents = [{ type: 'plugin:dsh-aio-agent/binding', data: { backend: 'claude-code', chatId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } }]
    const session = {
      header: { cwd },
      snapshotEvents: () => sessionEvents,
      append: (type, data) => sessionEvents.push({ type, data }),
    }
    const ctx = {
      aioHome: home,
      sessions: { get: (id) => (id === 's1' ? session : undefined) },
      sessionProjections: { stateOf: () => 'aio-claude-code' },
    }
    const missing = await serveSessions(ctx, { url: 'http://localhost/api/aio-agent/sessions' })
    assert.equal(missing.status, 400)
    const absent = await serveSessions(ctx, { url: 'http://localhost/api/aio-agent/sessions?sessionId=nope' })
    assert.equal(absent.status, 404)
    const ok = await serveSessions(ctx, { url: 'http://localhost/api/aio-agent/sessions?sessionId=s1' })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.equal(body.activeId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    assert.equal(body.sessions[0].title, 'routed')
    assert.equal(body.sessions[0].currentWorkspace, true)
    const del = await (await serveSessions(ctx, { method: 'DELETE', url: 'http://localhost/api/aio-agent/sessions?sessionId=s1' })).json()
    assert.deepEqual(del, { cleared: true, activeId: null })
    assert.equal(readBinding(session), undefined)
    const other = {
      ...ctx,
      sessionProjections: { stateOf: () => 'standard' },
    }
    const empty = await (await serveSessions(other, { url: 'http://localhost/api/aio-agent/sessions?sessionId=s1' })).json()
    assert.deepEqual(empty, { sessions: [], activeId: null })
    const host = new Proxy({
      sessions: { get: () => session },
      sessionProjections: { stateOf: () => 'aio-kimi-code' },
    }, {
      get(target, key) {
        if (key === 'aioHome') throw new Error('cannot get property "aioHome" without inject')
        return target[key]
      },
    })
    const listed = await serveSessions(host, { url: 'http://localhost/api/aio-agent/sessions?sessionId=s1' })
    assert.equal(listed.status, 200)
    assert.deepEqual(await listed.json(), { sessions: [], activeId: null })
    const traceSession = {
      header: { cwd },
      snapshotEvents: () => [
        { seq: 1, type: 'model/selection', data: { provider: 'aio-codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' } },
        { seq: 2, type: 'plugin:dsh-aio-agent/stream', data: { type: 'error', message: 'model_not_found', apiKey: 'secret-value' } },
        { seq: 3, type: 'plugin:dsh-aio-agent/trace', data: { backend: 'codex', argv: ['codex', 'exec', '--json'], exitCode: 1, stderr: 'codex version too old', error: "The 'gpt-6.1-sol' model is not supported" } },
      ],
    }
    const built = await buildDiagnosticTrace(traceSession, {
      preset: 'aio-codex',
      message: "The 'gpt-6.1-sol' model is not supported",
      cliVersionLookup: async () => 'codex-cli 0.1.0',
    })
    assert.match(built.trace, /CLI Version\*\*: `codex-cli 0\.1\.0`/)
    assert.match(built.trace, /gpt-6\.1-sol/)
    assert.match(built.trace, /codex version too old/)
    assert.doesNotMatch(built.trace, /secret-value/)
    assert.match(built.issueUrl, /^https:\/\/github\.com\/cocofhu\/dsh-aio-agent\/issues\/new\?/)
    const traceResp = await serveTrace({
      sessions: { get: (id) => (id === 's1' ? traceSession : undefined) },
      sessionProjections: { stateOf: () => 'aio-codex' },
    }, { url: 'http://localhost/api/aio-agent/trace?sessionId=s1&message=boom' })
    assert.equal(traceResp.status, 200)
    const traceJson = await traceResp.json()
    assert.match(traceJson.trace, /Diagnostic Trace/)
    assert.match(traceJson.issueUrl, /issues\/new/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
