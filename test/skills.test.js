import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { discoverSkills, loadSkill, parseSkillDocument, renderInjectedSkill, skillNameFrom, withSkillMessages } from '../lib/skills.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aio-skills-'))
  const project = join(root, 'project')
  const home = join(root, 'home')
  const write = async (path, body) => {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), body)
  }
  await write('project/.git', '')
  await write('project/pkg/.keep', '')
  await write('project/.dsh/skills/shared/SKILL.md', '---\nname: shared\ndescription: from dsh\n---\nDSH body\n')
  await write('project/.claude/skills/shared/SKILL.md', '---\nname: shared\ndescription: from claude\n---\nClaude body\n')
  await write('project/.claude/skills/review/SKILL.md', '---\nname: review\ndescription: >\n  Review a diff\n  before merging.\nuser-invocable: true\n---\n# Review\nRead the diff.\n')
  await write('project/.cursor/skills/autopilot/SKILL.md', '---\nname: autopilot\ndescription: >-\n  Keep a PR merge-ready by triaging comments.\n---\n# Autopilot\nWork the loop.\n')
  await write('project/.claude/commands/ship.md', '# Ship\n\nPublish the branch.\n')
  await write('project/.cursor/skills/bare/SKILL.md', 'No frontmatter here.\nStill a skill.\n')
  await write('project/.kimi/skills/changelog/SKILL.md', '---\nwhenToUse: When the user asks for a changelog\n---\nWrite the notes.\n')
  await write('project/.agents/skills/quiet/SKILL.md', '---\nname: quiet\ndescription: Hidden from the menu\nuser-invocable: false\n---\nStay quiet.\n')
  await write('home/.dsh/skills/.system/hidden/SKILL.md', '---\nname: hidden\ndescription: bundled\n---\nnope\n')
  await write('home/.dsh/skills/global-note/SKILL.md', '---\nname: global-note\ndescription: from home\n---\nHome body\n')
  await write('home/.claude/skills/home-only/SKILL.md', '---\nname: Home Only\ndescription: user skill\n---\nUser body\n')
  return { root, project, home, cwd: join(project, 'pkg') }
}

test('a skill name is kebab-case, including titles', () => {
  assert.equal(skillNameFrom('Review Diff'), 'review-diff')
  assert.equal(skillNameFrom(''), undefined)
  assert.equal(skillNameFrom('---'), undefined)
})

test('missing frontmatter still yields a name and a description', () => {
  const parsed = parseSkillDocument('# Title\n\nFirst paragraph of the skill.\n\nMore.', 'Ship It', '/skills/ship.md', '/skills')
  assert.equal(parsed.name, 'ship-it')
  assert.equal(parsed.description, 'First paragraph of the skill.')
  assert.match(parsed.content, /First paragraph/)
})

test('project and user skill directories are discovered, with the higher-priority copy winning', async () => {
  const { root, home, cwd } = await fixture()
  try {
    const skills = await discoverSkills(cwd, { home })
    const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]))
    assert.equal(byName.shared.description, 'from dsh')
    assert.equal(byName.shared.source, 'project:.dsh/skills')
    assert.equal(byName.shared.rank, 100)
    assert.equal(byName.review.description, 'Review a diff before merging.')
    assert.equal(byName.autopilot.description, 'Keep a PR merge-ready by triaging comments.')
    assert.equal(byName.review.resourceBase.kind, 'directory')
    assert.equal(byName.ship.description, 'Publish the branch.')
    assert.match(byName.ship.path, /ship\.md$/)
    assert.equal(byName.bare.description, 'No frontmatter here. Still a skill.')
    assert.equal(byName.changelog.description, 'When the user asks for a changelog')
    assert.equal(byName.changelog.whenToUse, 'When the user asks for a changelog')
    assert.equal(byName['global-note'].source, 'user:.dsh/skills')
    assert.equal(byName['home-only'].description, 'user skill')
    assert.equal(byName.quiet.invocation.userInvocable, false)
    assert.equal(byName.hidden, undefined)
    const loaded = await loadSkill(byName.review)
    assert.match(loaded.content, /Read the diff/)
    assert.equal(loaded.provider, 'aio-skills')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an explicit /skill-name appends skill_content without rewriting the user message', async () => {
  const skill = {
    name: 'review',
    description: 'Review a diff',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'aio-skills',
    content: 'Read the diff.',
    resourceBase: { kind: 'directory', path: '/skills/review' },
  }
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'please /review the patch' }] }]
  const skills = { async get(name) { return name === 'review' ? skill : undefined } }
  const out = await withSkillMessages(skills, messages, { cwd: '/work' })
  assert.equal(out[0], messages[0])
  assert.equal(out[1].content[0].text, renderSkillContent(skill))
  assert.equal(renderInjectedSkill(skill), renderSkillContent(skill))
  const quiet = { ...skill, name: 'quiet', invocation: { modelInvocable: true, userInvocable: false } }
  const skipped = await withSkillMessages({ async get() { return quiet } }, [{ role: 'user', content: [{ type: 'text', text: '/quiet' }] }])
  assert.equal(skipped.length, 1)
  const plain = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  assert.equal(await withSkillMessages(skills, plain), plain)
})
