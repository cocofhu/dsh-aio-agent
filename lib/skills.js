import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Workspace and user skills every aio agent can offer from `/`, including the
 * directories Claude Code, Cursor, Codex, OpenCode, CodeBuddy and Kimi already
 * use. Files without a complete frontmatter still count: the name comes from
 * the directory or file, and the description from the first paragraph.
 */

export const AIO_SKILL_PROVIDER = 'aio-skills'

/** The same `/name` gesture `@deepseek-ai/dsh-tool-skill` recognizes. */
export const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Project roots, then user roots. A lower rank wins a duplicate name. */
const PROJECT_ROOTS = [
  ['.dsh/skills', 100],
  ['.agents/skills', 200],
  ['.claude/skills', 210],
  ['.claude/commands', 220],
  ['.cursor/skills', 230],
  ['.codex/skills', 240],
  ['.opencode/skills', 250],
  ['.opencode/skill', 255],
  ['.codebuddy/skills', 260],
  ['.kimi/skills', 270],
]

const USER_ROOTS = [
  ['.dsh/skills', 400, true],
  ['.agents/skills', 500],
  ['.claude/skills', 510],
  ['.claude/commands', 520],
  ['.cursor/skills', 530],
  ['.cursor/skills-cursor', 535],
  ['.codex/skills', 540],
  ['.config/opencode/skills', 550],
  ['.config/opencode/skill', 555],
  ['.opencode/skills', 560],
  ['.codebuddy/skills', 570],
  ['.kimi/skills', 580],
]

let skillApi
try {
  skillApi = await import('@deepseek-ai/dsh-skill')
} catch {
  skillApi = undefined
}

/** A directory or file name turned into a skill name, or undefined when it cannot be. */
export function skillNameFrom(value) {
  const name = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return SKILL_NAME.test(name) ? name : undefined
}

/**
 * Roots scanned for `cwd`, project first. `projectRoot` skips the `.git` walk;
 * `home` replaces the user directory (tests).
 */
export function skillRoots(projectRoot, home) {
  const roots = []
  for (const [rel, rank] of PROJECT_ROOTS) {
    roots.push({ path: join(projectRoot, rel), rank, source: `project:${rel}`, skipSystem: false })
  }
  for (const [rel, rank, skipSystem] of USER_ROOTS) {
    roots.push({ path: join(home, rel), rank, source: `user:${rel}`, skipSystem: skipSystem === true })
  }
  return roots
}

/** Nearest ancestor of `cwd` that contains `.git`, or `cwd` itself. */
export async function findProjectRoot(cwd) {
  let current = resolve(cwd)
  while (true) {
    try {
      await access(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(cwd)
      current = parent
    }
  }
}

/**
 * Parse one skill markdown file.
 * @returns the skill fields, or undefined when no legal name can be made.
 */
export function parseSkillDocument(raw, fallbackName, filePath, directory) {
  const { data, body } = splitFrontmatter(String(raw ?? ''))
  const name = skillNameFrom(data.name) ?? skillNameFrom(fallbackName)
  if (!name) return
  const whenToUse = textField(data.whenToUse)
  const description = textField(data.description) ?? whenToUse ?? firstParagraph(body) ?? name
  const content = body.trim() || description
  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    invocation: {
      modelInvocable: boolField(data['disable-model-invocation']) !== true,
      userInvocable: boolField(data['user-invocable']) !== false,
    },
    content,
    path: filePath,
    directory,
  }
}

/** Skill candidates for one workspace, deduped by name (lowest rank wins). */
export async function discoverSkills(cwd, options = {}) {
  const projectRoot = options.projectRoot ?? (await findProjectRoot(cwd))
  const home = options.home ?? homedir()
  const byName = new Map()
  for (const root of skillRoots(projectRoot, home)) {
    options.signal?.throwIfAborted?.()
    for (const skill of await readRoot(root)) {
      const existing = byName.get(skill.name)
      if (existing && existing.rank <= skill.rank) continue
      byName.set(skill.name, skill)
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** Load the body of a candidate `discoverSkills` returned. */
export async function loadSkill(candidate) {
  const locator = candidate?.locator
  if (!locator?.path) return
  let raw
  try {
    raw = await readFile(locator.path, 'utf8')
  } catch {
    return
  }
  const parsed = parseSkillDocument(raw, candidate.name, locator.path, locator.directory)
  if (!parsed || parsed.name !== candidate.name) return
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
    invocation: parsed.invocation,
    source: candidate.source,
    provider: AIO_SKILL_PROVIDER,
    content: parsed.content,
    path: parsed.path,
    resourceBase: { kind: 'directory', path: locator.directory },
  }
}

/** Provider registered on each aio preset, so built-in modes keep their own catalog. */
export function createAioSkillProvider() {
  return {
    name: AIO_SKILL_PROVIDER,
    list(options = {}) {
      return discoverSkills(options.cwd ?? process.cwd(), { signal: options.signal })
    },
    get(candidate) {
      return loadSkill(candidate)
    },
  }
}

/** Register the provider on the calling context's scope. */
export function registerAioSkills(ctx) {
  if (typeof ctx.skills?.registerProvider !== 'function') return
  return ctx.skills.registerProvider(() => createAioSkillProvider())
}

/** `/name` tokens in user text, in first-seen order. */
export function skillNamesIn(messages) {
  const names = []
  const seen = new Set()
  for (const message of messages ?? []) {
    for (const part of message.content ?? []) {
      if (part?.type !== 'text' || typeof part.text !== 'string') continue
      for (const match of part.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (seen.has(name)) continue
        seen.add(name)
        names.push(name)
      }
    }
  }
  return names
}

/**
 * Append `<skill_content>` for every `/name` the catalog knows, leaving the
 * admitted user messages untouched. Unknown names are left for the CLI.
 */
export async function withSkillMessages(skills, messages, options = {}) {
  if (typeof skills?.get !== 'function' || !Array.isArray(messages) || messages.length === 0) return messages
  const names = skillNamesIn(messages)
  if (names.length === 0) return messages
  const blocks = []
  for (const name of names) {
    options.signal?.throwIfAborted?.()
    let skill
    try {
      skill = await skills.get(name, { cwd: options.cwd, signal: options.signal, scope: options.scope })
    } catch (error) {
      if (options.signal?.aborted) throw error
      continue
    }
    if (!skill || skill.invocation?.userInvocable === false) continue
    blocks.push(renderInjectedSkill(skill))
  }
  if (blocks.length === 0) return messages
  return [...messages, { role: 'user', content: [{ type: 'text', text: blocks.join('\n\n') }] }]
}

/** Canonical skill block when the skill package is present, otherwise the same tags. */
export function renderInjectedSkill(skill) {
  if (skillApi?.renderSkillContent) return skillApi.renderSkillContent(skill)
  return [`<skill_content name="${skill.name}">`, '<skill_instructions>', skill.content, '</skill_instructions>', '</skill_content>'].join('\n')
}

function splitFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { data: {}, body: text }
  const nl = text.indexOf('\n')
  if (nl < 0 || text.slice(0, nl).replace(/\r$/, '') !== '---') return { data: {}, body: text }
  const rest = text.slice(nl + 1)
  const close = rest.search(/^---[ \t]*$/m)
  if (close < 0) return { data: {}, body: text }
  const yaml = rest.slice(0, close)
  const after = rest.slice(close).replace(/^---[ \t]*\r?\n?/, '')
  return { data: parseYamlMap(yaml), body: after }
}

/** A small subset: `key: value`, quotes, and `|` / `>` blocks. */
function parseYamlMap(yaml) {
  const data = {}
  let key
  let mode
  let buf = []
  const flush = () => {
    if (key === undefined) return
    data[key] = mode === '>' ? buf.join(' ').trim() : buf.join('\n').trim()
    key = undefined
    mode = undefined
    buf = []
  }
  for (const line of yaml.split(/\r?\n/)) {
    if (key !== undefined && (line.startsWith(' ') || line.startsWith('\t'))) {
      if (line.trim()) buf.push(line.trim())
      else if (mode === '|') buf.push('')
      continue
    }
    flush()
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim()
    const block = /^([|>])[+-]?$/.exec(value)
    if (block) {
      key = match[1]
      mode = block[1]
      continue
    }
    data[match[1]] = unquote(value)
  }
  flush()
  return data
}

function unquote(value) {
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1)
  }
  return value
}

function textField(value) {
  if (typeof value !== 'string') return
  const text = value.trim()
  return text.length > 0 ? text.replace(/\s+/g, ' ').slice(0, 500) : undefined
}

function firstParagraph(body) {
  const lines = []
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (lines.length > 0) break
      continue
    }
    if (trimmed.startsWith('#')) {
      if (lines.length > 0) break
      continue
    }
    lines.push(trimmed)
  }
  if (lines.length === 0) return
  return lines.join(' ').replace(/\s+/g, ' ').slice(0, 500)
}

function boolField(value) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value !== 'string') return
  switch (value.toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
      return true
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      return
  }
}

async function readRoot(root) {
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }
  const skills = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (root.skipSystem && entry.name === '.system') continue
    const full = join(root.path, entry.name)
    const kind = await entryKind(entry, full)
    if (kind === 'directory') {
      const file = join(full, 'SKILL.md')
      const skill = await readSkillFile(file, entry.name, full)
      if (skill) skills.push(candidateOf(skill, root))
    } else if (kind === 'file' && entry.name.endsWith('.md')) {
      const skill = await readSkillFile(full, entry.name.slice(0, -3), root.path)
      if (skill) skills.push(candidateOf(skill, root))
    }
  }
  return skills
}

async function readSkillFile(file, fallbackName, directory) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return
  }
  let path = file
  try {
    path = await realpath(file)
  } catch {
    path = file
  }
  return parseSkillDocument(raw, fallbackName, path, directory)
}

function candidateOf(parsed, root) {
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
    invocation: parsed.invocation,
    provider: AIO_SKILL_PROVIDER,
    source: root.source,
    rank: root.rank,
    locator: { path: parsed.path, directory: parsed.directory },
    resourceBase: { kind: 'directory', path: parsed.directory },
    path: parsed.path,
  }
}

async function entryKind(entry, full) {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (!entry.isSymbolicLink()) return
  try {
    const info = await stat(full)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
  } catch {
    return
  }
}
