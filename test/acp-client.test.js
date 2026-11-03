import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { acpErrorMessage } from '../lib/acp-client.js'

test('an ACP error keeps the cause the agent put in data.message', () => {
  const body = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.", code: 'model_not_found' } })
  assert.equal(acpErrorMessage({ code: -32603, message: 'Internal error', data: { message: body, codex_error_info: 'other' } }),
    "Internal error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.")
  assert.equal(acpErrorMessage({ code: -32603, message: 'Internal error', data: { message: 'rate limited' } }), 'Internal error: rate limited')
  assert.equal(acpErrorMessage({ code: -32000, message: 'Authentication required' }), 'Authentication required')
  assert.equal(acpErrorMessage({ message: 'same', data: { message: 'same' } }), 'same')
  assert.equal(acpErrorMessage({}), 'ACP error')
})

for (const mode of ['remote-close', 'stream-error', 'remote-close-ignore-term']) {
  test(`a broken agent input (${mode}) rejects pending requests without crashing the host`, { skip: mode.startsWith('remote-close') && process.platform === 'win32' ? 'Closing fd 0 does not close the Windows pipe' : false }, () => {
    // Isolate the host so an unhandled pipe error is observed as a failed exit.
    const script = `
      import assert from 'node:assert/strict'
      import { AcpClient } from ${JSON.stringify(new URL('../lib/acp-client.js', import.meta.url).href)}
      const mode = ${JSON.stringify(mode)}
      // This deadline also runs if an unhandled error crashes the host.
      const agent = "setTimeout(() => process.exit(0), 8000); "
        + (mode === 'remote-close-ignore-term' ? "process.on('SIGTERM', () => {}); " : "")
        + (mode.startsWith('remote-close') ? "import { closeSync } from 'node:fs'; closeSync(0); " : "")
        + "console.log(JSON.stringify({method:'ready'})); setInterval(() => {}, 1000)"
      let ready
      const started = new Promise(resolve => { ready = resolve })
      const client = new AcpClient({ argv: [process.execPath, '--input-type=module', '-e', agent],
        onFrame(dir, msg) { if (dir === 'in' && msg.method === 'ready') ready() } })
      const stopped = new Promise(resolve => client.child.once('exit', (code, signal) => resolve({ code, signal })))
      const deadline = setTimeout(() => { client.child.kill('SIGKILL'); process.exit(2) }, 5000)
      try {
        await started
        const first = client.request('session/prompt', {text: 'x'.repeat(1024 * 1024)})
        const second = client.request('session/prompt', {text: 'second'})
        if (mode === 'stream-error') client.child.stdin.destroy(Object.assign(new Error('input pipe failed'), {code: 'EPIPE'}))
        const results = await Promise.allSettled([first, second])
        assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected'])
        assert.ok(results.every(result => result.reason.code === 'EPIPE'))
        assert.equal(client.pending.size, 0)
        const exit = await stopped
        if (mode === 'remote-close-ignore-term') assert.equal(exit.signal, 'SIGKILL')
        await assert.rejects(client.request('session/new', {}), /not running/)
      } finally {
        clearTimeout(deadline)
        client.close()
        client.child.kill('SIGKILL')
      }
    `
    const host = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 })
    assert.equal(host.status, 0, host.stderr || String(host.error))
  })
}
