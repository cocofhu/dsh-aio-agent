import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentBackend, parseCommand, provideLaunch, resolveBackend } from '../lib/backends.js'

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
