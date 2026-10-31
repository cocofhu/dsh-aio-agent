/**
 * Launch table for agent CLIs that speak ACP over stdio. The CLIs are installed and
 * signed in by the user; the plugin only starts them.
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
      list: (bin) => [bin, 'models'],
      parse: (text) => parseModelList(text),
      default: 'auto',
      argv: (bin, extra, { model, cwd, resume, force }) => [
        bin,
        ...extra,
        '--print',
        '--output-format', 'stream-json',
        '--stream-partial-output',
        '--trust',
        ...(force ? ['--force'] : []),
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
  },
  codex: {
    label: 'Codex',
    order: 22,
    description: 'Hand every turn to Codex on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: () => ['codex-acp'],
    login: 'codex login',
    // Codex streams this warning as reply text for any model outside its catalog,
    // such as one served by a custom provider.
    notice: /^Model metadata for `[^`]+` not found\. Defaulting to fallback metadata\b/,
  },
  opencode: {
    label: 'OpenCode',
    order: 23,
    description: 'Hand every turn to OpenCode on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: () => ['opencode', 'acp'],
    login: 'opencode auth login',
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
      inputIncludesCache: true,
      list: (bin) => [bin, '--help'],
      parse: (text) => parseHelpModels(text),
      argv: (bin, extra, { model, resume, force }) => [
        bin,
        ...extra,
        '--print',
        '--output-format', 'stream-json',
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
  return error?.acp?.code === -32000 || /authentication required/i.test(String(error?.message ?? ''))
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
  const custom = command?.length ? [...command] : undefined
  const print = base.print
  const bin = custom?.[0] ?? base.argv()[0]
  // A launch line written for ACP mode keeps its options; its ACP switch does not apply.
  const extra = (custom?.slice(1) ?? []).filter((arg) => arg !== 'acp' && arg !== '--acp')
  return {
    id,
    label: base.label,
    order: base.order,
    description: base.description,
    login: base.login,
    model,
    notice: base.notice,
    argv: custom ?? base.argv(model),
    ...(print && {
      dialect: print.dialect,
      inputIncludesCache: print.inputIncludesCache === true,
      defaultModel: model ?? print.default,
      listArgv: print.list(bin),
      parseList: print.parse,
      printArgv: (options) => print.argv(bin, extra, options),
      acpArgv: (picked) => (custom ? [custom[0], '--model', picked, ...custom.slice(1)] : base.argv(picked)),
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
