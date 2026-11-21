// craft's hook at the moment of work, the OpenCode side (realm @nick/craft, nodes #288, #550): the decision and the
// hook log are the craft binary's (`craft hook opencode-message | opencode-compacted`, cli/bin/craft/src/hook/role/
// opencode.rs), the one writer of ~/.craft/hooks.jsonl; this file is the runtime-free core between it and the two
// hosts. host-v1.ts feeds it from `chat.message` and `event`, host-v2.ts from the session `prompt` hook and
// `ctx.event`; each says how the lines reach the message (`deliver`) and whether they can (`placeable`). It runs the
// cached binary of this plugin version (lib/craft-bin.mjs) and never waits for a download: while it is absent the
// hook is silent and, where the repo has role signs and the switch is on (lib/craft-hook-repo.sh), starts
// `bin/craft --ensure --background` once (lib/craft-review-run.mjs's wrapper). Any failure
// is silence: the hook must never cost the plugin its tools (realm @nick/craft, #276).
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { WorkHook } from './host.ts'

type Env = Record<string, string | undefined>
type Where = { directory: string; home: string; env: Env }
type Subagent = { parent: string; agent: string }

// Within OpenCode's own message handling: past it the hook gives up and says nothing.
const LIMIT_MS = 10_000

type Modules = [typeof import('../../../lib/craft-bin.mjs'), typeof import('../../../lib/craft-review-run.mjs')]
let modules: Promise<Modules | null> | undefined
const load = (): Promise<Modules | null> =>
  (modules ??= Promise.all([import('../../../lib/craft-bin.mjs'), import('../../../lib/craft-review-run.mjs')]).catch(() => null))

/** The binary to run, or null; when it is absent, its download is started once per hook, in the background. */
async function binary(where: Where, state: { fetching: boolean }): Promise<string | null> {
  const m = await load()
  if (!m) return null
  const bin = m[0].cachedBinary(where.env, where.home)
  if (bin || state.fetching || where.env['CRAFT_BIN']) return bin
  state.fetching = true
  // As in Claude Code: no download where the hooks would say nothing — no role signs, or the switch off (#276).
  if (!(await speaks(where))) return null
  const child = spawn('sh', [m[1].WRAPPER, '--ensure', '--background'], {
    detached: true,
    stdio: 'ignore',
    env: { ...where.env, HOME: where.home },
  })
  child.on('error', () => undefined)
  child.unref()
  return null
}

const REPO_TEST = fileURLToPath(new URL('../../../lib/craft-hook-repo.sh', import.meta.url))

/** Whether the hooks would speak in the hook's directory: lib/craft-hook-repo.sh, the repo test while the binary is absent. */
function speaks(where: Where): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('sh', [REPO_TEST, 'speaks', where.directory, 'opencode'], { stdio: 'ignore', env: { ...where.env, HOME: where.home } })
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/** `craft hook <name>` over `input`: its stdout, '' on any failure. */
export function runHook(bin: string, name: string, input: object, where: Where): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(bin, ['hook', name], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...where.env, HOME: where.home } })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), LIMIT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (out += chunk))
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve(code === 0 ? out.replace(/\n$/, '') : '')
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(input))
  })
}

/**
 * The hook's core. `engineSessions` are the sessions the plugin's own workflows opened (orchestrator.ts): their
 * agents are the loop and hear nothing, as the Workflow tool's do in Claude Code.
 */
export function workHook(directory: string, engineSessions: ReadonlySet<string>, home: string = homedir(), env: Env = process.env): WorkHook {
  const where = { directory, home, env }
  const state = { fetching: false }
  // A subagent's session → its parent (and agent, when the runtime names it at creation) until its first
  // message, then null: later messages stay silent.
  const children = new Map<string, Subagent | null>()
  // What a message of `session` tells the binary of its subagent; null when it is not asked at all.
  const firstOf = (session: string, agent: string | undefined): Partial<Subagent> | null => {
    const child = children.get(session)
    if (engineSessions.has(session) || child === null) return null
    if (child === undefined) return {}
    children.set(session, null)
    return { parent: child.parent, agent: agent ?? child.agent }
  }
  return {
    childCreated(id, parent, agent) {
      children.set(id, { parent, agent: agent ?? '' })
    },
    async compacted(session) {
      try {
        const bin = await binary(where, state)
        if (bin) await runHook(bin, 'opencode-compacted', { session, cwd: directory }, where)
      } catch {
        /* silence */
      }
    },
    async message(session, prompt, agent, deliver, placeable = true) {
      try {
        const subagent = firstOf(session, agent)
        if (subagent === null) return
        const bin = await binary(where, state)
        const text = bin ? await runHook(bin, 'opencode-message', { prompt, session, cwd: directory, placeable, ...subagent }, where) : ''
        if (text && placeable) deliver(text)
      } catch {
        /* silence */
      }
    },
  }
}
