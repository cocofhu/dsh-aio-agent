import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentBackend, parseCommand, parseHelpModels, parseModelList, provideLaunch, resolveBackend } from '../lib/backends.js'

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
  assert.deepEqual(resolveBackend('codex', { command: 'npx codex-acp' }).argv, ['npx', 'codex-acp'])
  assert.deepEqual(resolveBackend('codex', { command: ['codex-acp', '--debug'] }).argv, ['codex-acp', '--debug'])
})

test('edits reach the next launch through the published source', () => {
  const settings = { command: '', model: '', permission: 'allow' }
  const withdraw = provideLaunch('opencode', () => settings)
  assert.deepEqual(currentBackend('opencode').argv, ['opencode', 'acp'])
  settings.command = '/usr/local/bin/opencode acp'
  settings.permission = 'deny'
  assert.deepEqual(currentBackend('opencode').argv, ['/usr/local/bin/opencode', 'acp'])
  assert.equal(currentBackend('opencode').permission, 'deny')
  withdraw()
  assert.equal(currentBackend('opencode').permission, 'allow')
  assert.deepEqual(currentBackend('opencode').argv, ['opencode', 'acp'])
})

test('Cursor runs each turn in print mode, with models listed by `cursor-agent models`', () => {
  const cursor = resolveBackend('cursor')
  assert.deepEqual(cursor.listArgv, ['cursor-agent', 'models'])
  assert.equal(cursor.defaultModel, 'auto')
  assert.deepEqual(cursor.printArgv({ model: 'claude-opus-5-5-medium', cwd: '/w', resume: 'chat-1', force: true }), [
    'cursor-agent', '--print', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--force',
    '--workspace', '/w', '--model', 'claude-opus-5-5-medium', '--resume', 'chat-1',
  ])
  assert.deepEqual(cursor.printArgv({ model: 'auto' }).slice(-2), ['--model', 'auto'])
  assert.deepEqual(cursor.acpArgv('claude-opus-5-5-medium'), ['cursor-agent', '--model', 'claude-opus-5-5-medium', 'acp'])
  const custom = resolveBackend('cursor', { command: '"/opt/Cursor Agent/cursor-agent" --endpoint x acp', model: 'gpt-5.5-high' })
  assert.equal(custom.defaultModel, 'gpt-5.5-high')
  assert.deepEqual(custom.listArgv, ['/opt/Cursor Agent/cursor-agent', 'models'])
  assert.deepEqual(custom.printArgv({}).slice(0, 4), ['/opt/Cursor Agent/cursor-agent', '--endpoint', 'x', '--print'])
  assert.equal(resolveBackend('opencode').printArgv, undefined)
})

test('CodeBuddy runs each turn in print mode, with models listed by `codebuddy --help`', () => {
  const codebuddy = resolveBackend('codebuddy')
  assert.equal(codebuddy.dialect, 'claude')
  assert.equal(codebuddy.inputIncludesCache, true)
  assert.equal(codebuddy.defaultModel, undefined)
  assert.deepEqual(codebuddy.listArgv, ['codebuddy', '--help'])
  assert.deepEqual(codebuddy.printArgv({ model: 'custom-local:deepseek-v4-pro', cwd: '/w', resume: 's-1', force: true }), [
    'codebuddy', '--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--permission-mode', 'bypassPermissions', '--disallowedTools', 'AskUserQuestion',
    '--model', 'custom-local:deepseek-v4-pro', '--resume', 's-1',
  ])
  assert.deepEqual(codebuddy.printArgv({}).slice(6, 8), ['--permission-mode', 'default'])
  assert.deepEqual(resolveBackend('codebuddy', { command: '/opt/codebuddy --acp --region x' }).printArgv({}).slice(0, 4), ['/opt/codebuddy', '--region', 'x', '--print'])
  assert.deepEqual(resolveBackend('kimi-code').argv, ['kimi', 'acp'])
  assert.equal(resolveBackend('kimi-code').printArgv, undefined)
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

test('Codex marks its unknown-model warning as a notice, not reply text', () => {
  const { notice } = resolveBackend('codex')
  assert.ok(notice.test('Model metadata for `deepseek-v4-pro` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.'))
  assert.ok(!notice.test('The model metadata for this file was not found.'))
  assert.equal(resolveBackend('opencode').notice, undefined)
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
