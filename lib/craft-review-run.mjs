// One review by the craft binary for a host whose tool runs it — pi's extension (lib/pi-extension.mjs) and OpenCode's
// `review` tool (integrations/opencode/plugin/tools.ts): `bin/craft review run --backend <host> --events json` as its
// own process (realm @nick/craft, nodes #499, #500), its stderr read as the event stream (#506), its stdout as the
// answer — the `## Verdict` block. What it reports for a view: the progress so far as one line, and the verdict, the
// report and the findings once it ends.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The wrapper beside this plugin's lib/. */
export const WRAPPER = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'bin', 'craft')

/** @typedef {{ type: string } & Record<string, unknown>} ReviewEvent */
/** @typedef {{ phase: string, round: number, running: number, done: number, failed: number, line: string }} Progress */
/** @typedef {{ verdict: string, report: string | null, run: string | null, findings: string[] }} Summary */
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

/**
 * The review run to its end. `onProgress` hears each change; an abort of `signal` stops the process and rejects.
 * @param {{ backend: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, onProgress?: (p: Progress) => void, wrapper?: string }} o
 * @returns {Promise<Outcome>}
 */
export function runReview({ backend, args, cwd, env = process.env, signal, onProgress = () => {}, wrapper = WRAPPER }) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [wrapper, 'review', 'run', '--backend', backend, '--events', 'json', ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal ? { signal } : {}),
    })
    /** @type {{ answer: string, rest: string, progress: Progress, result: ReviewEvent | null, said: string[] }} */
    const out = { answer: '', rest: '', progress: START, result: null, said: [] }
    const take = (/** @type {string} */ line) => {
      const event = eventOf(line)
      if (!event) {
        if (line.trim()) out.said.push(line)
        return
      }
      if (event.type === 'result') out.result = event
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
    child.on('error', reject)
    child.on('close', code => {
      take(out.rest)
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
