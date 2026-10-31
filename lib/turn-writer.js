import { randomUUID } from 'node:crypto'
import { AssistantStreamAccumulator, BlockAssembler } from '@deepseek-ai/dsh-llm'

const DONE = new Set(['completed', 'failed'])
/**
 * Paced text is released at a steady PACE_CPS characters per second, sped up only so that
 * the backlog never takes longer than PACE_CATCHUP_MS to drain.
 */
const PACE_MS = 16
const PACE_CPS = 400
const PACE_CATCHUP_MS = 1500
const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization|cookie)/i
const RESULT_TEXT_LIMIT = 64 * 1024

/** Redact credential-looking values before a raw frame enters the audit log. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '[redacted]' : redact(v)
    return out
  }
  return value
}

function freezeMessage(message) {
  return Object.freeze({ ...message, id: randomUUID() })
}

function toolResultText(tool) {
  const parts = []
  const out = tool.rawOutput
  if (out && typeof out === 'object') {
    if (typeof out.stdout === 'string' && out.stdout) parts.push(out.stdout)
    if (typeof out.stderr === 'string' && out.stderr) parts.push(`[stderr]\n${out.stderr}`)
    if (typeof out.content === 'string') parts.push(out.content)
  }
  for (const item of tool.content ?? []) {
    if (item.type === 'diff') parts.push(`--- ${item.path}\n${item.oldText ?? ''}\n+++ ${item.path}\n${item.newText ?? ''}`)
    else if (item.type === 'content' && item.content?.type === 'text') parts.push(item.content.text)
  }
  if (parts.length === 0 && out !== undefined) parts.push(JSON.stringify(out))
  let text = parts.join('\n') || (tool.status === 'failed' ? 'failed' : 'done')
  if (text.length > RESULT_TEXT_LIMIT) text = `${text.slice(0, RESULT_TEXT_LIMIT)}\n…[truncated]`
  const exitCode = out && typeof out === 'object' ? out.exitCode : undefined
  // Native shell cards parse this trailing marker (`@deepseek-ai/dsh-shell/render`).
  if (tool.kind === 'execute' && exitCode !== undefined) text += `\n[exit code: ${exitCode ?? 'null'}]`
  return text
}

const DIFF_OLD_HEADER = /^-{2,3} (?:a\/)?(\S+)(?:\n|$)/
const DIFF_NEW_HEADER = /^\+{2,3} (?:b\/)?(\S+)(?:\n|$)/

/** Cursor leaks unified-diff headers into ACP diff text for new files; drop them. */
function normalizeDiff(diff) {
  const oldText = diff.oldText ?? null
  const newText = diff.newText ?? ''
  const oldHeader = oldText === null ? null : DIFF_OLD_HEADER.exec(oldText)
  const newHeader = DIFF_NEW_HEADER.exec(newText)
  if (!oldHeader || newHeader?.[1] !== diff.path) return { path: diff.path, oldText, newText }
  const created = oldHeader[1] === '/dev/null' && oldText.length === oldHeader[0].length
  return { path: diff.path, oldText: created ? null : oldText.slice(oldHeader[0].length), newText: newText.slice(newHeader[0].length) }
}

function diffsOf(tool) {
  const diffs = (tool.content ?? []).filter((c) => c.type === 'diff').map(normalizeDiff)
  if (diffs.length > 0 || tool.kind !== 'edit') return diffs
  const input = tool.rawInput ?? {}
  const path = firstPath(tool)
  if (typeof path !== 'string') return diffs
  if (typeof input.content === 'string') return [{ path, oldText: null, newText: input.content }]
  const oldText = input.old_string ?? input.oldString
  const newText = input.new_string ?? input.newString
  if (typeof oldText === 'string' && typeof newText === 'string') return [{ path, oldText, newText }]
  return diffs
}

function firstPath(tool) {
  const input = tool.rawInput ?? {}
  return tool.locations?.[0]?.path ?? input.file_path ?? input.filePath ?? input.path
}

/**
 * Map one ACP tool call onto the call shape of a native DSH tool so the stock
 * tool cards render it; kinds without a native counterpart keep an `aio_` name.
 */
function nativeCall(tool) {
  const input = tool.rawInput ?? {}
  const description = tool.title || tool.kind || 'tool'
  switch (tool.kind) {
    case 'execute': {
      const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : description
      return { name: 'bash', args: { command, description } }
    }
    case 'edit': {
      const [diff] = diffsOf(tool)
      const file_path = diff?.path ?? firstPath(tool)
      if (diff && diff.oldText === null) return { name: 'write', args: { file_path, content: diff.newText } }
      if (diff) return { name: 'edit', args: { file_path, old_string: diff.oldText, new_string: diff.newText } }
      return { name: 'edit', args: { file_path, description } }
    }
    case 'read':
      return { name: 'read', args: { file_path: firstPath(tool), description } }
    default:
      return { name: `aio_${tool.kind ?? 'other'}`, args: { description, ...input, ...(tool.locations ? { locations: tool.locations } : {}) } }
  }
}

function nativeMeta(tool, cwd) {
  const meta = {}
  if (tool.kind === 'execute' && cwd) meta.cwd = cwd
  const diffs = diffsOf(tool)
  if (tool.kind === 'edit' && diffs.length > 0) {
    meta.path = diffs[0].path
    meta.diffs = diffs
  }
  return meta
}

/**
 * Converts one ACP prompt turn into the step events the DSH agent loop writes inside
 * a turn it has opened: user/message, then per step: step/start, assistant/message
 * (text, reasoning and tool-call blocks), tool/call, tool/result, step/end.
 * A step closes when the agent produces text again after tool calls; its events are
 * committed once all of its tool calls have settled, so results always follow calls.
 *
 * Each step is also one live Assistant attempt on `agent/assistant-stream`, framed
 * as the loop frames a model attempt: text and reasoning stream as they arrive, a
 * tool call joins the stream once its arguments are final, and the end frame names
 * the committed `assistant/message`. A step that starts while an earlier one still
 * waits on a tool buffers its chunks and streams them once that step commits.
 */
export class TurnWriter {
  /**
   * @param {{ session: any, turn: number, provider: string, model: string, cwd?: string, pace?: boolean, live?: { emit: (frame: object) => void, nextRevision: () => number, nextAttemptId: () => string } }} options
   *   `pace` releases text and reasoning at an even rate: agent CLIs deliver them in
   *   bursts, or as whole messages, which would otherwise render in jumps.
   */
  constructor(options) {
    this.session = options.session
    this.turn = options.turn
    this.provider = options.provider
    this.model = options.model
    this.cwd = options.cwd
    this.live = options.live
    this.pace = options.pace === true
    this.usage = undefined
    this.step = 0
    this.steps = []
    this.tools = new Map()
    this.queue = []
    this.timer = undefined
    this.drained = []
    this.pacedAt = undefined
    this.credit = 0
  }

  /** Record the inbox messages the loop claimed for this turn, unchanged so composer echoes retire. */
  admit(messages) {
    for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
  }

  current() {
    let step = this.steps.at(-1)
    if (!step || step.closed) {
      step = { blocks: [], toolIds: [], closed: false, open: undefined, opened: false, buffered: [], chunks: 0, accumulator: new AssistantStreamAccumulator(), assembler: new BlockAssembler() }
      this.steps.push(step)
      if (this.steps.length === 1) this.open(step)
    }
    return step
  }

  /** Give the step its number, append its start, and stream what it buffered. */
  open(step) {
    step.opened = true
    step.number = ++this.step
    this.session.append('step/start', { turn: this.turn, step: step.number })
    if (this.live) {
      step.attemptId = this.live.nextAttemptId()
      this.frame({ type: 'start', attemptId: step.attemptId, revision: this.live.nextRevision(), turn: this.turn, step: step.number })
    }
    for (const { time, chunk } of step.buffered.splice(0)) this.push(step, chunk, time)
  }

  frame(frame) {
    try {
      this.live.emit(frame)
    } catch (error) {
      console.warn('[dsh-aio-agent] assistant stream listener failed:', error)
    }
  }

  push(step, chunk, time = Date.now()) {
    if (!step.opened) {
      step.buffered.push({ time, chunk })
      return
    }
    const timed = step.accumulator.push({ time, chunk })
    step.assembler.push(timed.chunk)
    if (this.live) this.frame({ type: 'chunk', attemptId: step.attemptId, revision: this.live.nextRevision(), index: step.chunks++, time: timed.time, chunk: timed.chunk })
  }

  /** Close the step's streaming text or reasoning block. */
  endBlock(step, time) {
    const block = step.open
    if (!block) return
    step.open = undefined
    this.push(step, { type: 'block-end', index: block.index, block: { type: block.type, text: block.text } }, time)
  }

  /** Append a text or reasoning delta to the open step, starting a new step after tool calls. */
  delta(kind, text, time) {
    let step = this.current()
    if (step.toolIds.length > 0) {
      step.closed = true
      step = this.current()
    }
    if (step.open?.type !== kind) {
      this.endBlock(step, time)
      step.open = { type: kind, text: '', index: step.blocks.length }
      step.blocks.push(step.open)
      this.push(step, { type: 'block-start', index: step.open.index, blockType: kind }, time)
    }
    step.open.text += text
    this.push(step, { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: step.open.index, text }, time)
  }

  toolCall(update, time) {
    const step = this.current()
    this.endBlock(step, time)
    const tool = { ...update, status: update.status ?? 'pending', time, index: step.blocks.length }
    this.tools.set(update.toolCallId, tool)
    step.toolIds.push(update.toolCallId)
    step.blocks.push({ type: 'tool-call', id: update.toolCallId, index: tool.index })
  }

  toolUpdate(update) {
    const tool = this.tools.get(update.toolCallId)
    if (!tool) return this.toolCall(update, Date.now())
    for (const [k, v] of Object.entries(update)) if (v !== undefined && k !== 'sessionUpdate') tool[k] = v
  }

  /** Handle one ACP `session/update` payload, in order behind any text still being paced. */
  update(update) {
    if (!this.pace) return this.apply(update)
    const paced = (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') && update.content?.type === 'text' && update.content.text
    if (!paced && this.queue.length === 0) return this.apply(update)
    this.queue.push(paced ? { update, chars: Array.from(update.content.text) } : { update })
    if (this.timer === undefined) this.tick()
  }

  /** Release this tick's share of the paced backlog, and every update queued behind it. */
  tick() {
    this.timer = undefined
    const now = Date.now()
    const backlog = this.queue.reduce((n, item) => n + (item.chars?.length ?? 0), 0)
    const rate = Math.max(PACE_CPS, (backlog * 1000) / PACE_CATCHUP_MS)
    this.credit += (rate * (this.pacedAt === undefined ? PACE_MS : now - this.pacedAt)) / 1000
    this.pacedAt = now
    let budget = Math.floor(this.credit)
    this.credit -= budget
    while (this.queue.length > 0) {
      const item = this.queue[0]
      if (!item.chars) {
        this.queue.shift()
        this.apply(item.update)
        continue
      }
      if (budget === 0) break
      const taken = item.chars.splice(0, budget)
      budget -= taken.length
      const text = taken.join('')
      if (item.chars.length === 0) this.queue.shift()
      this.apply({ ...item.update, content: { ...item.update.content, text } })
    }
    if (this.queue.length > 0) return void (this.timer = setTimeout(() => this.tick(), PACE_MS))
    this.pacedAt = undefined
    this.credit = 0
    for (const resolve of this.drained.splice(0)) resolve()
  }

  /** @returns resolves once paced text has all been released. */
  drain() {
    if (this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.drained.push(resolve))
  }

  /** Release everything still paced at once. */
  flushPaced() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.pacedAt = undefined
    this.credit = 0
    for (const item of this.queue.splice(0)) this.apply(item.chars ? { ...item.update, content: { ...item.update.content, text: item.chars.join('') } } : item.update)
    for (const resolve of this.drained.splice(0)) resolve()
  }

  apply(update) {
    const time = Date.now()
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content?.type === 'text' && update.content.text) this.delta('text', update.content.text, time)
        break
      case 'agent_thought_chunk':
        if (update.content?.type === 'text' && update.content.text) this.delta('reasoning', update.content.text, time)
        break
      case 'tool_call':
        this.toolCall(update, time)
        break
      case 'tool_call_update':
        this.toolUpdate(update)
        break
      default:
        break
    }
    this.flush(false)
  }

  /** Commit leading closed steps whose tool calls have all settled; `final` forces the rest. */
  flush(final) {
    while (this.steps.length > 0) {
      const step = this.steps[0]
      if (!final && !step.closed) return
      const settled = step.toolIds.every((id) => DONE.has(this.tools.get(id).status))
      if (!final && !settled) return
      this.steps.shift()
      this.commitStep(step, final && this.steps.length === 0 ? this.usage : undefined)
      if (this.steps[0] && !this.steps[0].opened) this.open(this.steps[0])
    }
  }

  /** @param usage - token usage of the whole turn, recorded on its last step as a model attempt records its own. */
  commitStep(step, usage) {
    const { turn } = this
    const stepNo = step.number
    let committed = false
    try {
      const time = Date.now()
      this.endBlock(step, time)
      for (const block of step.blocks) {
        if (block.type !== 'tool-call') continue
        const native = nativeCall(this.tools.get(block.id))
        const call = { type: 'tool-call', id: block.id, name: native.name, arguments: JSON.stringify(native.args) }
        this.push(step, { type: 'block-start', index: block.index, blockType: 'tool-call' }, time)
        this.push(step, { type: 'tool-call-delta', index: block.index, id: call.id, name: call.name, argumentsDelta: call.arguments }, time)
        this.push(step, { type: 'block-end', index: block.index, block: call }, time)
      }
      if (usage) this.push(step, { type: 'usage', usage }, time)
      this.push(step, { type: 'finish', reason: { kind: step.toolIds.length > 0 ? 'tool-calls' : 'stop' } }, time)
      const content = step.assembler.blocks()
      const message = freezeMessage({ role: 'assistant', content, source: { kind: 'model', provider: this.provider, model: this.model } })
      const data = { turn, step: stepNo, message, stream: [...step.accumulator.snapshot()], ...(usage ? { usage } : {}) }
      const { seq } = this.session.append('assistant/message', data, { surfaceOp: 'append' })
      committed = true
      if (this.live) this.frame({ type: 'end', attemptId: step.attemptId, revision: this.live.nextRevision(), index: step.chunks, outcome: { kind: 'committed', eventType: 'assistant/message', seq } })
      this.commitTools(stepNo, content)
    } finally {
      if (!committed && this.live) this.frame({ type: 'end', attemptId: step.attemptId, revision: this.live.nextRevision(), index: step.chunks, outcome: { kind: 'abandoned' } })
      this.session.append('step/end', { turn, step: stepNo })
    }
  }

  commitTools(stepNo, content) {
    const { turn } = this
    for (const block of content) {
      if (block.type !== 'tool-call') continue
      const tool = this.tools.get(block.id)
      const callSeq = this.session.append('tool/call', { turn, step: stepNo, callId: block.id, name: block.name, arguments: block.arguments }).seq
      const isError = tool.status !== 'completed'
      const result = freezeMessage({
        role: 'tool',
        source: { kind: 'tool', callId: block.id },
        toolCallId: block.id,
        content: [{ type: 'text', text: DONE.has(tool.status) ? toolResultText(tool) : 'tool call did not settle before the turn ended' }],
        isError,
      })
      const meta = redact({ ...nativeMeta(tool, this.cwd), aio: { kind: tool.kind, title: tool.title, status: tool.status, rawInput: tool.rawInput, rawOutput: tool.rawOutput, content: tool.content, locations: tool.locations } })
      this.session.append('tool/result', {
        turn,
        step: stepNo,
        message: result,
        ...(isError ? { error: { name: 'AioToolError', code: tool.status === 'failed' ? 'AIO_TOOL_FAILED' : 'AIO_TOOL_UNSETTLED' } } : {}),
        meta: JSON.parse(JSON.stringify(meta)),
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    }
  }

  /** Commit every remaining step; the loop records the turn end. Await `drain()` first to keep the pacing. */
  finish() {
    this.flushPaced()
    for (const step of this.steps) step.closed = true
    this.flush(true)
  }
}
