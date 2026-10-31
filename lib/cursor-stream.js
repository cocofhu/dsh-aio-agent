/**
 * Cursor Agent's `--print --output-format stream-json --stream-partial-output`
 * transcript, translated into the ACP `session/update` shapes TurnWriter reads.
 * Unlike its ACP mode, this transcript reports token usage, in the final `result`.
 */

const TOOL_KINDS = {
  shellToolCall: 'execute',
  readToolCall: 'read',
  editToolCall: 'edit',
  deleteToolCall: 'delete',
  grepToolCall: 'search',
  globToolCall: 'search',
  lsToolCall: 'search',
  semSearchToolCall: 'search',
  webSearchToolCall: 'fetch',
  webFetchToolCall: 'fetch',
}

/** Bookkeeping Cursor adds to tool args: shell parse trees, approval flags. */
const ARG_NOISE = new Set([
  'toolCallId', 'parsingResult', 'simpleCommands', 'hasInputRedirect', 'hasOutputRedirect',
  'fileOutputThresholdBytes', 'skipApproval', 'smartModeApprovalOnly', 'isBackground', 'requestedSandboxPolicy',
  'timeoutBehavior', 'hardTimeout', 'closeStdin', 'conversationId', 'requestId', 'adminCommandDenylist', 'description',
])

/** `readLints` → `Read lints`. */
function title(kind) {
  const words = kind.replace(/([A-Z])/g, ' $1').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function trimArgs(args) {
  if (!args || typeof args !== 'object') return args
  const out = {}
  for (const [k, v] of Object.entries(args)) if (!ARG_NOISE.has(k) && v !== '' && v !== null) out[k] = v
  return out
}

/** Readable text of a tool result payload, preferring its human-readable fields. */
function resultText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((block) => (typeof block?.text === 'string' ? block.text : block?.text?.text ?? '')).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    const parts = []
    for (const key of ['output', 'content', 'message', 'markdown', 'text', 'error']) {
      const text = resultText(value[key])
      if (text.trim()) parts.push(text)
    }
    return parts.length > 0 ? parts.join('\n') : JSON.stringify(value)
  }
  return ''
}

/** The single `*ToolCall` entry of a tool event; sibling keys describe the call, not the tool. */
function toolEntry(call) {
  for (const [key, body] of Object.entries(call ?? {})) if (key === 'function' || key.endsWith('ToolCall')) return [key, body ?? {}]
  return []
}

/**
 * Map one `tool_call` event onto an ACP tool call or tool call update.
 * @returns the update, or undefined for an event without a tool.
 */
export function toolUpdate(event) {
  const [key, body] = toolEntry(event.tool_call)
  if (key === undefined) return
  const toolCallId = event.call_id || body.toolCallId || event.tool_call?.toolCallId
  if (!toolCallId) return
  const args = body.args ?? {}
  let kind = TOOL_KINDS[key] ?? 'other'
  let name = title(key.replace(/ToolCall$/, ''))
  let rawInput = trimArgs(args)
  if (key === 'mcpToolCall') {
    name = args.toolName ?? args.name ?? 'MCP'
    rawInput = args.args ?? {}
  } else if (key === 'function') {
    name = body.name ?? 'Function'
    rawInput = typeof body.arguments === 'string' ? { arguments: body.arguments } : body.arguments
  }
  const path = args.path ?? args.filePath
  const update = {
    sessionUpdate: event.subtype === 'completed' ? 'tool_call_update' : 'tool_call',
    toolCallId,
    kind,
    title: kind === 'execute' && typeof args.command === 'string' ? args.command : path ? `${name} ${path}` : name,
    rawInput,
    ...(typeof path === 'string' ? { locations: [{ path }] } : {}),
    status: event.subtype === 'completed' ? 'completed' : 'in_progress',
  }
  if (event.subtype !== 'completed') return update
  const result = body.result
  if (typeof result === 'string') {
    update.status = result === 'rejected' ? 'failed' : 'completed'
    update.content = [{ type: 'content', content: { type: 'text', text: result } }]
    return update
  }
  const failure = result?.error ?? result?.failure ?? result?.rejected
  const outcome = failure ?? result?.success ?? result
  if (failure !== undefined) update.status = 'failed'
  if (kind === 'execute') {
    update.rawOutput = { stdout: outcome?.stdout ?? '', stderr: outcome?.stderr ?? '', exitCode: outcome?.exitCode ?? null }
  } else if (kind === 'edit' && typeof outcome?.afterFullFileContent === 'string') {
    update.content = [{ type: 'diff', path: outcome.path ?? path, oldText: outcome.beforeFullFileContent ?? null, newText: outcome.afterFullFileContent }]
    update.rawOutput = { content: outcome.message ?? '' }
  } else if (kind === 'read' && typeof outcome?.content === 'string') {
    update.rawOutput = { content: outcome.content }
  } else {
    const text = failure !== undefined && typeof failure !== 'object' ? String(failure) : resultText(outcome ?? '')
    update.content = [{ type: 'content', content: { type: 'text', text: text || (failure !== undefined ? 'failed' : 'done') } }]
  }
  return update
}

/**
 * Translates transcript lines in order. Partial output streams each text delta
 * as its own `assistant` event, then repeats the whole message once it ends; the
 * repeat only contributes text the deltas did not already carry.
 */
export class CursorStream {
  /** @param update - receives each ACP `session/update` payload. */
  constructor(update) {
    this.update = update
    this.streamed = ''
    this.sessionId = undefined
    this.result = undefined
  }

  /** @param event - one parsed transcript line. */
  push(event) {
    if (typeof event?.session_id === 'string') this.sessionId = event.session_id
    switch (event?.type) {
      case 'thinking':
        if (event.text) this.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.text } })
        break
      case 'assistant': {
        const text = (event.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (!text) break
        const delta = event.timestamp_ms !== undefined && event.model_call_id === undefined
        let fresh = text
        if (delta) this.streamed += text
        else {
          fresh = text.startsWith(this.streamed) ? text.slice(this.streamed.length) : text
          this.streamed = ''
        }
        if (fresh) this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: fresh } })
        break
      }
      case 'tool_call': {
        this.streamed = ''
        const update = toolUpdate(event)
        if (update) this.update(update)
        break
      }
      case 'result':
        this.result = event
        break
      default:
        break
    }
  }

  /** Whether the line belongs in the session log; text deltas are recorded once, in the whole message that repeats them. */
  recordable(event) {
    return !(event?.type === 'assistant' || event?.type === 'thinking') || event.timestamp_ms === undefined
  }

  /** Why the turn failed, or undefined when it did not. */
  failure() {
    if (this.result?.is_error) return this.result.result || 'turn failed'
  }

  /** Token usage of the whole turn in DSH's shape, if the CLI reported it. */
  usage() {
    const u = this.result?.usage
    if (!u || typeof u !== 'object') return
    const n = (v) => (Number.isFinite(v) ? v : 0)
    return {
      inputTokens: n(u.inputTokens ?? u.input_tokens),
      outputTokens: n(u.outputTokens ?? u.output_tokens),
      cacheReadTokens: n(u.cacheReadTokens ?? u.cache_read_input_tokens),
      cacheWriteTokens: n(u.cacheWriteTokens ?? u.cache_creation_input_tokens),
    }
  }
}
