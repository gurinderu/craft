// The package's own registration of agents, commands and skills on 2.x (plugin-content.ts), against a fake `ctx`
// shaped as opencode-v2.d.ts pins the editors, over the files this checkout ships.
import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMarkdown } from './frontmatter.ts'
import { isPackage, PACKAGE_NAME, permissionsOf, registerOrSay } from './plugin-content.ts'
import { PACKAGE_NAME as LAID_OUT_AS } from '../../../lib/opencode-package.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** @type {string[]} */
const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A package root: its package.json, and the checkout's integrations/ and skills/ beside it. @param {string} name */
function packageRoot(name = PACKAGE_NAME) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-pkg-'))
  dirs.push(root)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }))
  for (const d of ['integrations', 'skills']) fs.symlinkSync(path.join(REPO, d), path.join(root, d))
  return root
}

function fakeCtx() {
  /** @type {Map<string, any>} */
  const agents = new Map()
  /** @type {Map<string, any>} */
  const commands = new Map()
  /** @type {Map<string, any>} */
  const skills = new Map()
  /** @type {unknown[]} */
  const prompts = []
  let disposed = 0
  const reg = {
    dispose: () => {
      disposed++
      return Promise.resolve()
    },
  }
  /** @param {(editor: any) => void} edit @param {any} editor */
  const transform = (edit, editor) => (edit(editor), Promise.resolve(reg))
  const defaults = (/** @type {string} */ id) => ({
    id,
    name: id,
    mode: 'primary',
    hidden: false,
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  })
  const ctx = /** @type {import('./opencode-v2.js').V2Context} */ (
    /** @type {unknown} */ ({
      agent: {
        transform: (/** @type {any} */ edit) =>
          transform(edit, {
            update: (/** @type {string} */ id, /** @type {(d: any) => void} */ f) => {
              const d = agents.get(id) ?? defaults(id)
              agents.set(id, d)
              f(d)
            },
          }),
      },
      command: { transform: (/** @type {any} */ edit) => transform(edit, { add: (/** @type {any} */ c) => commands.set(c.name, c) }) },
      skill: { transform: (/** @type {any} */ edit) => transform(edit, { add: (/** @type {any} */ s) => skills.set(s.id, s) }) },
      session: { prompt: (/** @type {unknown} */ input) => (prompts.push(input), Promise.resolve()) },
    })
  )
  return { ctx, agents, commands, skills, prompts, disposed: () => disposed }
}

test('the frontmatter reader takes scalars, quotes, booleans, block scalars and one nested map', () => {
  const md = parseMarkdown(
    '---\na: one\nb: "two: x"\nc: true\nd: >-\n  folded\n  line\n\n  next\ne: |\n  kept\n  lines\nf:\n  g: allow\n  h: false\n---\n\nBody\n',
  )
  assert.deepEqual(md.data, { a: 'one', b: 'two: x', c: true, d: 'folded line\nnext', e: 'kept\nlines', f: { g: 'allow', h: false } })
  assert.equal(md.body, 'Body')
  assert.deepEqual(parseMarkdown('no frontmatter'), { data: {}, body: 'no frontmatter' })
})

test('every shipped agent, command and skill reads with a description', () => {
  const files = [
    ...['agents', 'commands'].flatMap(d =>
      fs.readdirSync(path.join(REPO, 'integrations/opencode', d)).map(f => path.join(REPO, 'integrations/opencode', d, f)),
    ),
    ...fs.readdirSync(path.join(REPO, 'skills')).map(s => path.join(REPO, 'skills', s, 'SKILL.md')),
  ]
  for (const f of files) {
    const { data, body } = parseMarkdown(fs.readFileSync(f, 'utf8'))
    assert.ok(typeof data['description'] === 'string' && data['description'].length > 20 && !data['description'].startsWith('>'), f)
    assert.ok(body.length > 0, f)
  }
})

test("a 1.x agent's tools and permission become 2.x rules, as 2.2.7 reads a 1.x file", () => {
  assert.deepEqual(permissionsOf({ tools: { write: false, bash: true }, permission: { external_directory: 'allow', odd: 'maybe' } }), [
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'shell', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: '*', effect: 'allow' },
  ])
})

test('the package registers the agents, /craft-review and the other commands, and the skills', async () => {
  const f = fakeCtx()
  const outcome = await registerOrSay(f.ctx, packageRoot())
  assert.equal(outcome.failed, undefined)
  const task = f.agents.get('review-task')
  assert.equal(task.mode, 'all')
  assert.equal(task.hidden, true)
  assert.match(task.system, /^You run exactly one task of craft's review/)
  assert.deepEqual(task.permissions.slice(1), [
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'external_directory', resource: '*', effect: 'allow' },
  ])
  assert.equal(f.agents.get('rust-reviewer').mode, 'subagent')
  assert.deepEqual([...f.commands.keys()].sort(), ['craft-review', 'rust-audit', 'triage-findings'])
  await f.commands.get('craft-review').execute({ sessionID: 'ses_1', prompt: { text: ' --base main ' }, delivery: 'queue' })
  const sent = /** @type {any} */ (f.prompts[0])
  assert.equal(sent.sessionID, 'ses_1')
  assert.equal(sent.delivery, 'queue')
  assert.match(sent.text, /`--base main`/)
  assert.doesNotMatch(sent.text, /\$ARGUMENTS/)
  const review = f.skills.get('rust-review')
  assert.equal(review.name, 'rust-review')
  assert.match(review.description, /^Rust code-review rubric/)
  assert.ok(review.path.endsWith(path.join('skills', 'rust-review', 'SKILL.md')))
  assert.match(review.content, /^# Rust Review/)
  await outcome.dispose()
  assert.equal(f.disposed(), 3)
})

test('a checkout (install.sh) registers nothing: 2.x reads its linked files itself', async () => {
  const f = fakeCtx()
  await registerOrSay(f.ctx, packageRoot('craft'))
  assert.equal(f.agents.size + f.commands.size + f.skills.size, 0)
  assert.equal(isPackage(REPO), false)
})

test('the plugin knows the package by the name the release lays it out under', () => {
  assert.equal(PACKAGE_NAME, LAID_OUT_AS)
})

test('an editor that refuses leaves nothing registered, and its reason is logged and handed back', async () => {
  const f = fakeCtx()
  f.ctx.skill.transform = () => Promise.reject(new Error('skill.transform is not a function'))
  /** @type {string[]} */
  const logged = []
  const outcome = await registerOrSay(f.ctx, packageRoot(), line => logged.push(line))
  assert.equal(outcome.failed, 'skill.transform is not a function')
  assert.equal(f.disposed(), 2, 'the agents and commands already registered are disposed')
  assert.deepEqual(logged, ['craft: could not register its agents, commands and skills on this OpenCode: skill.transform is not a function'])
  await outcome.dispose()
  assert.equal(f.disposed(), 2)
})
