import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

/**
 * Local CLI sessions an aio mode can bind with `/resume`. Parsers never import
 * a transcript into the DSH log; they only recover an id, a title and a time
 * so the next turn can pass the CLI its own `--resume` / `--session` flag.
 */

export const BINDING_EVENT = 'plugin:dsh-aio-agent/binding'
export const CLEAR_RESUME_TOKENS = new Set(['off', 'clear', 'cancel', 'none', 'stop'])

const LIST_LIMIT = 50
const CURRENT_CAP = 80
const OTHER_CAP = 80
const LINE_LIMIT = 200_000
const SPAWN_TIMEOUT_MS = 8000

const run = promisify(execFile)

/** Whether a `/resume` argument asks to clear the current binding. */
export function isClearResumeToken(raw) {
  return CLEAR_RESUME_TOKENS.has(String(raw ?? '').trim().toLowerCase())
}

/** Latest `plugin:dsh-aio-agent/binding` on a session, if one was recorded. */
export function readBinding(session) {
  let binding
  for (const event of session?.snapshotEvents?.() ?? []) {
    if (event.type === 'agent-preset/selected') {
      binding = undefined
      continue
    }
    if (event.type !== BINDING_EVENT) continue
    binding = event.data?.cleared ? undefined : event.data
  }
  return binding
}

/** Title safe to show in the composer bar, the transcript card, and the sidebar. */
export function cleanResumeTitle(title) {
  const clean = String(title ?? '').replace(/["\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 200) : ''
}

/**
 * Client-facing binding. Absent or unusable events become null so the
 * projection schema can reject anything else.
 * @param {unknown} data
 * @returns {{ backend: string, id: string, title: string | null, resumed: boolean } | null}
 */
export function bindingView(data) {
  if (!data || typeof data !== 'object' || data.cleared) return null
  const id = typeof data.chatId === 'string' ? data.chatId : typeof data.acpSessionId === 'string' ? data.acpSessionId : ''
  if (!id) return null
  const title = cleanResumeTitle(data.title)
  return {
    backend: typeof data.backend === 'string' ? data.backend : '',
    id,
    title: title || null,
    resumed: data.resumed === true,
  }
}

/** Stable command result. The transcript card parses this exact shape. */
export function resumeResultText(title, id) {
  const clean = cleanResumeTitle(title)
  return clean ? `Resuming "${clean}" (${id}).` : `Resuming session ${id}.`
}

/** Stable command result when clearing a resume binding. */
export function clearResumeResultText(id) {
  return id ? `Cleared resumed session (${id}).` : 'No resumed session to clear.'
}

/** Ids safe to place after `--resume` or `--session` (no flags, no whitespace). */
export function isSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][\w.:-]{0,199}$/.test(id)
}

/** Claude Code / CodeBuddy project directory: every non-alphanumeric becomes `-`. */
export function escapeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-')
}

/** Cursor groups chats by `md5(cwd)`. */
export function cursorWorkspaceHash(cwd) {
  return createHash('md5').update(String(cwd)).digest('hex')
}

/**
 * Sessions for one backend, current workspace first.
 * @param options.home - user directory that holds `.claude`, `.cursor`, …
 * @param options.spawn - `(command, args) => stdout`, for OpenCode and tests
 * @param options.limit - how many rows to return
 */
export async function listBackendSessions(backendId, cwd, options = {}) {
  const home = options.home ?? homedir()
  const limit = options.limit ?? LIST_LIMIT
  let rows = []
  switch (backendId) {
    case 'claude-code':
      rows = await scanProjectTranscripts(join(home, '.claude', 'projects'), cwd, absorbClaude)
      break
    case 'codebuddy':
      rows = await scanProjectTranscripts(join(home, '.codebuddy', 'projects'), cwd, absorbCodebuddy)
      break
    case 'codex':
      rows = await scanCodex(join(home, '.codex', 'session_index.jsonl'), cwd)
      break
    case 'cursor':
      rows = await scanCursor(join(home, '.cursor', 'chats'), cwd)
      break
    case 'opencode':
      rows = await scanOpenCode(cwd, options)
      break
    default:
      rows = []
  }
  return sortSessions(rows).slice(0, limit)
}

/** Title and cwd folded from Claude Code JSONL events. */
export function foldClaudeTranscript(events) {
  const state = {}
  for (const event of events) absorbClaude(state, event)
  return finishTranscript(state)
}

/** Title and cwd folded from a CodeBuddy JSONL. */
export function foldCodebuddyTranscript(events) {
  const state = {}
  for (const event of events) absorbCodebuddy(state, event)
  return finishTranscript(state)
}

/** Rows of `~/.codex/session_index.jsonl`. */
export function parseCodexIndex(text, cwd) {
  const rows = []
  for (const line of String(text ?? '').split(/\n/)) {
    if (!line.trim()) continue
    let item
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof item?.id !== 'string' || !isSessionId(item.id)) continue
    const dir = typeof item.cwd === 'string' ? item.cwd : undefined
    rows.push({
      id: item.id,
      title: oneLine(item.thread_name || item.title || item.id),
      updatedAt: Date.parse(item.updated_at) || 0,
      cwd: dir,
      currentWorkspace: samePath(dir, cwd),
    })
  }
  return rows
}

/** One Cursor `meta.json`. */
export function sessionFromCursorMeta(meta, id) {
  const cwd = typeof meta?.cwd === 'string' ? meta.cwd : undefined
  return {
    id,
    title: oneLine(meta?.title || 'Untitled session'),
    updatedAt: numberOrZero(meta?.updatedAtMs) || numberOrZero(meta?.createdAtMs),
    cwd,
  }
}

/** `opencode session list --format json`. */
export function parseOpenCodeList(text, cwd) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.sessions) ? data.sessions : []
  const rows = []
  for (const item of list) {
    if (typeof item?.id !== 'string' || !isSessionId(item.id)) continue
    const dir = typeof item.directory === 'string' ? item.directory : typeof item.cwd === 'string' ? item.cwd : undefined
    const updated = typeof item.updated === 'number' ? item.updated : Date.parse(item.updated)
    rows.push({
      id: item.id,
      title: oneLine(item.title || item.id),
      updatedAt: Number.isFinite(updated) ? updated : 0,
      cwd: dir,
      currentWorkspace: samePath(dir, cwd),
    })
  }
  return rows
}

function absorbClaude(state, event) {
  if (!event || typeof event !== 'object') return
  if (event.type === 'custom-title') {
    const title = event.customTitle ?? event.title
    if (typeof title === 'string' && title.trim()) state.custom = oneLine(title)
  } else if (event.type === 'last-prompt' && typeof event.lastPrompt === 'string' && event.lastPrompt.trim()) {
    state.prompt = oneLine(event.lastPrompt)
  } else if (event.type === 'user' && !event.isSidechain && !state.user) {
    const text = textOfContent(event.message?.content ?? event.content)
    if (text) state.user = oneLine(text)
  }
  if (typeof event.cwd === 'string') state.cwd = event.cwd
}

function absorbCodebuddy(state, event) {
  if (!event || typeof event !== 'object') return
  const user = (event.type === 'message' && event.role === 'user') || event.type === 'user'
  if (user && !state.user) {
    const text = textOfContent(event.content ?? event.message?.content)
    if (text) state.user = oneLine(text)
  }
  if (typeof event.cwd === 'string') state.cwd = event.cwd
}

function finishTranscript(state) {
  return { title: state.custom || state.prompt || state.user || 'Untitled session', cwd: state.cwd }
}

async function scanProjectTranscripts(root, cwd, absorb) {
  let dirs
  try {
    dirs = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const wanted = escapeProjectDir(cwd)
  const current = []
  const other = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const files = await jsonlFiles(join(root, dir.name))
    const bucket = dir.name === wanted ? current : other
    for (const file of files) bucket.push({ ...file, dirName: dir.name })
  }
  const chosen = [...newest(current, CURRENT_CAP), ...newest(other, OTHER_CAP)]
  const rows = []
  for (const file of chosen) {
    const state = await foldFile(file.path, absorb)
    rows.push({
      id: file.id,
      title: state.title,
      updatedAt: file.mtimeMs,
      cwd: state.cwd,
      currentWorkspace: file.dirName === wanted || samePath(state.cwd, cwd),
    })
  }
  return rows
}

async function jsonlFiles(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      files.push({ path, id: name.slice(0, -'.jsonl'.length), mtimeMs: info.mtimeMs })
    } catch {
      continue
    }
  }
  return files
}

function newest(files, cap) {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, cap)
}

async function foldFile(path, absorb) {
  const state = {}
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) })
    for await (const line of lines) {
      if (!line.trim() || line.length > LINE_LIMIT) continue
      try {
        absorb(state, JSON.parse(line))
      } catch {
        continue
      }
    }
  } catch {
    return finishTranscript(state)
  }
  return finishTranscript(state)
}

async function scanCodex(file, cwd) {
  try {
    return parseCodexIndex(await readFile(file, 'utf8'), cwd)
  } catch {
    return []
  }
}

async function scanCursor(root, cwd) {
  let hashes
  try {
    hashes = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const wanted = cursorWorkspaceHash(cwd)
  const rows = []
  for (const hash of hashes) {
    if (!hash.isDirectory()) continue
    let chats
    try {
      chats = await readdir(join(root, hash.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const chat of chats) {
      if (!chat.isDirectory() || !isSessionId(chat.name)) continue
      let meta
      try {
        meta = JSON.parse(await readFile(join(root, hash.name, chat.name, 'meta.json'), 'utf8'))
      } catch {
        continue
      }
      const row = sessionFromCursorMeta(meta, chat.name)
      row.currentWorkspace = hash.name === wanted || samePath(row.cwd, cwd)
      rows.push(row)
    }
  }
  return rows
}

async function scanOpenCode(cwd, options) {
  const spawn = options.spawn ?? defaultSpawn
  let stdout = ''
  try {
    stdout = await spawn('opencode', ['session', 'list', '--format', 'json', '-n', String(options.limit ?? LIST_LIMIT)])
  } catch {
    return []
  }
  return parseOpenCodeList(stdout, cwd)
}

async function defaultSpawn(command, args) {
  const { stdout } = await run(command, args, { timeout: SPAWN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } })
  return stdout
}

function sortSessions(rows) {
  return [...rows].sort((a, b) => Number(b.currentWorkspace) - Number(a.currentWorkspace) || (b.updatedAt || 0) - (a.updatedAt || 0))
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block?.type === 'text' || block?.type === 'input_text') return block.text ?? ''
      return ''
    })
    .filter(Boolean)
    .join(' ')
}

function oneLine(text) {
  const line = String(text).replace(/\s+/g, ' ').trim()
  return (line.length > 120 ? line.slice(0, 120) : line) || 'Untitled session'
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const norm = (value) => value.replace(/[\\/]+$/, '') || value
  return norm(left) === norm(right)
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
