import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasSkillTool, namedSkills, pluginPaths, skillAccessProblems } from './agent-skill-paths.mjs'
import { parseFrontmatter } from './check-skills.mjs'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DELIVERY = path.join(ROOT_DIR, 'integrations', 'claude-code')

/** A plugin root holding `skills/rust-review/SKILL.md` only. */
function fakeRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-paths-'))
  fs.mkdirSync(path.join(d, 'skills', 'rust-review'), { recursive: true })
  fs.writeFileSync(path.join(d, 'skills', 'rust-review', 'SKILL.md'), '# x\n')
  return d
}

test('the Skill tool is read from a list or a comma string, not from a longer name', () => {
  assert.equal(hasSkillTool('["Read", "Skill"]'), true)
  assert.equal(hasSkillTool('Bash, Skill'), true)
  assert.equal(hasSkillTool('["Read", "Grep", "Glob", "Bash"]'), false)
  assert.equal(hasSkillTool('SkillSearch'), false)
})

test('a skill is named by `craft:` or by "skill" after it, and a longer name does not count', () => {
  const skills = ['rust-review', 'review', 'rust-navigation']
  assert.deepEqual(namedSkills("apply the `rust-review` skill's rubric", skills), ['rust-review'])
  assert.deepEqual(namedSkills('per the rust-navigation skill, see craft:review', skills), ['review', 'rust-navigation'])
  assert.deepEqual(namedSkills('the rust-review workflow', skills), [])
})

test('a backticked skill name alone counts, as the bodies on origin/main listed them', () => {
  const skills = ['nix-flakes', 'nix-packaging', 'nix-dev-env', 'nixos', 'rust-architecture', 'rust-architecture-review']
  // nix-reviewer before this fix: its domain skills, listed with no "skill" after each.
  const nix = 'Reach for the domain skills\n(`nix-flakes`, `nix-packaging`, `nix-dev-env`, `nixos`) when a finding needs their depth.'
  assert.deepEqual(namedSkills(nix, skills), ['nix-dev-env', 'nix-flakes', 'nix-packaging', 'nixos'])
  // rust-architecture-reviewer before this fix: the design vocabulary it cites.
  const arch = 'For the design\n   vocabulary (ports, adapters, the domain rule, when NOT to abstract) cite\n   `rust-architecture`.'
  assert.deepEqual(namedSkills(arch, skills), ['rust-architecture'])
  assert.equal(skillAccessProblems(arch, 'Read', skills, [fakeRoot()]).length, 1)
  assert.deepEqual(namedSkills('a `nix-flakes/anatomy.md` file', skills), [])
})

test('plugin paths are the literal ones, templates left out', () => {
  assert.deepEqual(pluginPaths('read `${CLAUDE_PLUGIN_ROOT}/skills/a/SKILL.md` or `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md`'), ['skills/a/SKILL.md'])
})

test('an agent with no Skill tool told to load a skill by name alone is refused', () => {
  const root = fakeRoot()
  const errs = skillAccessProblems('load the `rust-review` skill', '["Read"]', ['rust-review'], [root])
  assert.equal(errs.length, 1)
  assert.match(errs[0] ?? '', /rust-review skill but has no Skill tool/)
})

test('naming the file the plugin ships passes, a path it does not ship is refused', () => {
  const root = fakeRoot()
  const ok = 'the `rust-review` skill — read `${CLAUDE_PLUGIN_ROOT}/skills/rust-review/SKILL.md`'
  assert.deepEqual(skillAccessProblems(ok, '["Read"]', ['rust-review'], [root]), [])
  const gone = skillAccessProblems('read `${CLAUDE_PLUGIN_ROOT}/skills/gone/SKILL.md`', 'Read, Skill', [], [root])
  assert.deepEqual(gone, ['${CLAUDE_PLUGIN_ROOT}/skills/gone/SKILL.md does not exist in the plugin'])
})

test('a path is found under any of the roots it may be in', () => {
  const body = 'read `${CLAUDE_PLUGIN_ROOT}/skills/rust-review/SKILL.md`'
  assert.deepEqual(skillAccessProblems(body, 'Read', [], [fakeRoot()]), [])
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-paths-'))
  assert.deepEqual(skillAccessProblems(body, 'Read', [], [empty, fakeRoot()]), [])
  assert.equal(skillAccessProblems(body, 'Read', [], [empty]).length, 1)
})

test('an agent with the Skill tool may load a skill by name', () => {
  assert.deepEqual(skillAccessProblems('load the `rust-review` skill', 'Read, Skill', ['rust-review'], [fakeRoot()]), [])
})

test('every shipped Claude Code agent reaches each skill its body names', () => {
  const skills = fs.readdirSync(path.join(ROOT_DIR, 'skills')).filter(s => fs.existsSync(path.join(ROOT_DIR, 'skills', s, 'SKILL.md')))
  const agents = fs.readdirSync(path.join(DELIVERY, 'agents')).filter(f => f.endsWith('.md'))
  assert.ok(agents.length > 0)
  for (const f of agents) {
    const src = fs.readFileSync(path.join(DELIVERY, 'agents', f), 'utf8')
    const body = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    const tools = parseFrontmatter(src)?.get('tools') ?? ''
    assert.deepEqual(skillAccessProblems(body, tools, skills, [DELIVERY, ROOT_DIR]), [], f)
  }
})
