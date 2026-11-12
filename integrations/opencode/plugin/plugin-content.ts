// craft's agents, commands and skills registered by the plugin itself on OpenCode 2.x, when it runs from the package
// `opencode plugin add` installed (realm @nick/craft, node #515): 2.x reads no agents/, commands/ or skills/ folder
// inside a package (#514), so the plugin hands each one to the runtime's editors (opencode-v2.d.ts).
// An install.sh install (a checkout linked into .opencode/) is left to 2.x's own config loader, which reads the same
// files from the links: the plugin registers only when the root above it is the package — its package.json names
// PACKAGE_NAME (lib/opencode-package.mjs writes it) — so the two never both write one agent, and a user's own file of
// that name in a config folder keeps its place.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMarkdown, type FrontValue } from './frontmatter.ts'
import type { V2Context } from './opencode-v2.js'
import type { V2AgentDraft, V2CommandDefinition, V2PermissionRule, V2Skill } from './opencode-v2-editors.js'

export const PACKAGE_NAME = 'craft-opencode'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const OPENCODE = path.join('integrations', 'opencode')

/** Whether `root` is the package's root: its package.json names the package. */
export function isPackage(root: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: unknown }).name === PACKAGE_NAME
  } catch {
    return false
  }
}

const markdownIn = (dir: string) =>
  (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({ id: f.slice(0, -3), ...parseMarkdown(fs.readFileSync(path.join(dir, f), 'utf8')) }))

const text = (v: FrontValue | undefined) => (typeof v === 'string' ? v : undefined)
const EFFECTS = new Set(['allow', 'deny', 'ask'])
// A 1.x tool or permission name as 2.x names its action, as 2.2.7's own reading of a 1.x agent file does.
const ACTION: Record<string, string> = { write: 'edit', patch: 'edit', apply_patch: 'edit', task: 'subagent', bash: 'shell' }
const action = (name: string) => ACTION[name] ?? name
const rule = (name: string, resource: string, effect: unknown): V2PermissionRule[] =>
  typeof effect === 'string' && EFFECTS.has(effect) ? [{ action: action(name), resource, effect: effect as V2PermissionRule['effect'] }] : []

/** A 1.x agent file's `tools` (on/off) and `permission` (an effect, or one per pattern) as 2.x permission rules. */
export function permissionsOf(data: Record<string, FrontValue>): V2PermissionRule[] {
  const tools = typeof data['tools'] === 'object' ? Object.entries(data['tools']) : []
  const asked = typeof data['permission'] === 'object' ? Object.entries(data['permission']) : []
  return [...tools.flatMap(([name, on]) => rule(name, '*', on ? 'allow' : 'deny')), ...asked.flatMap(([name, effect]) => rule(name, '*', effect))]
}

const MODES = new Set(['subagent', 'primary', 'all'])

/** One agent file applied to the runtime's draft of that agent. */
export function applyAgent(draft: V2AgentDraft, data: Record<string, FrontValue>, body: string): void {
  const description = text(data['description'])
  if (description !== undefined) draft.description = description
  const mode = text(data['mode'])
  if (mode !== undefined && MODES.has(mode)) draft.mode = mode as V2AgentDraft['mode']
  if (typeof data['hidden'] === 'boolean') draft.hidden = data['hidden']
  if (body) draft.system = body
  draft.permissions.push(...permissionsOf(data))
}

/** A command file as a 2.x command: its body, `$ARGUMENTS` replaced, prompted into the calling session. */
export function commandOf(ctx: V2Context, name: string, data: Record<string, FrontValue>, template: string): V2CommandDefinition {
  const description = text(data['description'])
  return {
    name,
    ...(description === undefined ? {} : { description }),
    execute: inv =>
      ctx.session.prompt({
        ...inv.prompt,
        sessionID: inv.sessionID,
        text: template.replaceAll('$ARGUMENTS', () => inv.prompt.text.trim()),
        ...(inv.delivery === undefined ? {} : { delivery: inv.delivery }),
      }),
  }
}

/** The skills under `root`/skills, each directory with a SKILL.md. */
export function skillsUnder(root: string): V2Skill[] {
  const dir = path.join(root, 'skills')
  return (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []).flatMap(id => {
    const file = path.join(dir, id, 'SKILL.md')
    if (!fs.existsSync(file)) return []
    const { data, body } = parseMarkdown(fs.readFileSync(file, 'utf8'))
    const description = text(data['description'])
    return [{ id, name: text(data['name']) ?? id, ...(description === undefined ? {} : { description }), path: file, content: body }]
  })
}

type Registration = { dispose(): Promise<void> }

/** Each registration made in turn; when one throws, those already made are disposed before the error goes on. */
async function registerAll(steps: (() => Promise<Registration>)[]): Promise<() => Promise<void>> {
  const regs: Registration[] = []
  const dispose = async () => {
    for (const reg of regs.splice(0).reverse()) await reg.dispose()
  }
  try {
    for (const step of steps) regs.push(await step())
  } catch (e) {
    await dispose().catch(() => undefined)
    throw e
  }
  return dispose
}

/** Registers the package's agents, commands and skills; a checkout's install is left alone. Resolves to the disposer. */
async function registerContent(ctx: V2Context, root = ROOT): Promise<() => Promise<void>> {
  if (!isPackage(root)) return async () => {}
  const agents = markdownIn(path.join(root, OPENCODE, 'agents'))
  const commands = markdownIn(path.join(root, OPENCODE, 'commands'))
  const skills = skillsUnder(root)
  return registerAll([
    () =>
      ctx.agent.transform(editor => {
        for (const a of agents) editor.update(a.id, draft => applyAgent(draft, a.data, a.body))
      }),
    () =>
      ctx.command.transform(editor => {
        for (const c of commands) editor.add(commandOf(ctx, c.id, c.data, c.body))
      }),
    () =>
      ctx.skill.transform(editor => {
        for (const s of skills) editor.add(s)
      }),
  ])
}

/** What became of the registration: its disposer, and why it failed when it did. */
interface ContentOutcome {
  dispose(): Promise<void>
  failed?: string
}

/**
 * The registration, a failure turned into its reason: logged as one `craft:` line (OpenCode's log takes stderr) and
 * handed back, so the tools can say it — a 2.x whose editors changed must not lose craft's agents without a trace.
 */
export async function registerOrSay(ctx: V2Context, root = ROOT, log: (line: string) => void = console.error): Promise<ContentOutcome> {
  try {
    return { dispose: await registerContent(ctx, root) }
  } catch (e) {
    const failed = e instanceof Error ? e.message : String(e)
    log(`craft: could not register its agents, commands and skills on this OpenCode: ${failed}`)
    return { dispose: async () => {}, failed }
  }
}
