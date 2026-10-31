import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const LIST_TIMEOUT_MS = 60 * 1000

async function stdoutOf(bin, args) {
  const { stdout } = await run(bin, args, { timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } })
  return stdout
}

/** An error the catalog reports as "not signed in" instead of a failure. */
function signInRequired(message) {
  return Object.assign(new Error(message), { authRequired: true })
}

const EFFORT_NAMES = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }

/** Display name of a reasoning effort id. */
export function effortName(id) {
  return EFFORT_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const CODEX_LUNA_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** The models Codex lists in its picker, for a Codex that has not cached its catalog yet. */
const CODEX_MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: CODEX_EFFORTS, context: 500000 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: CODEX_EFFORTS, context: 272000 },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: CODEX_EFFORTS, context: 272000 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: CODEX_LUNA_EFFORTS, context: 272000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', efforts: CODEX_EFFORTS, context: 272000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: CODEX_EFFORTS, context: 272000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', efforts: CODEX_LUNA_EFFORTS, context: 272000 },
]

/** Claude Code's model aliases; `default` keeps the model of its own settings. */
const CLAUDE_MODELS = [
  { id: 'default', name: 'Claude Code default' },
  { id: 'sonnet', name: 'Claude Sonnet (latest)' },
  { id: 'opus', name: 'Claude Opus (latest)' },
  { id: 'haiku', name: 'Claude Haiku (latest)' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-1', name: 'Claude Opus 4.1' },
]

/**
 * The models of Codex's `models_cache.json` that its own picker lists, in its order.
 * @returns the models, or undefined when the cache is absent or unreadable.
 */
export function parseCodexCache(text) {
  let cache
  try {
    cache = JSON.parse(text)
  } catch {
    return
  }
  if (!Array.isArray(cache?.models)) return
  const models = cache.models
    .filter((m) => typeof m?.slug === 'string' && m.visibility === 'list')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => {
      const efforts = (m.supported_reasoning_levels ?? []).map((l) => (typeof l === 'string' ? l : l?.effort)).filter((e) => typeof e === 'string')
      return {
        id: m.slug,
        name: m.display_name || m.slug,
        ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}),
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(efforts.includes(m.default_reasoning_level) ? { defaultEffort: m.default_reasoning_level } : {}),
        ...(Number.isInteger(m.context_window) && m.context_window > 0 ? { context: m.context_window } : {}),
      }
    })
  return models.length > 0 ? models : undefined
}

async function codexModels(bin, extra) {
  try {
    await stdoutOf(bin, [...extra, 'login', 'status'])
  } catch (error) {
    if (error?.code === 'ENOENT') throw error
    throw signInRequired('Codex is not signed in')
  }
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  const cached = await readFile(join(home, 'models_cache.json'), 'utf8').then(parseCodexCache, () => undefined)
  return cached ?? CODEX_MODELS
}

/**
 * Parse `opencode models --verbose`: each `provider/model` line is followed by
 * the model's JSON. Variants are the model's reasoning efforts.
 * @returns the models in listed order.
 */
export function parseOpenCodeModels(text) {
  const models = []
  const lines = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].trim()
    if (!/^[^\s{}]+\/\S+$/.test(id)) continue
    let info = {}
    if (lines[i + 1]?.trim() === '{') {
      let end = i + 1
      while (end < lines.length && lines[end] !== '}') end++
      try {
        info = JSON.parse(lines.slice(i + 1, end + 1).join('\n'))
      } catch {}
      i = end
    }
    const efforts = Object.keys(info.variants ?? {})
    const context = info.limit?.context
    models.push({
      id,
      name: info.name ? `${info.name} (${id.split('/')[0]})` : id,
      ...(efforts.length > 0 ? { efforts } : {}),
      ...(Number.isInteger(context) && context > 0 ? { context } : {}),
    })
  }
  return models
}

/**
 * Launch table for the agent CLIs. The CLIs are installed and signed in by the
 * user; the plugin only starts them.
 *
 * `print` runs one process per turn and resumes the CLI's own session by id;
 * `stdin` says how the prompt travels: `raw` text, a stream-json `json` user
 * message, or `none` when the prompt is the last argument. Backends without
 * `print`, and sessions begun over ACP, speak ACP through `argv`.
 */
export const BACKENDS = {
  cursor: {
    label: 'Cursor',
    order: 20,
    description: 'Hand every turn to Cursor Agent on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: (model) => ['cursor-agent', ...(model ? ['--model', model] : []), 'acp'],
    login: 'cursor-agent login',
    // Cursor's ACP mode reports no token usage, lists one variant per model family
    // and rejects every other id in session/set_model. Its print mode streams the
    // same turn as JSON lines with usage, resumes a chat by id, and accepts every
    // id `cursor-agent models` prints.
    print: {
      dialect: 'cursor',
      stdin: 'raw',
      models: async (bin) => parseModelList(await stdoutOf(bin, ['models'])),
      default: 'auto',
      argv: (bin, extra, { model, cwd, resume, force }) => [
        bin,
        ...extra,
        '--print',
        '--output-format', 'stream-json',
        '--stream-partial-output',
        '--trust',
        ...(force ? ['--yolo', '--approve-mcps'] : []),
        ...(cwd ? ['--workspace', cwd] : []),
        ...(model ? ['--model', model] : []),
        ...(resume ? ['--resume', resume] : []),
      ],
    },
  },
  'claude-code': {
    label: 'Claude Code',
    order: 21,
    description: 'Hand every turn to Claude Code on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: () => ['claude-agent-acp'],
    login: 'claude auth login',
    print: {
      only: true,
      bin: 'claude',
      dialect: 'claude',
      stdin: 'json',
      models: async (bin) => {
        await stdoutOf(bin, ['--version'])
        return CLAUDE_MODELS
      },
      default: 'default',
      argv: (bin, extra, { model, resume, force }) => [
        bin,
        ...extra,
        '-p',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode', force ? 'bypassPermissions' : 'default',
        '--disallowedTools', 'AskUserQuestion',
        ...(model && model !== 'default' ? ['--model', model] : []),
        ...(resume ? ['--resume', resume] : []),
      ],
    },
  },
  codex: {
    label: 'Codex',
    order: 22,
    description: 'Hand every turn to Codex on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: () => ['codex-acp'],
    login: 'codex login',
    print: {
      only: true,
      bin: 'codex',
      dialect: 'codex',
      stdin: 'none',
      models: codexModels,
      // Codex signs in from ~/.codex/auth.json; an API key in the environment would replace that login.
      env: (env) => {
        const { OPENAI_API_KEY, CODEX_API_KEY, ACP_CODEX_API_KEY, ...rest } = env
        return rest
      },
      argv: (bin, extra, { model, effort, resume, force, prompt }) => [
        bin,
        ...extra,
        'exec',
        ...(resume ? ['resume', resume] : []),
        '--json',
        '--skip-git-repo-check',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
        ...(force ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
        '--',
        prompt,
      ],
    },
  },
  opencode: {
    label: 'OpenCode',
    order: 23,
    description: 'Hand every turn to OpenCode on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: () => ['opencode', 'acp'],
    login: 'opencode auth login',
    print: {
      only: true,
      bin: 'opencode',
      dialect: 'opencode',
      stdin: 'none',
      models: async (bin, extra) => parseOpenCodeModels(await stdoutOf(bin, [...extra, 'models', '--verbose'])),
      argv: (bin, extra, { model, effort, cwd, resume, force, prompt }) => [
        bin,
        ...extra,
        'run',
        '--format', 'json',
        '--thinking',
        ...(force ? ['--dangerously-skip-permissions'] : []),
        ...(cwd ? ['--dir', cwd] : []),
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--variant', effort] : []),
        ...(resume ? ['--session', resume] : []),
        '--',
        prompt,
      ],
    },
  },
  codebuddy: {
    label: 'CodeBuddy',
    order: 24,
    description: 'Hand every turn to CodeBuddy Code on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: () => ['codebuddy', '--acp'],
    login: 'codebuddy',
    // CodeBuddy's ACP mode demands a sign-in even for models of ~/.codebuddy/models.json.
    // Its print mode runs those without one, streams the Claude Code transcript
    // with usage, and resumes a session by id.
    print: {
      dialect: 'claude',
      stdin: 'json',
      inputIncludesCache: true,
      models: async (bin) => parseHelpModels(await stdoutOf(bin, ['--help'])),
      argv: (bin, extra, { model, resume, force }) => [
        bin,
        ...extra,
        '--print',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--permission-mode', force ? 'bypassPermissions' : 'default',
        '--disallowedTools', 'AskUserQuestion',
        ...(model ? ['--model', model] : []),
        ...(resume ? ['--resume', resume] : []),
      ],
    },
  },
  'kimi-code': {
    label: 'Kimi Code',
    order: 25,
    description: 'Hand every turn to Kimi Code on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: () => ['kimi', 'acp'],
    login: 'kimi acp --login',
  },
}

/** ACP reserves -32000 for auth_required. */
export function isAuthError(error) {
  return error?.authRequired === true || error?.acp?.code === -32000 || /authentication required/i.test(String(error?.message ?? ''))
}

/** The CLI is absent from the DSH process PATH. */
export function isMissingCommand(error) {
  return error?.code === 'ENOENT'
}

/**
 * Split a launch line into argv: whitespace separates arguments, single and double
 * quotes group them, and a backslash escapes the next character outside single quotes.
 * @param line - e.g. `"/opt/Cursor Agent/cursor-agent" acp`.
 * @returns the argv, empty for a blank line.
 */
export function parseCommand(line) {
  const argv = []
  let current
  let quote
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = undefined
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) current += line[++i]
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current ??= ''
    } else if (ch === '\\' && i + 1 < line.length) {
      current = (current ?? '') + line[++i]
    } else if (/\s/.test(ch)) {
      if (current !== undefined) argv.push(current)
      current = undefined
    } else {
      current = (current ?? '') + ch
    }
  }
  if (quote) throw new Error(`unclosed ${quote} in command: ${line}`)
  if (current !== undefined) argv.push(current)
  return argv
}

/**
 * @param id - key of BACKENDS.
 * @param override - `command` (argv array or launch line) and `model`; blank values keep the defaults.
 */
export function resolveBackend(id, override = {}) {
  const base = BACKENDS[id]
  if (!base) throw new Error(`unknown backend: ${id}`)
  const model = override.model?.trim() || undefined
  const command = typeof override.command === 'string' ? parseCommand(override.command) : override.command
  let custom = command?.length ? [...command] : undefined
  const print = base.print
  // A launch line naming the ACP adapter this backend no longer starts falls back to the CLI.
  if (print?.only && custom?.some((arg) => arg.replace(/^.*\//, '') === base.argv()[0])) custom = undefined
  const bin = custom?.[0] ?? print?.bin ?? base.argv()[0]
  // A launch line written for ACP mode keeps its options; its ACP switch does not apply.
  const extra = (custom?.slice(1) ?? []).filter((arg) => arg !== 'acp' && arg !== '--acp')
  return {
    id,
    label: base.label,
    order: base.order,
    description: base.description,
    login: base.login,
    model,
    argv: print?.only ? [bin, ...extra] : (custom ?? base.argv(model)),
    ...(print && {
      dialect: print.dialect,
      stdin: print.stdin,
      inputIncludesCache: print.inputIncludesCache === true,
      defaultModel: model ?? print.default,
      listModels: () => print.models(bin, extra),
      printEnv: print.env ?? ((env) => env),
      printArgv: (options) => print.argv(bin, extra, options),
      ...(!print.only && { acpArgv: (picked) => (custom ? [custom[0], '--model', picked, ...custom.slice(1)] : base.argv(picked)) }),
    }),
  }
}

/**
 * Parse the `<id> - <name>` lines of a model listing such as `cursor-agent models`.
 * Names lose zero-width characters, repeated spaces and the CLI's own
 * `(default)` / `(current)` markers, which say nothing about a DSH session.
 * @returns the models in listed order.
 */
export function parseModelList(text) {
  const models = []
  for (const raw of text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+-\s+(.+?)\s*$/.exec(raw)
    if (!match) continue
    const name = match[2].replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').replace(/\s*\((?:default|current)\)$/i, '').trim()
    models.push({ id: match[1], name: name || match[1] })
  }
  return models
}

const CUSTOM_MODEL = 'custom-local:'

/**
 * Parse the model ids `codebuddy --help` lists under `--model` as
 * `Currently supported: (a, b, …)`. Models the user configured in
 * ~/.codebuddy/models.json come first: they run without a CodeBuddy sign-in.
 * @returns the models, custom ones first, each group in listed order.
 */
export function parseHelpModels(text) {
  const match = /Currently supported:\s*\(([^)]*)\)/.exec(text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' '))
  if (!match) return []
  const models = match[1]
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id.startsWith(CUSTOM_MODEL) ? id.slice(CUSTOM_MODEL.length) : id }))
  const custom = models.filter((m) => m.id.startsWith(CUSTOM_MODEL))
  return [...custom, ...models.filter((m) => !m.id.startsWith(CUSTOM_MODEL))]
}

/** Live launch settings per backend, published by the agent row that owns the backend. */
const launchSources = new Map()

/**
 * Publish where a backend's launch settings are read, for the driver and catalog
 * to pick up edits without a reload.
 * @param id - key of BACKENDS.
 * @param read - returns `{ command, model, permission }` as currently configured.
 * @returns withdraws the source.
 */
export function provideLaunch(id, read) {
  launchSources.set(id, read)
  return () => {
    if (launchSources.get(id) === read) launchSources.delete(id)
  }
}

/** The backend as currently configured, with its permission policy. */
export function currentBackend(id) {
  const launch = launchSources.get(id)?.() ?? {}
  return { ...resolveBackend(id, launch), permission: launch.permission === 'deny' ? 'deny' : 'allow' }
}
