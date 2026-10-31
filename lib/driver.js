import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { AcpClient } from './acp-client.js'
import { BACKENDS, currentBackend, isAuthError, isMissingCommand } from './backends.js'
import { firstListedModel } from './catalog.js'
import { ClaudeStream } from './claude-stream.js'
import { CodexStream } from './codex-stream.js'
import { CursorStream } from './cursor-stream.js'
import { OpenCodeStream } from './opencode-stream.js'
import { backendOfProvider, promptUsage, providerId, readEffortState, readModelState, setModel } from './models.js'
import { TurnWriter, redact } from './turn-writer.js'

/**
 * Agent-scoped driver mounted by an aio Agent preset. It answers every proposed
 * step of its Agent by running the turn in an external ACP agent CLI, writes the
 * resulting steps into the Session, and admits no messages to the model loop, so
 * the DSH model is never called. The DSH composer, stop button, queue and
 * transcript keep working unchanged.
 */
export const name = 'dsh-aio-agent-driver'
export const inject = []

const RECORD_BINDING = 'plugin:dsh-aio-agent/binding'
const RECORD_ACP = 'plugin:dsh-aio-agent/acp'
const RECORD_PERMISSION = 'plugin:dsh-aio-agent/permission'
const RECORD_STREAM = 'plugin:dsh-aio-agent/stream'
const KILL_GRACE_MS = 3000
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

let appendPluginRecord
try {
  ;({ appendPluginRecord } = await import('@deepseek-ai/dsh-session'))
} catch {
  appendPluginRecord = undefined
}

function findBinding(session) {
  let binding
  for (const event of session.snapshotEvents()) if (event.type === RECORD_BINDING) binding = event.data
  return binding
}

/** The model picker records its choice as `model/selection`; `agent.options` keeps the creation-time route. */
function latestSelection(session) {
  let selection
  for (const event of session.snapshotEvents()) if (event.type === 'model/selection') selection = event.data
  return selection
}

/** The loop records only the message of a non-LLM error, so the message carries the remedy. */
function turnError(error, backend) {
  if (isAuthError(error)) return new Error(`${backend.label} is not signed in: run \`${backend.login}\` in a terminal on the DSH machine, then send again`)
  if (isMissingCommand(error)) return new Error(`${backend.label} could not start: command not found: ${backend.argv[0]} (install it and make sure it is on PATH for the DSH process)`)
  return error instanceof Error ? error : new Error(String(error))
}

function promptBlocks(messages) {
  const blocks = []
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
      else if (part.type === 'image' && typeof part.data === 'string') blocks.push({ type: 'image', data: part.data, mimeType: part.mimeType ?? part.mediaType })
    }
  }
  return blocks
}

/**
 * A stream-json user message, as `--input-format stream-json` reads it on stdin;
 * images travel inline as Anthropic image blocks.
 */
function userEnvelope(messages) {
  const content = []
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text })
      else if (part.type === 'image' && typeof part.data === 'string') {
        content.push({ type: 'image', source: { type: 'base64', media_type: part.mimeType ?? part.mediaType ?? 'image/png', data: part.data } })
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

const STREAMS = { cursor: CursorStream, claude: ClaudeStream, codex: CodexStream, opencode: OpenCodeStream }

/**
 * Plain-text prompt for print modes that read text, so images travel as files the agent can open.
 * @returns the prompt text and the files to delete after the turn.
 */
async function printPrompt(messages) {
  const parts = []
  const files = []
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === 'text') parts.push(part.text)
      else if (part.type === 'image' && typeof part.data === 'string') {
        const mime = part.mimeType ?? part.mediaType
        const file = join(tmpdir(), `dsh-aio-${randomUUID()}.${IMAGE_EXT[mime] ?? 'png'}`)
        await writeFile(file, Buffer.from(part.data, 'base64'))
        files.push(file)
        parts.push(`[Attached image: ${file}]`)
      }
    }
  }
  return { text: parts.join('\n\n'), files }
}

/**
 * Run one print-mode turn and feed its transcript to `onEvent`.
 * @returns the exit code, stderr tail, and whether any transcript line arrived.
 */
function runPrint({ argv, cwd, env, stdin, signal, onEvent }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
    let stderr = ''
    let heard = false
    let killTimer
    const onAbort = () => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (!line.trim()) return
      let event
      try {
        event = JSON.parse(line)
      } catch {
        stderr = (stderr + line + '\n').slice(-8192)
        return
      }
      heard = true
      onEvent(event)
    })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, stderr: stderr.trim(), heard })
    })
  })
}

/** Frame counters of `agent/assistant-stream`, monotone for one attached Agent. */
const liveCounters = new WeakMap()

function liveStream(ctx, agent) {
  let counters = liveCounters.get(agent)
  if (!counters) liveCounters.set(agent, (counters = { revision: 0, attempt: 0 }))
  const events = agentEvents(ctx, agent)
  return {
    emit: (frame) => events.emit('agent/assistant-stream', { frame }),
    nextRevision: () => ++counters.revision,
    nextAttemptId: () => `${agent.session.id}:aio-${++counters.attempt}`,
  }
}

export function apply(ctx, config = {}) {
  const backendId = BACKENDS[config.backend] ? config.backend : 'cursor'
  let backend = currentBackend(backendId)
  let conn

  const record = (session, type, data) => {
    if (!appendPluginRecord) return
    try {
      appendPluginRecord(session, type, JSON.parse(JSON.stringify(redact(data))))
    } catch (error) {
      console.warn('[dsh-aio-agent]', error)
    }
  }

  /** A changed launch line restarts the CLI, which reloads the bound ACP session when it can. */
  async function connect(session, argv) {
    if (conn && !conn.client.exited && JSON.stringify(conn.argv) === JSON.stringify(argv)) return conn
    conn?.client.close()
    conn = undefined
    const cwd = session.header?.cwd ?? process.cwd()
    const binding = findBinding(session)
    const entry = { writer: undefined, acpSessionId: undefined, argv }
    const client = new AcpClient({
      argv,
      cwd,
      permission: () => backend.permission,
      onFrame: (dir, msg) => record(session, RECORD_ACP, { dir, msg }),
      onUpdate: (_acpSessionId, update) => {
        if (update.sessionUpdate === 'agent_message_chunk' && backend.notice?.test(update.content?.text ?? '')) return
        entry.writer?.update(update)
      },
      onPermission: (request, optionId) => record(session, RECORD_PERMISSION, { policy: backend.permission, optionId: optionId ?? null, request }),
    })
    entry.client = client
    try {
      const init = await client.initialize()
      if (binding?.acpSessionId && binding.backend === backend.id && init.agentCapabilities?.loadSession) {
        // Replayed history arrives as session/update before the load resolves; it is already in the DSH log.
        const loaded = await client.request('session/load', { sessionId: binding.acpSessionId, cwd, mcpServers: [] })
        entry.acpSessionId = binding.acpSessionId
        entry.modelState = readModelState(loaded)
        entry.effortState = readEffortState(loaded)
      } else {
        const created = await client.request('session/new', { cwd, mcpServers: [] })
        entry.acpSessionId = created.sessionId
        entry.modelState = readModelState(created)
        entry.effortState = readEffortState(created)
        record(session, RECORD_BINDING, { backend: backend.id, cwd, acpSessionId: created.sessionId })
      }
    } catch (error) {
      client.close()
      throw error
    }
    conn = entry
    return entry
  }

  /** Model and reasoning effort the user picked for this session, if they belong to this backend's catalog route. */
  function selectedModel(agent) {
    const { provider, model, reasoningEffort } = latestSelection(agent.session) ?? agent.options ?? {}
    const picked = backendOfProvider(provider)
    // An ACP variant id such as `grok-4.7[fast=true]` is not a `--model` id.
    if (picked === backend.id) return { model: backend.printArgv && model?.includes('[') ? backend.model : model, effort: reasoningEffort || undefined }
    if (picked !== undefined && BACKENDS[picked]) {
      throw new Error(`this session runs ${backend.label}, but the selected model belongs to ${BACKENDS[picked].label}; pick a ${backend.label} model or start a ${BACKENDS[picked].label} session`)
    }
    return { model: backend.model }
  }

  async function applyModel(entry, model) {
    if (!model || model === entry.modelState?.current) return
    const result = await setModel(entry.client, entry.acpSessionId, entry.modelState?.control, model)
    entry.modelState = { ...entry.modelState, current: model }
    // A model switch may change which efforts the agent offers.
    entry.effortState = readEffortState(result) ?? entry.effortState
  }

  /** Select the picked effort through the agent's own selector; an effort it does not offer keeps its current one. */
  async function applyEffort(entry, effort) {
    const state = entry.effortState
    if (!effort || !state || effort === state.current || !state.efforts.some((e) => e.id === effort)) return
    const result = await entry.client.request('session/set_config_option', { sessionId: entry.acpSessionId, configId: state.configId, value: effort })
    entry.effortState = readEffortState(result) ?? { ...state, current: effort }
  }

  /** One print-mode process per turn, resuming the bound chat. */
  async function printTurn(session, writer, { model, effort }, messages, signal) {
    const cwd = session.header?.cwd ?? process.cwd()
    const binding = findBinding(session)
    const resume = binding?.backend === backend.id ? binding.chatId : undefined
    const { text, files } = backend.stdin === 'json' ? { text: '', files: [] } : await printPrompt(messages)
    try {
      const onUpdate = (update) => writer.update(update)
      const stream = new STREAMS[backend.dialect](onUpdate, { inputIncludesCache: backend.inputIncludesCache })
      const argv = backend.printArgv({ model, effort, cwd, resume, force: backend.permission === 'allow', prompt: text })
      const outcome = await runPrint({
        argv,
        cwd,
        env: backend.printEnv({ ...process.env, NO_COLOR: '1' }),
        stdin: backend.stdin === 'json' ? userEnvelope(messages) : backend.stdin === 'raw' ? text : '',
        signal,
        onEvent: (event) => {
          if (stream.recordable(event)) record(session, RECORD_STREAM, event)
          stream.push(event)
        },
      })
      if (stream.sessionId && stream.sessionId !== resume) record(session, RECORD_BINDING, { backend: backend.id, cwd, chatId: stream.sessionId })
      writer.usage = stream.usage()
      if (signal.aborted) return
      const failure = stream.failure() ?? (outcome.code !== 0 && !stream.result ? outcome.stderr || `${argv[0]} exited with code ${outcome.code}` : undefined)
      if (failure !== undefined) throw new Error(failure)
    } finally {
      await Promise.all(files.map((file) => rm(file, { force: true })))
    }
  }

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }) => {
    const admitted = { kind: 'enter', messages: [] }
    if (messages.length === 0) return admitted
    const session = agent.session
    backend = currentBackend(backendId)
    const writer = new TurnWriter({ session, turn, provider: providerId(backend.id), model: 'default', cwd: session.header?.cwd, live: liveStream(ctx, agent) })
    writer.admit(messages)
    const { model, effort } = selectedModel(agent)
    const binding = findBinding(session)
    // Print mode cannot resume a chat begun over ACP, so such sessions stay on ACP
    // while the backend still speaks it; the others continue in a new print chat.
    const acpBound = binding?.backend === backend.id && binding.acpSessionId !== undefined && backend.acpArgv !== undefined
    if (backend.printArgv && !acpBound) {
      // The picker shows an agent's first listed model as the current one of a session that picked none.
      const runModel = model ?? backend.defaultModel ?? firstListedModel(backend.id)
      writer.model = runModel ?? 'default'
      try {
        await printTurn(session, writer, { model: runModel, effort }, messages, signal)
      } catch (error) {
        throw turnError(error, backend)
      } finally {
        writer.finish()
      }
      return admitted
    }
    let entry
    try {
      if (backend.acpArgv) {
        entry = await connect(session, backend.acpArgv(model ?? backend.defaultModel))
      } else {
        entry = await connect(session, backend.argv)
        await applyModel(entry, model)
      }
      await applyEffort(entry, effort)
    } catch (error) {
      throw turnError(error, backend)
    }
    writer.model = backend.acpArgv ? (model ?? backend.defaultModel) : (entry.modelState?.current ?? model ?? 'default')
    const onAbort = () => entry.client.notify('session/cancel', { sessionId: entry.acpSessionId })
    signal.addEventListener('abort', onAbort, { once: true })
    entry.writer = writer
    try {
      const result = await entry.client.request('session/prompt', { sessionId: entry.acpSessionId, prompt: promptBlocks(messages) })
      writer.usage = promptUsage(result)
    } catch (error) {
      throw turnError(error, backend)
    } finally {
      signal.removeEventListener('abort', onAbort)
      entry.writer = undefined
      writer.finish()
    }
    return admitted
  })

  ctx.on('dispose', () => conn?.client.close())
}
