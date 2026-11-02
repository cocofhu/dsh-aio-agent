import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { arch, platform, release } from 'node:os'
import { promisify } from 'node:util'
import { BACKENDS, currentBackend } from './backends.js'
import { BINDING_EVENT, bindingView, isClearResumeToken, isSessionId, listBackendSessions, readBinding } from './sessions.js'
import { redact } from './turn-writer.js'

const require = createRequire(import.meta.url)
const run = promisify(execFile)
export const ISSUE_URL = 'https://github.com/cocofhu/dsh-aio-agent/issues/new'

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
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/aio-agent/trace',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => serveTrace(ctx, request),
  }), 'dsh-aio-agent: /api/aio-agent/trace')
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

async function cliVersion(bin) {
  if (!bin) return 'unknown'
  try {
    const { stdout, stderr } = await run(bin, ['--version'], {
      timeout: 3000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    })
    const line = `${stdout ?? ''}\n${stderr ?? ''}`.trim().split(/\r?\n/)[0]?.trim()
    return line || 'unknown'
  } catch (error) {
    return error?.code || error?.message || 'unavailable'
  }
}

/** Build a diagnostic markdown report and prefilled GitHub issue URL for a session failure. */
export async function buildDiagnosticTrace(session, { preset, message, cliVersionLookup = cliVersion } = {}) {
  const events = session?.snapshotEvents?.() ?? []
  const backendId = preset?.startsWith('aio-') ? preset.slice('aio-'.length) : undefined
  const backend = backendId && BACKENDS[backendId] ? currentBackend(backendId) : undefined
  const bin = backend?.argv?.[0]
  const version = await cliVersionLookup(bin)
  let selection
  let lastTurnError
  let lastDiag
  const frames = []
  for (const event of events) {
    if (event.type === 'model/selection') selection = event.data
    else if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') lastTurnError = event.data.reason
    else if (event.type === 'plugin:dsh-aio-agent/trace') lastDiag = event.data
    else if (event.type === 'plugin:dsh-aio-agent/stream' || event.type === 'plugin:dsh-aio-agent/acp') {
      frames.push({ seq: event.seq, type: event.type, data: redact(event.data) })
    }
  }
  const errorText = String(message || lastDiag?.error || lastTurnError?.message || 'Unknown error').trim()
  const modelText = [
    selection?.provider,
    selection?.model ?? lastDiag?.model ?? backend?.model ?? backend?.defaultModel,
    selection?.reasoningEffort ?? lastDiag?.effort,
  ].filter(Boolean).join(' / ') || 'default'
  const recentFrames = frames.slice(-20)
  const lines = [
    '### Diagnostic Trace (`@cocofhu/dsh-aio-agent`)',
    '',
    `- **Agent Mode**: \`${preset ?? 'unknown'}\`${backend?.label ? ` (${backend.label})` : ''}`,
    `- **CLI Binary**: \`${bin ?? 'unknown'}\``,
    `- **CLI Version**: \`${version}\``,
    `- **Selected Model**: \`${modelText}\``,
    `- **Platform**: \`${platform()} ${arch()} (${release()})\`, Node \`${process.version}\``,
    ...(lastDiag?.argv ? [`- **Launch Argv**: \`${JSON.stringify(redact(lastDiag.argv))}\``] : []),
    ...(lastDiag?.exitCode !== undefined ? [`- **Exit Code**: \`${lastDiag.exitCode}\``] : []),
    '',
    '#### Error Message',
    '```text',
    errorText.slice(0, 2000),
    '```',
  ]
  if (lastDiag?.stderr) {
    lines.push('', '#### CLI Stderr', '```text', String(lastDiag.stderr).slice(-2000), '```')
  }
  if (recentFrames.length > 0) {
    lines.push(
      '',
      '#### Recent Stream / ACP Frames',
      '```json',
      JSON.stringify(recentFrames, null, 2).slice(-6000),
      '```',
    )
  }
  const trace = lines.join('\n')
  const titlePrefix = backend?.label ? `[${backend.label}] ` : '[aio-agent] '
  const oneLineError = errorText.replace(/\s+/g, ' ').slice(0, 90)
  const issueParams = new URLSearchParams({
    title: `${titlePrefix}${oneLineError}`,
    body: [
      '### Describe what happened',
      '',
      '',
      ...lines.slice(0, lines.indexOf('#### Recent Stream / ACP Frames') > 0 ? lines.indexOf('#### Recent Stream / ACP Frames') : lines.length),
      ...(recentFrames.length > 0
        ? [
            '',
            '#### Recent Stream / ACP Frames',
            '```json',
            JSON.stringify(recentFrames.slice(-6), null, 2).slice(-1800),
            '```',
          ]
        : []),
    ].join('\n'),
  })
  return {
    trace,
    issueUrl: `${ISSUE_URL}?${issueParams.toString()}`,
    cliVersion: version,
    agent: backendId ?? null,
  }
}

/** `GET /api/aio-agent/trace?sessionId=&message=` — diagnostic trace and issue link for a failed turn. */
export async function serveTrace(ctx, request) {
  const url = requestUrl(request)
  const sessionId = url.searchParams.get('sessionId')
  const message = url.searchParams.get('message') ?? ''
  if (!sessionId) return Response.json({ error: 'sessionId is required' }, { status: 400 })
  const session = ctx.sessions.get(sessionId)
  if (!session) return Response.json({ error: 'session not found' }, { status: 404 })
  const preset = presetId(ctx.sessionProjections.stateOf(session, 'agentPreset'))
  const payload = await buildDiagnosticTrace(session, { preset, message })
  return Response.json(payload)
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
