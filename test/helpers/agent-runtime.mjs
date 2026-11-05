import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as driver from '../../lib/driver.js'

/** Real Cordis scopes, durable Session projections and the installed DSH loop. */
export async function agentRuntime(t, { backend = 'cursor', cwd, skills, setup } = {}) {
  const ctx = new Context()
  const errors = []
  const frames = []
  ctx.on('agent/assistant-stream', ({ frame }) => frames.push(frame))
  ctx.provide('llm', { stream() { throw new Error('aio must not call the Harness model') } })
  ctx.provide('tools', {})
  ctx.provide('skills', skills ?? {})
  ctx.provide('commands', {})
  ctx.plugin(SessionStore)
  ctx.plugin(AgentRegistry)
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const loop = ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  await loop.await()
  let handle
  t.after(async () => { await handle?.dispose(); await ctx.fiber.dispose() })
  handle = await ctx.agents.create({
    sessionId: `aio-test-${randomUUID()}`,
    meta: { cwd },
    async setup(agentCtx, agent) {
      agentCtx.on('agent/error', ({ error }) => errors.push(error))
      await agentCtx.plugin(driver, { backend }).await()
      await setup?.(agentCtx, agent)
    },
  })
  const { agent } = handle
  return {
    ctx, agent, errors, frames,
    events: () => agent.session.snapshotEvents(),
    dispose: () => handle.dispose(),
    // Same transfer as the Harness queue row's Send action, using its public API.
    async updateQueue(itemId, action) {
      if (action.kind !== 'steer') throw new Error('test helper only supports queue Send')
      const message = agent.inbox.nextTurn.find((pending) => pending.id === itemId)
      if (!message) throw new Error('queued message is no longer pending')
      agent.inbox.remove(itemId)
      agent.steer(message)
      return { accepted: true }
    },
    stop: () => agent.cancel({ kind: 'user' }, { keepInbox: true }),
  }
}

export function userMessage(text, content = []) {
  return createUserMessage({ content: [{ type: 'text', text }, ...content], source: { kind: 'user', rpcId: randomUUID() } })
}

export async function waitFor(read, { timeout = 10000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for the agent')
}
