/**
 * The `opencode run --format json` event stream, translated into the ACP
 * `session/update` shapes TurnWriter reads. Every line names the session a later
 * turn continues with `--session`; each `step_finish` reports that step's tokens.
 */

const TOOL_KINDS = {
  bash: 'execute',
  read: 'read',
  write: 'edit',
  edit: 'edit',
  patch: 'edit',
  multiedit: 'edit',
  glob: 'search',
  grep: 'search',
  list: 'search',
  webfetch: 'fetch',
  websearch: 'fetch',
}

function outputText(value) {
  if (value == null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Translates events in order. A tool event repeats with each state change of its call. */
export class OpenCodeStream {
  /** @param update - receives each ACP `session/update` payload. */
  constructor(update) {
    this.update = update
    this.sessionId = undefined
    this.result = undefined
    this.errors = []
    this.tools = new Set()
    this.tokens = undefined
  }

  recordable() {
    return true
  }

  tool(part) {
    const id = part.callID || part.id
    if (!id) return
    const state = part.state ?? {}
    const input = state.input && typeof state.input === 'object' ? state.input : {}
    const kind = TOOL_KINDS[String(part.tool ?? '').toLowerCase()] ?? 'other'
    const path = input.filePath ?? input.file_path ?? input.path
    if (!this.tools.has(id)) {
      this.tools.add(id)
      this.update({
        sessionUpdate: 'tool_call',
        toolCallId: id,
        kind,
        title: kind === 'execute' && typeof input.command === 'string' ? input.command : state.title || (typeof path === 'string' ? `${part.tool} ${path}` : part.tool || 'tool'),
        rawInput: input,
        ...(typeof path === 'string' ? { locations: [{ path }] } : {}),
        status: 'in_progress',
      })
    }
    if (state.status !== 'completed' && state.status !== 'error' && state.status !== 'failed') return
    const failed = state.status !== 'completed'
    const update = { sessionUpdate: 'tool_call_update', toolCallId: id, rawInput: input, status: failed ? 'failed' : 'completed' }
    const text = failed ? outputText(state.error) || outputText(state.output) : outputText(state.output)
    if (kind === 'execute' && !failed) update.rawOutput = { stdout: text, stderr: '', exitCode: state.metadata?.exit ?? null }
    else update.content = [{ type: 'content', content: { type: 'text', text: text || (failed ? 'failed' : 'done') } }]
    this.update(update)
  }

  /** @param event - one parsed event line. */
  push(event) {
    if (typeof event?.sessionID === 'string') this.sessionId = event.sessionID
    const part = event?.part ?? {}
    switch (event?.type) {
      case 'text':
        if (!part.text) break
        if (part.type === 'reasoning') this.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part.text } })
        else this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part.text } })
        break
      case 'reasoning':
        if (part.text) this.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part.text } })
        break
      case 'tool_use':
        this.tool(part)
        break
      case 'error': {
        const message = event.error?.data?.message || event.error?.name || 'OpenCode reported an error'
        this.errors.push(message)
        break
      }
      case 'step_finish': {
        const t = part.tokens
        if (t && typeof t === 'object') {
          const n = (v) => (Number.isFinite(v) ? v : 0)
          const sum = this.tokens ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
          sum.inputTokens += n(t.input)
          sum.outputTokens += n(t.output)
          sum.cacheReadTokens += n(t.cache?.read)
          sum.cacheWriteTokens += n(t.cache?.write)
          sum.reasoningTokens += n(t.reasoning)
          this.tokens = sum
        }
        // A step that ends needing another tool round is not terminal.
        if (part.reason !== 'tool-calls') this.result = event
        break
      }
      default:
        break
    }
  }

  /** Why the turn failed, or undefined when it did not. */
  failure() {
    if (this.errors.length > 0) return this.errors.at(-1)
  }

  /** Token usage of the whole turn in DSH's shape, summed over its steps. */
  usage() {
    return this.tokens && { ...this.tokens }
  }
}
