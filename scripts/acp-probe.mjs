#!/usr/bin/env node
// Drives one ACP prompt turn against an agent CLI and prints every frame as JSONL.
// Usage: node scripts/acp-probe.mjs <cwd> <prompt> -- <agent argv...>
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const sep = process.argv.indexOf('--')
const [cwd, prompt] = process.argv.slice(2, sep)
const argv = process.argv.slice(sep + 1)
const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'inherit'] })

let nextId = 1
const pending = new Map()
const log = (dir, msg) => process.stdout.write(JSON.stringify({ t: Date.now(), dir, msg }) + '\n')

function send(msg) {
  log('out', msg)
  child.stdin.write(JSON.stringify(msg) + '\n')
}
function request(method, params) {
  const id = nextId++
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return log('raw', line) }
  log('in', msg)
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p?.reject(msg.error)
    else p?.resolve(msg.result)
    return
  }
  if (msg.method === 'session/request_permission') {
    const allow = msg.params.options.find((o) => o.kind === 'allow_once') ?? msg.params.options[0]
    send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } })
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } })
  }
})

await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
const { sessionId } = await request('session/new', { cwd, mcpServers: [] })
const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] })
log('done', result)
child.kill()
