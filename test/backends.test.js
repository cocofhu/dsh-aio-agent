import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentBackend, effortName, parseCodexCache, parseCommand, parseHelpModels, parseModelList, parseOpenCodeModels, provideLaunch, resolveBackend } from '../lib/backends.js'

globalThis.window = { __ModuleLoader__: { load: (definition) => { globalThis.loaded = definition } } }
await import('../lib/client.js')
const { commandIsValid } = globalThis.loaded.factory(() => ({}))

test('launch lines split like a shell', () => {
  assert.deepEqual(parseCommand('cursor-agent acp'), ['cursor-agent', 'acp'])
  assert.deepEqual(parseCommand('  "/opt/Cursor Agent/cursor-agent"   acp '), ['/opt/Cursor Agent/cursor-agent', 'acp'])
  assert.deepEqual(parseCommand(`npx -y '@zed-industries/codex-acp'`), ['npx', '-y', '@zed-industries/codex-acp'])
  assert.deepEqual(parseCommand('C:\\\\Tools\\\\opencode.exe acp ""'), ['C:\\Tools\\opencode.exe', 'acp', ''])
  assert.deepEqual(parseCommand('a\\ b "say \\"hi\\""'), ['a b', 'say "hi"'])
  assert.deepEqual(parseCommand('   '), [])
  assert.throws(() => parseCommand('"unclosed acp'), /unclosed/)
})

test('the settings page accepts what the Host can parse', () => {
  for (const line of ['cursor-agent acp', '"/a b/c" acp', `'x' "y"`, 'a\\"b']) {
    assert.equal(commandIsValid(line), true, line)
    assert.doesNotThrow(() => parseCommand(line))
  }
  for (const line of ['"a', `'b`, 'c "d']) {
    assert.equal(commandIsValid(line), false, line)
    assert.throws(() => parseCommand(line))
  }
})

test('blank overrides keep the built-in launch', () => {
  assert.deepEqual(resolveBackend('cursor', { command: '', model: ' ' }).argv, ['cursor-agent', 'acp'])
  assert.deepEqual(resolveBackend('cursor', { model: 'gpt-5' }).argv, ['cursor-agent', '--model', 'gpt-5', 'acp'])
  assert.deepEqual(resolveBackend('kimi-code', { command: ['/opt/kimi', 'acp', '--debug'] }).argv, ['/opt/kimi', 'acp', '--debug'])
})

test('a launch line naming the retired ACP adapter starts the CLI itself', () => {
  for (const command of ['codex-acp', 'npx -y @zed-industries/codex-acp', '/usr/local/bin/codex-acp --debug']) {
    assert.deepEqual(resolveBackend('codex', { command }).printArgv({ prompt: 'hi' }).slice(0, 2), ['codex', 'exec'], command)
  }
  assert.deepEqual(resolveBackend('claude-code', { command: 'claude-agent-acp' }).argv, ['claude'])
  assert.deepEqual(resolveBackend('codex', { command: '/opt/codex --profile work' }).printArgv({ prompt: 'hi' }).slice(0, 4), ['/opt/codex', '--profile', 'work', 'exec'])
})

test('edits reach the next launch through the published source', () => {
  const settings = { command: '', model: '', permission: 'allow' }
  const withdraw = provideLaunch('kimi-code', () => settings)
  assert.deepEqual(currentBackend('kimi-code').argv, ['kimi', 'acp'])
  settings.command = '/usr/local/bin/kimi acp'
  settings.permission = 'deny'
  assert.deepEqual(currentBackend('kimi-code').argv, ['/usr/local/bin/kimi', 'acp'])
  assert.equal(currentBackend('kimi-code').permission, 'deny')
  withdraw()
  assert.equal(currentBackend('kimi-code').permission, 'allow')
  assert.deepEqual(currentBackend('kimi-code').argv, ['kimi', 'acp'])
})

test('Cursor runs each turn in print mode, approving tools and MCP servers when allowed', () => {
  const cursor = resolveBackend('cursor')
  assert.equal(cursor.stdin, 'raw')
  assert.equal(cursor.defaultModel, 'auto')
  assert.deepEqual(cursor.printArgv({ model: 'claude-opus-5-5-medium', cwd: '/w', resume: 'chat-1', force: true }), [
    'cursor-agent', '--print', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--yolo', '--approve-mcps',
    '--workspace', '/w', '--model', 'claude-opus-5-5-medium', '--resume', 'chat-1',
  ])
  assert.ok(!cursor.printArgv({}).includes('--yolo'))
  assert.deepEqual(cursor.acpArgv('claude-opus-5-5-medium'), ['cursor-agent', '--model', 'claude-opus-5-5-medium', 'acp'])
  const custom = resolveBackend('cursor', { command: '"/opt/Cursor Agent/cursor-agent" --endpoint x acp', model: 'gpt-5.5-high' })
  assert.equal(custom.defaultModel, 'gpt-5.5-high')
  assert.deepEqual(custom.printArgv({}).slice(0, 4), ['/opt/Cursor Agent/cursor-agent', '--endpoint', 'x', '--print'])
})

test('Claude Code reads a stream-json user message and keeps its own model by default', () => {
  const claude = resolveBackend('claude-code')
  assert.equal(claude.dialect, 'claude')
  assert.equal(claude.stdin, 'json')
  assert.equal(claude.inputIncludesCache, false)
  assert.equal(claude.acpArgv, undefined)
  assert.equal(claude.defaultModel, 'default')
  assert.deepEqual(claude.printArgv({ model: 'opus', resume: 's-1', force: true }), [
    'claude', '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'bypassPermissions', '--disallowedTools', 'AskUserQuestion', '--model', 'opus', '--resume', 's-1',
  ])
  assert.ok(!claude.printArgv({ model: 'default' }).includes('--model'))
})

test('Codex runs `codex exec --json`, resuming its thread and passing the effort as config', () => {
  const codex = resolveBackend('codex')
  assert.equal(codex.dialect, 'codex')
  assert.equal(codex.stdin, 'none')
  assert.equal(codex.acpArgv, undefined)
  assert.deepEqual(codex.argv, ['codex'])
  assert.deepEqual(codex.printArgv({ model: 'gpt-6-sol', effort: 'high', resume: 't-1', force: true, prompt: '-x hi' }), [
    'codex', 'exec', 'resume', 't-1', '--json', '--skip-git-repo-check', '--model', 'gpt-6-sol',
    '-c', 'model_reasoning_effort=high', '--dangerously-bypass-approvals-and-sandbox', '--', '-x hi',
  ])
  assert.deepEqual(codex.printArgv({ prompt: 'hi' }), ['codex', 'exec', '--json', '--skip-git-repo-check', '--', 'hi'])
  const env = codex.printEnv({ PATH: '/bin', OPENAI_API_KEY: 'k', CODEX_API_KEY: 'k', ACP_CODEX_API_KEY: 'k' })
  assert.deepEqual(env, { PATH: '/bin' })
})

test('OpenCode runs `opencode run --format json`, continuing its session and passing the effort as variant', () => {
  const opencode = resolveBackend('opencode')
  assert.equal(opencode.dialect, 'opencode')
  assert.equal(opencode.stdin, 'none')
  assert.deepEqual(opencode.printArgv({ model: 'deepseek/deepseek-flash', effort: 'max', cwd: '/w', resume: 'ses_1', force: true, prompt: 'hi' }), [
    'opencode', 'run', '--format', 'json', '--thinking', '--dangerously-skip-permissions', '--dir', '/w',
    '--model', 'deepseek/deepseek-flash', '--variant', 'max', '--session', 'ses_1', '--', 'hi',
  ])
  assert.ok(!opencode.printArgv({ prompt: 'hi' }).includes('--dangerously-skip-permissions'))
})

test('CodeBuddy reads a stream-json user message, with models listed by `codebuddy --help`', () => {
  const codebuddy = resolveBackend('codebuddy')
  assert.equal(codebuddy.dialect, 'claude')
  assert.equal(codebuddy.stdin, 'json')
  assert.equal(codebuddy.inputIncludesCache, true)
  assert.equal(codebuddy.defaultModel, undefined)
  assert.deepEqual(codebuddy.printArgv({ model: 'custom-local:deepseek-v4-pro', cwd: '/w', resume: 's-1', force: true }), [
    'codebuddy', '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--permission-mode', 'bypassPermissions', '--disallowedTools', 'AskUserQuestion',
    '--model', 'custom-local:deepseek-v4-pro', '--resume', 's-1',
  ])
  assert.deepEqual(codebuddy.printArgv({}).slice(8, 10), ['--permission-mode', 'default'])
  assert.deepEqual(resolveBackend('codebuddy', { command: '/opt/codebuddy --acp --region x' }).printArgv({}).slice(0, 4), ['/opt/codebuddy', '--region', 'x', '--print'])
  assert.deepEqual(resolveBackend('kimi-code').argv, ['kimi', 'acp'])
  assert.equal(resolveBackend('kimi-code').printArgv, undefined)
})

test('the Codex catalog is the listed models of its cache, with their efforts', () => {
  const cache = JSON.stringify({
    models: [
      { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', priority: 5, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], context_window: 272000 },
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 4 },
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 1, default_reasoning_level: 'xhigh', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
    ],
  })
  assert.deepEqual(parseCodexCache(cache), [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'ultra'] },
    { id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium'], defaultEffort: 'medium', context: 272000 },
  ])
  assert.equal(parseCodexCache('not json'), undefined)
  assert.equal(parseCodexCache('{"models":[]}'), undefined)
  assert.equal(effortName('xhigh'), 'Extra high')
  assert.equal(effortName('turbo'), 'Turbo')
})

test('OpenCode models carry their variants as efforts', () => {
  const text = 'opencode/beam-free\n{\n  "id": "beam-free",\n  "name": "Beam Free",\n  "limit": { "context": 1048576 },\n  "variants": {\n    "low": {},\n    "max": {}\n  }\n}\ndeepseek/deepseek-flash\n{\n  "name": "DeepSeek Flash"\n}\nlocal/plain\n'
  assert.deepEqual(parseOpenCodeModels(text), [
    { id: 'opencode/beam-free', name: 'Beam Free (opencode)', efforts: ['low', 'max'], context: 1048576 },
    { id: 'deepseek/deepseek-flash', name: 'DeepSeek Flash (deepseek)' },
    { id: 'local/plain', name: 'local/plain' },
  ])
})

test('CodeBuddy help lists custom models first', () => {
  const text = '  --model <model>   Model for the current session. Currently supported: (default-model, gpt-5.5,\n   kimi-k3, custom-local:deepseek-v4-pro, custom-local:deepseek-flash)\n  --fallback-model <model>'
  assert.deepEqual(parseHelpModels(text), [
    { id: 'custom-local:deepseek-v4-pro', name: 'deepseek-v4-pro' },
    { id: 'custom-local:deepseek-flash', name: 'deepseek-flash' },
    { id: 'default-model', name: 'default-model' },
    { id: 'gpt-5.5', name: 'gpt-5.5' },
    { id: 'kimi-k3', name: 'kimi-k3' },
  ])
  assert.deepEqual(parseHelpModels('no models here'), [])
})

test('model listings parse to ids and clean names', () => {
  const text = 'Available models\n\nauto - Auto (default)\ngrok-4.7-low-fast - Grok 4.7  Low Fast\u200b\u200b\nclaude-opus-5-5-medium - Claude Opus 5.5 1M (current)\nclaude-fable-5-high - Claude Fable 5 1M (NO ZDR)\n\x1b[2mTip: use --model\x1b[0m\n'
  assert.deepEqual(parseModelList(text), [
    { id: 'auto', name: 'Auto' },
    { id: 'grok-4.7-low-fast', name: 'Grok 4.7 Low Fast' },
    { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 1M' },
    { id: 'claude-fable-5-high', name: 'Claude Fable 5 1M (NO ZDR)' },
  ])
})
