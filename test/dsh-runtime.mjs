// DSH provides the @deepseek-ai/* peers to an installed plugin; tests borrow them
// from the DSH installation on PATH, or from DSH_ROOT (the @deepseek-ai/dsh package).
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function dshRoot() {
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  const bin = realpathSync(execFileSync(lookup, ['dsh'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim())
  let dir = dirname(bin)
  while (!dir.endsWith(join('@deepseek-ai', 'dsh')) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

const parent = pathToFileURL(join(dshRoot(), 'package.json')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('@deepseek-ai/')) throw error
      return nextResolve(specifier, { ...context, parentURL: parent })
    }
  },
})
