import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.window = { __ModuleLoader__: { load: (definition) => { globalThis.loaded = definition } } }
await import('../lib/client.js')
const { labelCss, modeView, presetCss, compactModels, setupText, hostText } = globalThis.loaded.factory(() => ({}))
const css = labelCss()
const rules = css.split('\n').map((rule) => ({ selectors: rule.slice(0, rule.indexOf('{')).split(','), body: rule.slice(rule.indexOf('{')) }))

function indexOf(selector) {
  const index = rules.findIndex((rule) => rule.selectors.includes(selector))
  assert.ok(index >= 0, `no rule for ${selector}`)
  return index
}

const LABEL = '[data-provider-id][data-model-id]'

test('every model label gets the Models glyph first', () => {
  assert.equal(indexOf(`${LABEL}::before`), 0)
  assert.match(rules[0].body, /content:""/)
})

test('DeepSeek Harness routes and aio agents get provider marks', () => {
  for (const selector of [
    `${LABEL}[data-provider-id*="deepseek" i]::before`,
    `${LABEL}[data-provider-id*="openrouter" i]::before`,
    `${LABEL}[data-provider-id="aio-cursor"]::before`,
    `${LABEL}[data-provider-id="aio-opencode"]::before`,
  ]) assert.ok(indexOf(selector) > 0)
})

test('model families come after providers, so they win at equal specificity', () => {
  const provider = indexOf(`${LABEL}[data-provider-id="aio-cursor"]::before`)
  for (const selector of [
    `${LABEL}[data-model-id^="gpt-" i]::before`,
    `${LABEL}[data-model-id*="/deepseek" i]::before`,
    `${LABEL}[data-model-id^="opus" i]::before`,
  ]) assert.ok(indexOf(selector) > provider)
})

test('color marks keep their fills, others take the placement tone', () => {
  assert.match(rules[indexOf(`${LABEL}[data-model-id^="gemini" i]::before`)].body, /mask:none;background:url/)
  assert.match(rules[indexOf(`${LABEL}[data-model-id^="grok" i]::before`)].body, /background:var\(--aio-mark-tone,currentColor\)/)
  assert.match(rules[indexOf(`[role="menuitemradio"] ${LABEL}`)].body, /--aio-mark-tone:var\(--dsw-alias-menu-icon/)
})

test('an aio agent group has no heading', () => {
  assert.match(css, /\[data-menu-group\]:has\(\[data-provider-id\]\[data-model-id\]\[data-provider-id\^="aio-"\]\)>\[data-menu-group-heading\]\{display:none\}/)
})

test('every mark is inlined', () => {
  assert.doesNotMatch(css, /url\("undefined"\)/)
  assert.doesNotMatch(presetCss(), /url\("undefined"\)|"undefined"/)
})

test('mode menu rows get DeepSeek by default and each agent its brand', () => {
  const mode = presetCss()
  for (const brand of ['deepseek', 'cursor', 'claude', 'openai', 'opencode']) {
    assert.match(mode, new RegExp(`\\[data-aio-preset-brand="${brand}"\\]::before\\{`))
  }
})

test('the mode menu scrolls, hides filtered rows and clamps every description to two lines', () => {
  const mode = presetCss()
  assert.match(mode, /\[role="menu"\]:has\(\[data-aio-preset-brand\]\)\{max-height:/)
  assert.match(mode, /\[role="presentation"\]\{overflow-y:auto;scrollbar-width:thin;[^}]*scrollbar-color:transparent transparent/)
  assert.match(mode, /\[role="presentation"\]:hover\{scrollbar-color:var\(--dsh-scrollbar-thumb/)
  assert.match(mode, /\[data-aio-filtered\]\{display:none\}/)
  assert.match(mode, /_itemDesc"\]\{[^}]*-webkit-line-clamp:2[^}]*height:32px\}/)
})

function fakeDirectory(current) {
  const listeners = new Set()
  let state = {
    current,
    routable: true,
    groups: [
      { id: 'deepseek-official', models: [{ id: 'deepseek-v4' }, { id: 'deepseek-v4-flash' }] },
      { id: 'aio-cursor', models: [{ id: 'auto' }, { id: 'gpt-5' }] },
      { id: 'aio-opencode', models: [{ id: 'opencode/big' }] },
    ],
    failures: [{ id: 'aio-codex', message: 'x' }],
    status: 'ready',
    pending: null,
    error: null,
  }
  const selected = []
  const directory = {
    catalog: { store: { getSnapshot: () => ({ value: { default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } }) } },
    store: { getSnapshot: () => state, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) },
    load: async () => state,
    select: async (s) => {
      selected.push(s)
      state = { ...state, current: s }
      for (const fn of listeners) fn()
      return { ok: true }
    },
  }
  return { directory, selected }
}

function view(current, preset) {
  const fake = fakeDirectory(current)
  let mode = preset
  const presetListeners = new Set()
  const v = modeView(fake.directory, () => mode, (fn) => (presetListeners.add(fn), () => presetListeners.delete(fn)))
  const setPreset = (next) => {
    mode = next
    for (const fn of presetListeners) fn()
  }
  return { v, setPreset, ...fake }
}

const ids = (state) => state.groups.map((g) => g.id)

test('a DSH preset offers DSH routes only', () => {
  const { v } = view({ provider: 'deepseek-official', model: 'deepseek-v4' }, 'default')
  const state = v.store.getSnapshot()
  assert.deepEqual(ids(state), ['deepseek-official'])
  assert.deepEqual(state.failures, [])
  assert.deepEqual(state.current, { provider: 'deepseek-official', model: 'deepseek-v4' })
})

test('an aio preset offers its own agent only and shows its default for a DSH selection', async () => {
  const { v, selected } = view({ provider: 'deepseek-official', model: 'deepseek-v4' }, 'aio-cursor')
  const stop = v.store.subscribe(() => {})
  const state = v.store.getSnapshot()
  assert.deepEqual(ids(state), ['aio-cursor'])
  assert.deepEqual(state.current, { provider: 'aio-cursor', model: 'auto' })
  assert.equal(state.routable, true)
  await new Promise((r) => setTimeout(r))
  assert.deepEqual(selected, [], 'the DSH selection is kept for a DSH preset')
  stop()
})

test('another agent\'s selection is replaced by this preset\'s default', async () => {
  const { v, selected } = view({ provider: 'aio-opencode', model: 'opencode/big' }, 'aio-cursor')
  const stop = v.store.subscribe(() => {})
  await new Promise((r) => setTimeout(r))
  assert.deepEqual(selected, [{ provider: 'aio-cursor', model: 'auto' }])
  stop()
})

test('returning to a DSH preset replaces an aio selection with the deployment default', async () => {
  const { v, selected, setPreset } = view({ provider: 'aio-cursor', model: 'gpt-5' }, 'aio-cursor')
  const stop = v.store.subscribe(() => {})
  assert.deepEqual(v.store.getSnapshot().current, { provider: 'aio-cursor', model: 'gpt-5' })
  setPreset('default')
  assert.deepEqual(ids(v.store.getSnapshot()), ['deepseek-official'])
  await new Promise((r) => setTimeout(r))
  assert.deepEqual(selected, [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])
  stop()
})

test('load answers the narrowed menu', async () => {
  const { v } = view(null, 'aio-opencode')
  assert.deepEqual(ids(await v.load()), ['aio-opencode'])
})

const CURSOR = [
  { id: 'auto', name: 'Auto' },
  { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 1M Low' },
  { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 1M' },
  { id: 'claude-opus-5-5-medium-fast', name: 'Claude Opus 5.5 1M Fast' },
  { id: 'claude-opus-5-5-max', name: 'Claude Opus 5.5 1M Max' },
  { id: 'claude-4.6-opus-high-thinking', name: 'Claude Opus 4.6 1M Thinking' },
  { id: 'claude-4.6-opus-max-thinking', name: 'Claude Opus 4.6 1M Max Thinking' },
  { id: 'muse-wonder-1.0-minimal', name: 'Muse Wonder Minimal' },
  { id: 'muse-wonder-1.0-medium', name: 'Muse Wonder Medium' },
]

test('a per-level listing shortens to one row per model family', () => {
  assert.deepEqual(compactModels(CURSOR).map((m) => m.id), ['auto', 'claude-opus-5-5-medium', 'claude-4.6-opus-high-thinking', 'muse-wonder-1.0-medium'])
  assert.ok(compactModels(CURSOR, 'claude-opus-5-5-max').some((m) => m.id === 'claude-opus-5-5-max'), 'the current model stays listed')
})

test('the Cursor menu lists the shortlist until the search box holds a query', async () => {
  const fake = fakeDirectory({ provider: 'aio-cursor', model: 'auto' })
  const state = fake.directory.store.getSnapshot()
  state.groups = [{ id: 'aio-cursor', models: CURSOR }]
  let query = false
  const v = modeView(fake.directory, () => 'aio-cursor', () => () => {}, { active: () => query, subscribe: () => () => {} })
  assert.equal(v.store.getSnapshot().groups[0].models.length, 4)
  query = true
  assert.equal(v.store.getSnapshot().groups[0].models.length, CURSOR.length)
  query = false
  assert.equal((await v.load()).groups[0].models.length, CURSOR.length, 'the /model popup searches every id')
})

test('the setup prompt names the agent, its install line and the patch entry for its absolute path', () => {
  const agent = { id: 'cursor', label: 'Cursor', command: 'cursor-agent acp', install: 'curl https://cursor.com/install -fsS | bash', login: 'cursor-agent login' }
  for (const lang of ['zh-CN', 'en']) {
    globalThis.document = { documentElement: { lang } }
    const { note, action, prompt } = setupText(agent)
    assert.match(note, /Cursor/)
    assert.ok(action)
    assert.ok(prompt.includes('command -v cursor-agent'))
    assert.ok(prompt.includes('curl https://cursor.com/install -fsS | bash'))
    assert.ok(prompt.includes('cursor-agent login'))
    assert.ok(prompt.includes('- id: aio-cursor\n  name: "@cocofhu/dsh-aio-agent/cursor"\n  config:\n    command: "<absolute path to cursor-agent> acp"'))
    assert.ok(prompt.includes('${DSH_HOME:-~/.dsh}/profiles/<profile>/cordis.patch.yml'))
  }
  globalThis.document = { documentElement: { lang: 'en' } }
  assert.ok(setupText({ ...agent, id: 'claude-code', label: 'Claude Code', command: 'claude-agent-acp' }).prompt.includes('command: "<absolute path to claude-agent-acp>"'))
  delete globalThis.document
})

test('host preset descriptions and turn errors read in Chinese and keep English as is', async () => {
  const { BACKENDS } = await import('../lib/backends.js')
  for (const backend of Object.values(BACKENDS)) {
    assert.equal(hostText(backend.description, false)?.text, backend.description)
    assert.match(hostText(backend.description, true).text, new RegExp(`^把每一轮对话交给本机的 ${backend.label}( \\w+)?，`))
  }
  const missing = hostText('Kimi Code could not start: command not found: /nonexistent/kimi (install it and make sure it is on PATH for the DSH process)', true)
  assert.equal(missing.text, 'Kimi Code 无法启动：找不到命令 /nonexistent/kimi。请先安装，并确保它在 DSH 服务进程的 PATH 中。')
  assert.equal(missing.agent.id, 'kimi-code')
  const legacy = hostText('command not found: /nonexistent/kimi (install it and make sure it is on PATH for the DSH process)', true)
  assert.equal(legacy.text, '无法启动：找不到命令 /nonexistent/kimi。请先安装，并确保它在 DSH 服务进程的 PATH 中。')
  assert.equal(legacy.agent, undefined)
  const signedOut = hostText('Codex is not signed in: run `codex login` in a terminal on the DSH machine, then send again', true)
  assert.match(signedOut.text, /^Codex 尚未登录：.*`codex login`/)
  assert.equal(signedOut.agent.id, 'codex')
  const mismatch = hostText('this session runs Cursor, but the selected model belongs to Codex; pick a Cursor model or start a Codex session', true)
  assert.equal(mismatch.text, '当前会话运行的是 Cursor，但所选模型属于 Codex；请选择 Cursor 的模型，或新建一个 Codex 会话。')
  assert.equal(mismatch.agent, undefined)
  assert.match(hostText('OpenCode models run only in the OpenCode agent preset; choose it from the mode menu or pick another model', true).text, /^OpenCode 的模型只能在 OpenCode 模式下使用/)
  assert.equal(hostText('something else', true), undefined)
})
