/**
 * The Claude Code `--print --output-format stream-json --include-partial-messages`
 * transcript, as CodeBuddy Code emits it, translated into the ACP
 * `session/update` shapes TurnWriter reads. The final `result` carries the
 * token usage of the whole turn.
 */

const TOOL_KINDS = {
  Bash: 'execute',
  BashOutput: 'execute',
  PowerShell: 'execute',
  Read: 'read',
  ViewImage: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Glob: 'search',
  Grep: 'search',
  LS: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Skill: 'skill',
  SlashCommand: 'skill',
}

const SHELL_RESULT = /^Stdout: ([\s\S]*?)\n\nStderr: ([\s\S]*?)\nExit Code: (-?\d+)/
const EMPTY = '(empty)'

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n')
}

/** ACP tool call for one `tool_use` block. */
export function toolCallOf(block) {
  const input = block.input && typeof block.input === 'object' ? block.input : {}
  const name = typeof block.name === 'string' ? block.name : 'Tool'
  const kind = TOOL_KINDS[name] ?? 'other'
  const path = input.file_path ?? input.notebook_path ?? input.path
  return {
    sessionUpdate: 'tool_call',
    toolCallId: block.id,
    kind,
    title: kind === 'execute' && typeof input.command === 'string' ? input.command : typeof path === 'string' ? `${name} ${path}` : name,
    rawInput: input,
    ...(typeof path === 'string' ? { locations: [{ path }] } : {}),
    status: 'in_progress',
  }
}

/** ACP tool call update for one `tool_result` block of a tool whose kind is known. */
export function toolResultOf(block, kind) {
  const text = blockText(block.content)
  const update = { sessionUpdate: 'tool_call_update', toolCallId: block.tool_use_id, status: block.is_error ? 'failed' : 'completed' }
  const shell = kind === 'execute' ? SHELL_RESULT.exec(text) : null
  if (shell) {
    const clean = (s) => (s.trim() === EMPTY ? '' : s)
    const exitCode = block._meta?.rawResponse?.exitCode ?? Number(shell[3])
    update.rawOutput = { stdout: clean(shell[1]), stderr: clean(shell[2]), exitCode }
  } else {
    update.content = [{ type: 'content', content: { type: 'text', text: text || (block.is_error ? 'failed' : 'done') } }]
  }
  return update
}

/**
 * Translates transcript lines in order. Partial messages stream each block as
 * SSE events, then repeat every finished block in an `assistant` line; a repeat
 * only contributes what the stream did not already carry. Lines of subagents
 * (`parent_tool_use_id`) stay inside the tool call that spawned them.
 */
export class ClaudeStream {
  /**
   * @param update - receives each ACP `session/update` payload.
   * @param options.inputIncludesCache - the CLI counts cache reads inside `input_tokens`.
   */
  constructor(update, { inputIncludesCache = false } = {}) {
    this.update = update
    this.inputIncludesCache = inputIncludesCache
    this.sessionId = undefined
    this.result = undefined
    this.streamed = new Set()
    this.blocks = new Map()
    this.tools = new Map()
  }

  /** Whether the line belongs in the session log; partial-message deltas repeat in `assistant` lines. */
  recordable(event) {
    return event?.type !== 'stream_event'
  }

  emitTool(block) {
    if (!block.id || this.tools.has(block.id)) return
    const call = toolCallOf(block)
    this.tools.set(block.id, call.kind)
    this.update(call)
  }

  streamEvent(ev) {
    switch (ev?.type) {
      case 'message_start':
        if (ev.message?.id) this.streamed.add(ev.message.id)
        this.blocks.clear()
        break
      case 'content_block_start':
        // Proxied models may open the next block at the same index without stopping this one.
        this.finishBlock(ev.index)
        this.blocks.set(ev.index, { ...ev.content_block, json: '' })
        break
      case 'content_block_delta': {
        const d = ev.delta ?? {}
        if (d.type === 'text_delta' && d.text) this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: d.text } })
        else if (d.type === 'thinking_delta' && d.thinking) this.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: d.thinking } })
        else if (d.type === 'input_json_delta') {
          const block = this.blocks.get(ev.index)
          if (block) block.json += d.partial_json ?? ''
        }
        break
      }
      case 'content_block_stop':
        this.finishBlock(ev.index)
        break
      default:
        break
    }
  }

  finishBlock(index) {
    const block = this.blocks.get(index)
    this.blocks.delete(index)
    if (block?.type !== 'tool_use') return
    let input = block.input ?? {}
    try {
      if (block.json) input = JSON.parse(block.json)
    } catch {}
    this.emitTool({ ...block, input })
  }

  message(message) {
    const streamed = this.streamed.has(message?.id)
    for (const block of message?.content ?? []) {
      if (block.type === 'tool_use') {
        if (this.tools.has(block.id)) this.update({ sessionUpdate: 'tool_call_update', toolCallId: block.id, rawInput: block.input ?? {} })
        else this.emitTool(block)
      } else if (streamed) {
        continue
      } else if (block.type === 'text' && block.text) {
        this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text } })
      } else if (block.type === 'thinking' && block.thinking) {
        this.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: block.thinking } })
      }
    }
  }

  /** @param event - one parsed transcript line. */
  push(event) {
    if (typeof event?.session_id === 'string') this.sessionId = event.session_id
    if (event?.parent_tool_use_id) return
    switch (event?.type) {
      case 'stream_event':
        this.streamEvent(event.event)
        break
      case 'assistant':
        this.message(event.message)
        break
      case 'user':
        for (const block of event.message?.content ?? []) {
          if (block?.type === 'tool_result' && this.tools.has(block.tool_use_id)) this.update(toolResultOf(block, this.tools.get(block.tool_use_id)))
        }
        break
      case 'result':
        this.result = event
        break
      default:
        break
    }
  }

  /** Why the turn failed, or undefined when it did not. */
  failure() {
    if (!this.result?.is_error) return
    const errors = Array.isArray(this.result.errors) ? this.result.errors.filter((e) => typeof e === 'string') : []
    return errors.join('; ') || this.result.result || `turn ended with ${this.result.subtype ?? 'an error'}`
  }

  /** Token usage of the whole turn in DSH's shape, if the CLI reported it. */
  usage() {
    const u = this.result?.usage
    if (!u || typeof u !== 'object') return
    const n = (v) => (Number.isFinite(v) ? v : 0)
    const cacheReadTokens = n(u.cache_read_input_tokens)
    const input = n(u.input_tokens)
    return {
      inputTokens: this.inputIncludesCache ? Math.max(0, input - cacheReadTokens) : input,
      outputTokens: n(u.output_tokens),
      cacheReadTokens,
      cacheWriteTokens: n(u.cache_creation_input_tokens),
    }
  }
}
