import { createRequire } from 'node:module'
import { BINDING_EVENT, bindingView, isClearResumeToken, isSessionId, listBackendSessions, readBinding } from './sessions.js'

const require = createRequire(import.meta.url)

/** Session projection the composer bar reads. Replayed from the binding event. */
export const BINDING_PROJECTION_KEY = 'aioBinding'

function loadZod() {
  try {
    return require('zod')
  } catch {
    // The plugin file lives outside DSH's node_modules. Resolve a sibling
    // package through the host loader, then read zod from that tree.
    return createRequire(import.meta.resolve('@deepseek-ai/dsh-agent'))('zod')
  }
}

/**
 * Fold binding events into `{ backend, id, title }`. A later event for the
 * same id that has no title keeps the title already on screen.
 */
export function bindingProjection() {
  const { z } = loadZod()
  const schema = z.object({
    backend: z.string(),
    id: z.string(),
    title: z.string().nullable(),
    resumed: z.boolean().optional(),
  }).strict().nullable()
  return {
    key: BINDING_PROJECTION_KEY,
    stateVersion: 4,
    stateSchema: schema,
    init: () => null,
    apply(state, event) {
      if (event.type === 'agent-preset/selected') return null
      if (event.type === 'command/run' && event.data?.name === 'resume') {
        const arg = String(event.data?.args ?? '').trim()
        if (!arg) return state
        if (isClearResumeToken(arg)) return null
        if (!isSessionId(arg)) return state
        return {
          backend: state?.backend ?? '',
          id: arg,
          title: state?.id === arg ? state.title ?? null : null,
          resumed: true,
        }
      }
      if (event.type !== BINDING_EVENT) return state
      if (event.data?.cleared) return null
      const next = bindingView(event.data)
      if (!next) return state
      if (state?.id === next.id) {
        return {
          ...next,
          title: next.title || state.title || null,
          resumed: next.resumed || state.resumed === true,
        }
      }
      return next
    },
    wire: {
      viewSchema: schema,
      view: (state) => state,
    },
  }
}

export const name = 'dsh-aio-agent'
export const inject = ['connection', 'sessions', 'sessionProjections']

export function apply(ctx) {
  ctx.sessionProjections.register(bindingProjection())
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/aio-agent/sessions',
    methods: ['GET', 'DELETE'],
    requestBody: 'buffered',
    fetch: (request) => serveSessions(ctx, request),
  }), 'dsh-aio-agent: /api/aio-agent/sessions')
}

/** `GET`/`DELETE /api/aio-agent/sessions?sessionId=` — list or clear the bound CLI session. */
export async function serveSessions(ctx, request) {
  const sessionId = requestUrl(request).searchParams.get('sessionId')
  if (!sessionId) return Response.json({ error: 'sessionId is required' }, { status: 400 })
  const session = ctx.sessions.get(sessionId)
  if (!session) return Response.json({ error: 'session not found' }, { status: 404 })
  if (String(request?.method ?? 'GET').toUpperCase() === 'DELETE') {
    const binding = readBinding(session)
    const cwd = session.header?.cwd ?? process.cwd()
    session.append?.(BINDING_EVENT, { backend: binding?.backend ?? '', cwd, cleared: true })
    return Response.json({ cleared: true, activeId: null })
  }
  const preset = presetId(ctx.sessionProjections.stateOf(session, 'agentPreset'))
  if (!preset?.startsWith('aio-')) return Response.json({ sessions: [], activeId: null })
  const backendId = preset.slice('aio-'.length)
  const cwd = session.header?.cwd ?? process.cwd()
  const binding = readBinding(session)
  const activeId = binding?.backend === backendId ? (binding.chatId ?? binding.acpSessionId ?? null) : null
  const sessions = await listBackendSessions(backendId, cwd, { home: optionalHome(ctx) })
  return Response.json({ sessions, activeId })
}

/** Tests set `ctx.aioHome`. A host context throws on a property it was not asked to inject. */
function optionalHome(ctx) {
  try {
    return ctx.aioHome
  } catch {
    return undefined
  }
}

function presetId(state) {
  if (typeof state === 'string') return state
  if (state && typeof state === 'object' && typeof state.id === 'string') return state.id
}

function requestUrl(request) {
  const raw = request?.url
  try {
    return new URL(raw)
  } catch {
    try {
      return new URL(String(raw ?? '/'), 'http://localhost')
    } catch {
      return new URL('http://localhost/')
    }
  }
}
