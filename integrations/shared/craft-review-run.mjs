// One review by the craft binary for a host whose tool runs it — pi's extension (integrations/pi/pi-extension.mjs) and OpenCode's
// `review` tool (integrations/opencode/plugin/tools.ts): `bin/craft review run --backend <host> --events json` as its
// own process (realm @nick/craft, nodes #499, #500), its stderr read as the event stream (#506), its stdout as the
// answer — the `## Verdict` block. What it reports for a view: the progress so far as one line, and the verdict, the
// report and the findings once it ends. With `onTask` the run delegates its tasks (`--delegate`): each `task` event is
// run by the host's tool — OpenCode 2.x's child sessions (realm @nick/craft, nodes #496, #626) — and its reply written to
// the binary's stdin under the event's key; a `task_cancelled` event aborts that task.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The wrapper beside this plugin's integrations/shared/. */
export const WRAPPER = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), 'bin', 'craft')

/** @typedef {{ type: string } & Record<string, unknown>} ReviewEvent */
/** @typedef {{ phase: string, round: number, running: number, done: number, failed: number, line: string }} Progress */
/** @typedef {{ verdict: string, report: string | null, run: string | null, findings: string[] }} Summary */
/** @typedef {{ key: number, id: string, label: string, agent: string | null, model: string | null, prompt: string }} DelegatedTask */
/** @typedef {(task: DelegatedTask, signal: AbortSignal) => Promise<string>} RunTask  the task's reply text; a rejection is its failure, said to the binary */
/** @typedef {{ code: number, answer: string, result: ReviewEvent | null, said: string[], progress: Progress }} Outcome  said: the stderr lines that were no event (the wrapper's own failure) */

export const START = Object.freeze(/** @type {Progress} */ ({ phase: '', round: 0, running: 0, done: 0, failed: 0, line: '' }))

/**
 * The words of `text` as a shell would split them, single and double quotes kept together; no expansion.
 * @param {string} text @returns {string[]}
 */
export function flagWords(text) {
  /** @type {string[]} */
  const words = []
  for (const m of text.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)) words.push(m[0].replace(/"([^"]*)"|'([^']*)'/g, '$1$2'))
  return words
}

/** What each event changes in the progress. @type {Record<string, (p: Progress, e: ReviewEvent) => Progress>} */
const STEPS = {
  phase: (p, e) => ({ ...p, phase: String(e['name']) }),
  round: (p, e) => ({ ...p, phase: String(e['phase']), round: Number(e['round']) }),
  task_started: p => ({ ...p, running: p.running + 1 }),
  task_finished: p => ({ ...p, running: Math.max(0, p.running - 1), done: p.done + 1 }),
  task_failed: p => ({ ...p, running: Math.max(0, p.running - 1), failed: p.failed + 1 }),
  log: (p, e) => ({ ...p, line: String(e['line']) }),
  usage_limit: (p, e) => ({ ...p, line: `usage limit: ${String(e['text'])}` }),
}

/** The progress after `event`. @param {Progress} p @param {ReviewEvent} event @returns {Progress} */
export const advance = (p, event) => STEPS[event.type]?.(p, event) ?? p

/** The progress as one line. @param {Progress} p */
export function progressLine(p) {
  const where = `${p.phase || 'starting'}${p.round ? `, round ${p.round}` : ''}`
  const tasks = `${p.running} running, ${p.done} done${p.failed ? `, ${p.failed} failed` : ''}`
  return `craft review: ${where} — ${tasks}`
}

/** The event a stderr line is, or null for any other line. @param {string} line @returns {ReviewEvent | null} */
function eventOf(line) {
  if (!line.startsWith('{')) return null
  try {
    /** @type {unknown} */
    const value = JSON.parse(line)
    return value && typeof value === 'object' && 'type' in value && typeof value.type === 'string' ? /** @type {ReviewEvent} */ (value) : null
  } catch {
    return null
  }
}

/** @param {unknown} e @returns {string} */
const messageOf = e => (e instanceof Error ? e.message : String(e))

/**
 * The delegated tasks of one run: `heard` takes a `task` or `task_cancelled` event, `reply` writes a reply line to the
 * binary, and `stop` aborts every task still running once the binary is gone.
 * @param {RunTask} onTask @param {(line: string) => void} reply
 */
export function delegation(onTask, reply) {
  /** @type {Map<number, AbortController>} */
  const running = new Map()
  /** @param {ReviewEvent} event */
  const heard = event => {
    const key = Number(event['key'])
    if (event.type === 'task_cancelled') running.get(key)?.abort()
    if (event.type !== 'task') return
    const stop = new AbortController()
    running.set(key, stop)
    onTask(/** @type {DelegatedTask} */ (/** @type {unknown} */ (event)), stop.signal)
      .then(
        text => {
          reply(JSON.stringify({ key, text }))
        },
        (/** @type {unknown} */ e) => {
          reply(JSON.stringify({ key, error: messageOf(e) }))
        },
      )
      .finally(() => running.delete(key))
  }
  const stop = () => {
    for (const s of running.values()) s.abort()
  }
  return { heard, stop }
}

/**
 * The review run to its end. `onProgress` hears each change; an abort of `signal` stops the process and rejects.
 * `onTask`, when given, runs each task the binary delegates.
 * @param {{ backend: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, onProgress?: (p: Progress) => void, onTask?: RunTask, wrapper?: string }} o
 * @returns {Promise<Outcome>}
 */
export function runReview({ backend, args, cwd, env = process.env, signal, onProgress = () => {}, onTask, wrapper = WRAPPER }) {
  return new Promise((resolve, reject) => {
    const delegated = onTask ? ['--delegate'] : []
    const child = spawn('sh', [wrapper, 'review', 'run', '--backend', backend, '--events', 'json', ...delegated, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(signal ? { signal } : {}),
    })
    // A reply after the binary is gone is lost with it: the write's error is not the run's. A run that delegates
    // nothing reads no input: it gets an empty one.
    child.stdin.on('error', () => undefined)
    if (!onTask) child.stdin.end()
    const tasks = onTask
      ? delegation(onTask, line => {
          if (child.stdin.writable) child.stdin.write(`${line}\n`)
        })
      : null
    /** @type {{ answer: string, rest: string, progress: Progress, result: ReviewEvent | null, said: string[] }} */
    const out = { answer: '', rest: '', progress: START, result: null, said: [] }
    const take = (/** @type {string} */ line) => {
      const event = eventOf(line)
      if (!event) {
        if (line.trim()) out.said.push(line)
        return
      }
      if (event.type === 'result') out.result = event
      tasks?.heard(event)
      const next = advance(out.progress, event)
      if (next !== out.progress) onProgress((out.progress = next))
    }
    child.stdout.setEncoding('utf8').on(
      'data',
      /** @param {string} chunk */ chunk => {
        out.answer += chunk
      },
    )
    child.stderr.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      const lines = (out.rest + chunk).split('\n')
      out.rest = lines.pop() ?? ''
      lines.forEach(take)
    })
    child.on('error', e => {
      tasks?.stop()
      reject(e)
    })
    child.on('close', code => {
      take(out.rest)
      tasks?.stop()
      resolve({ code: code ?? 1, answer: out.answer, result: out.result, said: out.said, progress: out.progress })
    })
  })
}

/** The `- …` lines of the answer's `## Findings` section. @param {string} answer */
function findingLines(answer) {
  const lines = answer.split('\n')
  const from = lines.indexOf('## Findings')
  if (from < 0) return []
  const rest = lines.slice(from + 1)
  const end = rest.findIndex(l => l.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).filter(l => l.startsWith('- '))
}

/** The verdict, the report, the run and the findings of an ended run. @param {Outcome} o @returns {Summary} */
export function summaryOf(o) {
  const text = (/** @type {string} */ k) => (typeof o.result?.[k] === 'string' && o.result[k] ? o.result[k] : null)
  return { verdict: text('verdict') ?? 'INCOMPLETE', report: text('report'), run: text('run'), findings: findingLines(o.answer) }
}

/** What the host's model is told: the answer, or why there is none. @param {Outcome} o */
export function answerText(o) {
  if (o.answer.trim()) return o.answer.trim()
  const said = o.said.slice(-5).join('\n')
  return `## Verdict\n\nINCOMPLETE — the craft review gave no answer (exit ${o.code})${said ? `:\n\n${said}` : ''}`
}
