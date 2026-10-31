import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.window = { __ModuleLoader__: { load: (definition) => { globalThis.loaded = definition } } }
await import('../lib/client.js')
const { labelCss } = globalThis.loaded.factory(() => ({}))
const css = labelCss()
const rules = css.split('\n').map((rule) => ({ selectors: rule.slice(0, rule.indexOf('{')).split(','), body: rule.slice(rule.indexOf('{')) }))

function indexOf(selector) {
  const index = rules.findIndex((rule) => rule.selectors.includes(selector))
  assert.ok(index >= 0, `no rule for ${selector}`)
  return index
}

const LABEL = '[data-provider-id][data-model-id]'

test('every model label gets the Models glyph first', () => {
  assert.equal(indexOf(`${LABEL}::before`), 0)
  assert.match(rules[0].body, /content:""/)
})

test('DeepSeek Harness routes and aio agents get provider marks', () => {
  for (const selector of [
    `${LABEL}[data-provider-id*="deepseek" i]::before`,
    `${LABEL}[data-provider-id*="openrouter" i]::before`,
    `${LABEL}[data-provider-id="aio-cursor"]::before`,
    `${LABEL}[data-provider-id="aio-opencode"]::before`,
  ]) assert.ok(indexOf(selector) > 0)
})

test('model families come after providers, so they win at equal specificity', () => {
  const provider = indexOf(`${LABEL}[data-provider-id="aio-cursor"]::before`)
  for (const selector of [
    `${LABEL}[data-model-id^="gpt-" i]::before`,
    `${LABEL}[data-model-id*="/deepseek" i]::before`,
    `${LABEL}[data-model-id^="opus" i]::before`,
  ]) assert.ok(indexOf(selector) > provider)
})

test('color marks keep their fills, others take the placement tone', () => {
  assert.match(rules[indexOf(`${LABEL}[data-model-id^="gemini" i]::before`)].body, /mask:none;background:url/)
  assert.match(rules[indexOf(`${LABEL}[data-model-id^="grok" i]::before`)].body, /background:var\(--aio-mark-tone,currentColor\)/)
  assert.match(rules[indexOf(`[role="menuitemradio"] ${LABEL}`)].body, /--aio-mark-tone:var\(--dsw-alias-menu-icon/)
})

test('every mark is inlined', () => {
  assert.doesNotMatch(css, /url\("undefined"\)/)
})
