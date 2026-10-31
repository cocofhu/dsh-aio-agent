import { tmpdir } from 'node:os'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { AcpClient } from './acp-client.js'
import { isAuthError, isMissingCommand } from './backends.js'
import { providerId, readModelState } from './models.js'

const FRESH_MS = 10 * 60 * 1000
const FAILED_MS = 10 * 1000
const DISCOVERY_TIMEOUT_MS = 60 * 1000

async function discover(backend) {
  const client = new AcpClient({ argv: backend.argv, cwd: tmpdir(), permission: 'deny' })
  const timer = setTimeout(() => client.close(), DISCOVERY_TIMEOUT_MS)
  try {
    await client.initialize()
    const result = await client.request('session/new', { cwd: tmpdir(), mcpServers: [] })
    return readModelState(result).models
  } finally {
    clearTimeout(timer)
    client.close()
  }
}

/** Why an agent CLI cannot list models yet, or undefined for a real failure. */
function notReady(error, backend) {
  if (isAuthError(error)) return `not signed in; run \`${backend.login}\``
  if (isMissingCommand(error)) return `\`${backend.argv[0]}\` is not on PATH`
}

/**
 * Lists one external agent's models in the native model picker. The route is a
 * catalog only: turns of an aio preset never reach `stream()`, because the
 * preset's driver answers every step itself.
 */
class AioCatalogAdapter extends LlmAdapter {
  /** @param current - returns the backend as currently configured. */
  constructor(current) {
    super()
    this.current = current
    this.cache = undefined
    this.reported = undefined
  }

  providerInfo(provider) {
    return { id: provider, name: this.current().label }
  }

  /**
   * An agent that is not signed in or not installed lists no models, which hides
   * its route from the selector like a provider without credentials; a later
   * discovery picks it up once the user signs in.
   */
  listModels(provider) {
    const backend = this.current()
    const key = JSON.stringify(backend.argv)
    if (this.cache?.key === key && Date.now() < this.cache.until) return this.cache.models
    const models = discover(backend).then(
      (list) => {
        this.reported = undefined
        return list.map((m) => ({ provider, ...m }))
      },
      (error) => {
        if (this.cache?.models === models) this.cache.until = Date.now() + FAILED_MS
        const reason = notReady(error, backend)
        if (reason === undefined) throw error
        if (this.reported !== reason) console.warn(`[dsh-aio-agent] ${backend.label} models hidden: ${reason}`)
        this.reported = reason
        return []
      },
    )
    this.cache = { key, models, until: Date.now() + FRESH_MS }
    return models
  }

  async *stream() {
    const { label } = this.current()
    throw new Error(`${label} models run only in the ${label} agent preset; choose it from the mode menu or pick another model`)
  }
}

/**
 * @param current - returns the backend as currently configured; a changed launch
 *   command invalidates the cached list.
 */
export function registerCatalog(ctx, current) {
  const provider = providerId(current().id)
  const adapter = new AioCatalogAdapter(current)
  ctx.llm.registerAdapter([provider], adapter)
  adapter.listModels(provider).catch(() => {})
}
