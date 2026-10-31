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
  },
  'claude-code': {
    label: 'Claude Code',
    order: 21,
    description: 'Hand every turn to Claude Code on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: () => ['claude-code-acp'],
    login: 'claude auth login',
  },
  codex: {
    label: 'Codex',
    order: 22,
    description: 'Hand every turn to Codex on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: () => ['codex-acp'],
    login: 'codex login',
  },
  opencode: {
    label: 'OpenCode',
    order: 23,
    description: 'Hand every turn to OpenCode on this machine, with its own models, tools and sign-in. DSH shows and records the session.',
    argv: () => ['opencode', 'acp'],
    login: 'opencode auth login',
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
  return {
    id,
    label: base.label,
    order: base.order,
    description: base.description,
    login: base.login,
    model,
    argv: command?.length ? [...command] : base.argv(model),
  }
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
