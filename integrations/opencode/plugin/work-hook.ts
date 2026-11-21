// craft's hook at the moment of work, the OpenCode side (realm @nick/craft, nodes #288, #550): the decision and the
// hook log are the craft binary's (`craft hook opencode-message | opencode-compacted`, cli/bin/craft/src/hook/role/
// opencode.rs), the one writer of ~/.craft/hooks.jsonl; this file is the runtime-free core between it and the two
// hosts. host-v1.ts feeds it from `chat.message` and `event`, host-v2.ts from the session `prompt` hook and
// `ctx.event`; each says how the lines reach the message (`deliver`) and whether they can (`placeable`). It runs the
// cached binary of this plugin version (integrations/shared/craft-bin.mjs) and never waits for a download: while it is absent the
// hook is silent and, where the repo has role signs and the switch is on (integrations/shared/craft-hook-repo.sh), starts
// `bin/craft --ensure --background` at most once an hour and says a failed try once (integrations/shared/craft-review-run.mjs's wrapper). Any failure
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

type Modules = [typeof import('../../shared/craft-bin.mjs'), typeof import('../../shared/craft-review-run.mjs')]
let modules: Promise<Modules | null> | undefined
const load = (): Promise<Modules | null> =>
  (modules ??= Promise.all([import('../../shared/craft-bin.mjs'), import('../../shared/craft-review-run.mjs')]).catch(() => null))

// The background try's own gate is integrations/shared/craft-fetch.sh's hour; the hook asks again no sooner either.
const HOUR_MS = 60 * 60 * 1000

type Fetching = { since: number }
type Found = { bin: string | null; said: string }

/**
 * The binary to run, or null with what to say of its absence. Where the repo has role signs and the switch is on, the
 * hook starts the background try (`bin/craft --ensure --background`, at most once an hour) and, when `say`, asks for
 * the line of a failed one (`--ensure --failure`, once per failing streak): OpenCode shows a plugin no line of its
 * own, so it goes into the message part, for the model to tell the user.
 */
async function binary(where: Where, fetching: Fetching, say: boolean): Promise<Found> {
  const m = await load()
  if (!m) return { bin: null, said: '' }
  const bin = m[0].cachedBinary(where.env, where.home)
  if (bin || where.env['CRAFT_BIN']) return { bin, said: '' }
  // As in Claude Code: no download where the hooks would say nothing — no role signs, or the switch off (#276).
  if (!(await speaks(where))) return { bin: null, said: '' }
  const env = { ...where.env, HOME: where.home }
  if (Date.now() - fetching.since >= HOUR_MS) {
    fetching.since = Date.now()
    const child = spawn('sh', [m[1].WRAPPER, '--ensure', '--background'], { detached: true, stdio: 'ignore', env })
    child.on('error', () => undefined)
    child.unref()
  }
  const failed = say ? await output('sh', [m[1].WRAPPER, '--ensure', '--failure'], null, env) : ''
  return { bin: null, said: failed ? `craft: tell the user: ${failed}.` : '' }
}

const REPO_TEST = fileURLToPath(new URL('../../shared/craft-hook-repo.sh', import.meta.url))

/** Whether the hooks would speak in the hook's directory: integrations/shared/craft-hook-repo.sh, the repo test while the binary is absent. */
function speaks(where: Where): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('sh', [REPO_TEST, 'speaks', where.directory, 'opencode'], { stdio: 'ignore', env: { ...where.env, HOME: where.home } })
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/** `craft hook <name>` over `input`: its stdout, '' on any failure. */
export function runHook(bin: string, name: string, input: object, where: Where): Promise<string> {
  return output(bin, ['hook', name], input, { ...where.env, HOME: where.home })
}

/** `cmd args` with `input` as JSON on stdin (none when null): its stdout less the last newline, '' on any failure or past the limit. */
function output(cmd: string, args: string[], input: object | null, env: Env): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'], env })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), LIMIT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (out += chunk))
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve(code === 0 ? out.replace(/\n$/, '') : '')
    })
    if (input) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(JSON.stringify(input))
    }
  })
}

/**
 * The hook's core. `engineSessions` are the sessions the plugin's own workflows opened (orchestrator.ts): their
 * agents are the loop and hear nothing, as the Workflow tool's do in Claude Code.
 */
export function workHook(directory: string, engineSessions: ReadonlySet<string>, home: string = homedir(), env: Env = process.env): WorkHook {
  const where = { directory, home, env }
  const fetching = { since: -Infinity }
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
        const { bin } = await binary(where, fetching, false)
        if (bin) await runHook(bin, 'opencode-compacted', { session, cwd: directory }, where)
      } catch {
        /* silence */
      }
    },
    async message(session, prompt, agent, deliver, placeable = true) {
      try {
        const subagent = firstOf(session, agent)
        if (subagent === null) return
        const { bin, said } = await binary(where, fetching, placeable)
        const text = bin ? await runHook(bin, 'opencode-message', { prompt, session, cwd: directory, placeable, ...subagent }, where) : said
        if (text && placeable) deliver(text)
      } catch {
        /* silence */
      }
    },
  }
}
