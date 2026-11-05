import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flag = (name) => args[args.indexOf(name) + 1]
const dialect = flag('--mock-dialect')
const mode = flag('--mock-mode')
const log = (entry) => appendFileSync('calls.jsonl', JSON.stringify({ pid: process.pid, ...entry }) + '\n')
const emit = (entry) => console.log(JSON.stringify(entry))
const resumeAt = args.indexOf('--resume') >= 0 ? args.indexOf('--resume') : args.indexOf('--session') >= 0 ? args.indexOf('--session') : args.indexOf('resume')
const resume = resumeAt >= 0 ? args[resumeAt + 1] : undefined
const sessionId = resume ?? '11111111-1111-1111-1111-111111111111'

function text(text) {
  if (dialect === 'open-code') emit({ type: 'text', sessionID: sessionId, part: { text } })
  else if (dialect === 'codex') emit({ type: 'item.completed', item: { type: 'agent_message', text } })
  else emit({ type: 'assistant', session_id: sessionId, message: { id: `m-${process.pid}`, content: [{ type: 'text', text }] } })
}

function result(failed = false) {
  if (dialect === 'codex') emit({ type: failed ? 'turn.failed' : 'turn.completed', error: failed ? { message: 'mock failure' } : undefined })
  else if (dialect === 'open-code') emit(failed ? { type: 'error', error: { data: { message: 'mock failure' } } } : { type: 'step_finish', part: { reason: 'stop' } })
  else emit({ type: 'result', session_id: sessionId, is_error: failed, result: failed ? 'mock failure' : 'ok' })
}

function hold(prompt) {
  if (prompt.includes('ignore-term')) process.on('SIGTERM', () => {})
  if (prompt.includes('tree')) {
    const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('worker-ready', 'ready'); console.log(JSON.stringify({type:'worker-ready'})); setInterval(() => {}, 1000)"], { detached: prompt.includes('detached-tree'), stdio: prompt.includes('quiet-tree') ? 'ignore' : ['ignore', 'inherit', 'inherit'] })
    writeFileSync('worker.pid', String(worker.pid))
  }
  setInterval(() => {}, 1000)
}

if (dialect === 'acp') {
  let pending
  log({ method: 'start' })
  createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line)
    log({ method: msg.method, params: msg.params })
    const reply = (result) => emit({ jsonrpc: '2.0', id: msg.id, result })
    if (msg.method === 'initialize') {
      if (mode !== 'slow-init') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } })
    } else if (msg.method === 'session/new' || msg.method === 'session/load') reply({ sessionId, models: { currentModelId: 'base', availableModels: [{ modelId: 'base', name: 'Base' }, { modelId: 'other', name: 'Other' }] } })
    else if (msg.method === 'session/set_model' || msg.method === 'session/set_config_option') {
      if (mode !== 'slow-model') reply({})
    } else if (msg.method === 'session/prompt') {
      pending = msg.id
      const prompt = msg.params.prompt.map((part) => part.text ?? '').join('\n')
      emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `reply:${prompt}` } } } })
      if (!prompt.includes('hold')) { reply({ stopReason: 'end_turn' }); pending = undefined }
    } else if (msg.method === 'session/cancel' && mode !== 'ignore-cancel' && pending !== undefined) {
      emit({ jsonrpc: '2.0', id: pending, result: { stopReason: 'cancelled' } })
      pending = undefined
    }
  })
} else {
  let input = ''
  process.stdin.setEncoding('utf8').on('data', (chunk) => { input += chunk })
  process.stdin.on('end', () => {
    const prompt = dialect === 'claude' ? JSON.parse(input).message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : dialect === 'cursor' ? input : args.at(-1)
    log({ prompt, resume, args })
    if (dialect === 'codex') emit({ type: 'thread.started', thread_id: sessionId })
    else if (dialect === 'open-code') emit({ type: 'step_start', sessionID: sessionId })
    else emit({ type: 'system', session_id: sessionId })
    text(`reply:${prompt}`)
    if (prompt.includes('hold')) hold(prompt)
    else setTimeout(() => { result(prompt.includes('fail')); process.exit(prompt.includes('fail') ? 1 : 0) }, 100)
  })
}
