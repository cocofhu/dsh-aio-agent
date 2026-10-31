/**
 * The `codex exec --json` thread transcript, translated into the ACP
 * `session/update` shapes TurnWriter reads. `thread.started` names the thread a
 * later turn resumes with `codex exec resume <id>`; `turn.completed` carries the
 * turn's token usage.
 */

const TOOL_KINDS = {
  command_execution: 'execute',
  mcp_tool_call: 'other',
  file_change: 'edit',
  web_search: 'fetch',
  collab_tool_call: 'other',
}

/** Codex reports a model outside its catalog this way, then runs it on fallback metadata. */
const FALLBACK_METADATA = /^Model metadata for `[^`]+` not found\. Defaulting to fallback metadata\b/

const AUTH_REJECTED = [
  'not logged in', 'please log in', 'please login',
  'failed to refresh', 'could not refresh', "couldn't refresh", 'unable to refresh',
  'invalid_grant', 're-authenticate', 'reauthenticate',
  'authentication required', 'authentication failed', 'login required', 'missing bearer',
]

/** Whether a Codex error means its ChatGPT login is missing or can no longer be refreshed. */
export function codexAuthRejected(text) {
  const s = String(text ?? '').toLowerCase()
  if (!s) return false
  if (AUTH_REJECTED.some((p) => s.includes(p))) return true
  return s.includes('401 unauthorized') && s.includes('api.openai.com')
}

function toolTitle(item) {
  switch (item.type) {
    case 'command_execution':
      if (item.command) return item.command
      break
    case 'mcp_tool_call':
      if (item.server && item.tool) return `${item.server}/${item.tool}`
      if (item.tool) return item.tool
      break
    case 'web_search':
      if (item.query) return item.query
      break
    case 'file_change':
      return item.changes?.[0]?.path || 'file_change'
  }
  return item.command || item.type
}

function toolCall(item) {
  const paths = (item.changes ?? []).map((c) => c?.path).filter((p) => typeof p === 'string' && p)
  return {
    sessionUpdate: 'tool_call',
    toolCallId: item.id,
    kind: TOOL_KINDS[item.type] ?? 'other',
    title: toolTitle(item),
    rawInput: item.type === 'command_execution' ? { command: item.command } : item.type === 'web_search' ? { query: item.query } : item.type === 'mcp_tool_call' ? (item.arguments ?? {}) : {},
    ...(paths.length > 0 ? { locations: paths.map((path) => ({ path })) } : {}),
    status: 'in_progress',
  }
}

function toolResult(item) {
  const failed = ['failed', 'declined'].includes(String(item.status ?? '').toLowerCase())
  const update = { sessionUpdate: 'tool_call_update', toolCallId: item.id, status: failed ? 'failed' : 'completed' }
  if (item.type === 'command_execution') {
    update.rawOutput = { stdout: item.aggregated_output ?? '', stderr: '', exitCode: item.exit_code ?? null }
    return update
  }
  let text = item.aggregated_output || item.error?.message || ''
  if (!text && item.type === 'file_change') text = (item.changes ?? []).map((c) => c?.path).filter(Boolean).join('\n')
  if (!text && item.type === 'mcp_tool_call') text = blockText(item.result?.content)
  update.content = [{ type: 'content', content: { type: 'text', text: text || (failed ? 'failed' : 'done') } }]
  return update
}

function blockText(content) {
  if (!Array.isArray(content)) return ''
  return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
}

/** Translates thread events in order; also reads the legacy `{ msg: { type } }` envelope. */
export class CodexStream {
  /** @param update - receives each ACP `session/update` payload. */
  constructor(update) {
    this.update = update
    this.sessionId = undefined
    this.result = undefined
    this.errors = []
    this.tools = new Set()
    this.turnUsage = undefined
  }

  recordable() {
    return true
  }

  text(text) {
    if (text) this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  }

  thought(text) {
    if (text) this.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
  }

  error(message) {
    if (!message || FALLBACK_METADATA.test(message)) return
    this.errors.push(message)
  }

  startTool(item) {
    if (!item.id || this.tools.has(item.id)) return
    this.tools.add(item.id)
    this.update(toolCall(item))
  }

  /** @param event - one parsed transcript line. */
  push(event) {
    if (event?.msg && typeof event.msg === 'object') return this.legacy(event)
    switch (event?.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string') this.sessionId = event.thread_id
        break
      case 'turn.completed':
        this.result = event
        this.turnUsage = event.usage
        break
      case 'turn.failed':
        this.result = event
        this.error(event.error?.message || event.message)
        break
      case 'error':
        this.error(event.message || event.error?.message)
        break
      case 'item.started':
        if (event.item && TOOL_KINDS[event.item.type] !== undefined) this.startTool(event.item)
        break
      case 'item.completed': {
        const item = event.item
        if (!item) break
        if (item.type === 'agent_message') this.text(item.text)
        else if (item.type === 'reasoning') this.thought(item.text)
        else if (item.type === 'error') this.error(item.message || item.text || item.error?.message)
        else if (TOOL_KINDS[item.type] !== undefined) {
          this.startTool(item)
          this.update(toolResult(item))
        }
        break
      }
      default:
        break
    }
  }

  legacy(event) {
    const m = event.msg
    const sessionId = m.session_id ?? event.session_id
    if (typeof sessionId === 'string' && sessionId) this.sessionId = sessionId
    switch (m.type) {
      case 'agent_message':
      case 'agent_message_delta':
        this.text(m.delta || m.message || m.text)
        break
      case 'agent_reasoning':
      case 'agent_reasoning_delta':
        this.thought(m.delta || m.text)
        break
      case 'exec_command_begin':
      case 'mcp_tool_call_begin':
      case 'patch_apply_begin':
        this.startTool({ id: m.call_id, type: m.type === 'exec_command_begin' ? 'command_execution' : m.type === 'patch_apply_begin' ? 'file_change' : 'mcp_tool_call', command: m.command, tool: m.name })
        break
      case 'exec_command_end':
      case 'mcp_tool_call_end':
      case 'patch_apply_end':
        if (m.call_id) this.update({ sessionUpdate: 'tool_call_update', toolCallId: m.call_id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: m.output || m.text || 'done' } }] })
        break
      case 'token_count':
        if (m.info) this.turnUsage = { input_tokens: m.info.input_tokens, cached_input_tokens: m.info.cached_input_tokens, output_tokens: m.info.output_tokens }
        break
      case 'error':
        this.error(m.message)
        break
      case 'task_complete':
      case 'turn_complete':
        this.result = { type: 'turn.completed' }
        break
      default:
        break
    }
  }

  /** Why the turn failed, or undefined when it did not. */
  failure() {
    if (this.errors.length === 0 || this.result?.type === 'turn.completed') return
    const message = this.errors.at(-1)
    return codexAuthRejected(message) ? `${message} (Codex is not signed in or its login expired: run \`codex login\`)` : message
  }

  /** Token usage of the turn in DSH's shape; Codex counts cache reads inside `input_tokens`. */
  usage() {
    const u = this.turnUsage
    if (!u || typeof u !== 'object') return
    const n = (v) => (Number.isFinite(v) ? v : 0)
    const cacheReadTokens = n(u.cached_input_tokens)
    return {
      inputTokens: Math.max(0, n(u.input_tokens) - cacheReadTokens),
      outputTokens: n(u.output_tokens),
      cacheReadTokens,
      cacheWriteTokens: n(u.cache_write_input_tokens),
      ...(Number.isFinite(u.reasoning_output_tokens) && { reasoningTokens: u.reasoning_output_tokens }),
    }
  }
}
