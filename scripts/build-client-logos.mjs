// Inline assets/provider-logos/*.svg into lib/client.js, which must stay a single
// self-contained bundle. Run after adding or replacing a logo.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const dir = new URL('assets/provider-logos/', root)
const target = new URL('lib/client.js', root)

const logos = Object.fromEntries(
  readdirSync(dir)
    .filter((file) => file.endsWith('.svg'))
    .sort()
    .map((file) => {
      const svg = readFileSync(new URL(file, dir), 'utf8').replace(/\s*\n\s*/g, ' ').trim()
      return [file.slice(0, -4), `data:image/svg+xml,${encodeURIComponent(svg)}`]
    }),
)

const source = readFileSync(target, 'utf8')
const begin = '/* logos:begin */'
const end = '/* logos:end */'
const from = source.indexOf(begin)
const to = source.indexOf(end)
if (from < 0 || to < from) throw new Error('lib/client.js has no logos:begin / logos:end markers')
const body = Object.entries(logos).map(([key, uri]) => `\t\t\t${JSON.stringify(key)}: ${JSON.stringify(uri)}`).join(',\n')
writeFileSync(target, `${source.slice(0, from + begin.length)}{\n${body}\n\t\t}${source.slice(to)}`)
console.log(`inlined ${Object.keys(logos).length} logos`)
