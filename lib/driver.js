import { agentEvents } from '@deepseek-ai/dsh-agent'
import { AcpClient } from './acp-client.js'
import { BACKENDS, currentBackend, isAuthError, isMissingCommand } from './backends.js'
import { backendOfProvider, providerId, readModelState, setModel } from './models.js'
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
  if (isMissingCommand(error)) return new Error(`command not found: ${backend.argv[0]} (install it and make sure it is on PATH for the DSH process)`)
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

  async function connect(session) {
    if (conn && !conn.client.exited && JSON.stringify(conn.argv) === JSON.stringify(backend.argv)) return conn
    conn?.client.close()
    conn = undefined
    const cwd = session.header?.cwd ?? process.cwd()
    const binding = findBinding(session)
    const entry = { writer: undefined, acpSessionId: undefined, argv: backend.argv }
    const client = new AcpClient({
      argv: backend.argv,
      cwd,
      permission: () => backend.permission,
      onFrame: (dir, msg) => record(session, RECORD_ACP, { dir, msg }),
      onUpdate: (_acpSessionId, update) => entry.writer?.update(update),
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
      } else {
        const created = await client.request('session/new', { cwd, mcpServers: [] })
        entry.acpSessionId = created.sessionId
        entry.modelState = readModelState(created)
        record(session, RECORD_BINDING, { backend: backend.id, cwd, acpSessionId: created.sessionId })
      }
    } catch (error) {
      client.close()
      throw error
    }
    conn = entry
    return entry
  }

  /** Model the user picked for this session, if it belongs to this backend's catalog route. */
  function selectedModel(agent) {
    const { provider, model } = latestSelection(agent.session) ?? agent.options ?? {}
    const picked = backendOfProvider(provider)
    if (picked === backend.id) return model
    if (picked !== undefined && BACKENDS[picked]) {
      throw new Error(`this session runs ${backend.label}, but the selected model belongs to ${BACKENDS[picked].label}; pick a ${backend.label} model or start a ${BACKENDS[picked].label} session`)
    }
    return backend.model
  }

  async function applyModel(entry, model) {
    if (!model || model === entry.modelState?.current) return
    await setModel(entry.client, entry.acpSessionId, entry.modelState?.control, model)
    entry.modelState = { ...entry.modelState, current: model }
  }

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }) => {
    const admitted = { kind: 'enter', messages: [] }
    if (messages.length === 0) return admitted
    const session = agent.session
    backend = currentBackend(backendId)
    const writer = new TurnWriter({ session, turn, provider: providerId(backend.id), model: 'default', cwd: session.header?.cwd, live: liveStream(ctx, agent) })
    writer.admit(messages)
    const model = selectedModel(agent)
    let entry
    try {
      entry = await connect(session)
      await applyModel(entry, model)
    } catch (error) {
      throw turnError(error, backend)
    }
    writer.model = entry.modelState?.current ?? model ?? 'default'
    const onAbort = () => entry.client.notify('session/cancel', { sessionId: entry.acpSessionId })
    signal.addEventListener('abort', onAbort, { once: true })
    entry.writer = writer
    try {
      await entry.client.request('session/prompt', { sessionId: entry.acpSessionId, prompt: promptBlocks(messages) })
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
