import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * The text of an ACP error response. Agents often answer with a generic
 * `Internal error` and put the cause in `data.message`, which may itself be the
 * upstream API's JSON error body.
 */
export function acpErrorMessage(error) {
  const base = error?.message ?? 'ACP error'
  let detail = error?.data?.message
  if (typeof detail !== 'string' || !detail.trim()) return base
  try {
    const body = JSON.parse(detail)
    detail = body?.error?.message ?? body?.message ?? detail
  } catch {}
  return detail === base ? base : `${base}: ${detail}`
}

/**
 * Minimal ACP (Agent Client Protocol) client over a child process's stdio.
 * Permission requests are answered by `permission` policy without user interaction.
 */
export class AcpClient {
  /**
   * @param {{ argv: string[], cwd: string, env?: NodeJS.ProcessEnv, permission?: 'allow' | 'deny' | (() => 'allow' | 'deny'), onFrame?: (dir: 'in' | 'out', msg: object) => void, onUpdate?: (sessionId: string, update: any) => void, onPermission?: (request: any, optionId: string | undefined) => void }} options
   */
  constructor(options) {
    this.options = options
    this.nextId = 1
    this.pending = new Map()
    this.exited = false
    this.child = spawn(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.stderr = ''
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-8192) })
    this.child.on('exit', (code, signal) => {
      clearTimeout(this.killTimer)
      this.killTimer = undefined
      this.exited = true
      const error = new Error(`agent exited (code ${code}, signal ${signal}): ${this.stderr.trim().slice(-500)}`)
      for (const p of this.pending.values()) p.reject(error)
      this.pending.clear()
    })
    this.child.on('error', (error) => {
      this.exited = true
      for (const p of this.pending.values()) p.reject(error)
      this.pending.clear()
    })
    this.child.stdin.on('error', (error) => {
      this.exited = true
      for (const p of this.pending.values()) p.reject(error)
      this.pending.clear()
      // A process with an unusable input pipe cannot serve further requests.
      this.close()
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line))
  }

  send(msg) {
    this.options.onFrame?.('out', msg)
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  request(method, params) {
    if (this.exited) return Promise.reject(new Error('agent process is not running'))
    const id = this.nextId++
    this.send({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  notify(method, params) {
    if (!this.exited) this.send({ jsonrpc: '2.0', method, params })
  }

  receive(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    this.options.onFrame?.('in', msg)
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (!p) return
      if (msg.error) p.reject(Object.assign(new Error(acpErrorMessage(msg.error)), { acp: msg.error }))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === 'session/update') {
      this.options.onUpdate?.(msg.params.sessionId, msg.params.update)
      return
    }
    if (msg.method === 'session/request_permission') {
      const options = msg.params.options ?? []
      const policy = typeof this.options.permission === 'function' ? this.options.permission() : this.options.permission
      const wanted = policy === 'deny' ? ['reject_once', 'reject_always'] : ['allow_once', 'allow_always']
      const choice = options.find((o) => o.kind === wanted[0]) ?? options.find((o) => o.kind === wanted[1])
      this.options.onPermission?.(msg.params, choice?.optionId)
      const outcome = choice ? { outcome: 'selected', optionId: choice.optionId } : { outcome: 'cancelled' }
      this.send({ jsonrpc: '2.0', id: msg.id, result: { outcome } })
      return
    }
    if (msg.id !== undefined) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by this client` } })
    }
  }

  async initialize() {
    this.init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    return this.init
  }

  close() {
    // `exited` also marks an unusable pipe; only exitCode/signalCode confirm exit.
    if (this.killTimer || this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill()
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
    }, 250)
    this.killTimer.unref()
  }
}
