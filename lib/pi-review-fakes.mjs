// Fake `craft` and `pi` binaries for the pi review driver's tests (lib/pi-review.test.mjs). Each is written by a child
// process (`cat > tmp && chmod +x && mv`), never by the test process itself: a test that execs a file it holds open
// for writing can fail with ETXTBSY under a parallel runner.
import { execFileSync } from 'node:child_process'

/** Write `text` to `file` as an executable, through sh. @param {string} file @param {string} text */
export function writeExecutable(file, text) {
  execFileSync('sh', ['-c', 'cat > "$1.tmp" && chmod +x "$1.tmp" && mv "$1.tmp" "$1"', 'sh', file], { input: text })
}

// The fake binary: `review start` lays out the first of FAKE_STEPS (JSON: a list of steps, each a list of tasks) in
// FAKE_RUN; each `review submit` logs its argv and the answers it found to submits.jsonl there, then lays out the next
// step, or finishes the run with one finding once none is left.
export const FAKE_CRAFT = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const [, , cmd, sub, ...rest] = process.argv
const run = process.env.FAKE_RUN, steps = JSON.parse(process.env.FAKE_STEPS)
if (cmd !== 'review') process.exit(3)
function step(n) {
  fs.writeFileSync(path.join(run, 'at'), String(n))
  if (n >= steps.length) return { run, done: true, report: path.join(run, 'report.md'), verdict: 'Approve', line: 'Approve — fake review', findings: [{ severity: 'High', file: 'src/a.rs', line: 3, title: 'a fake finding', tier: 'confirmed' }] }
  const tasks = steps[n].map(t => {
    const promptFile = path.join(run, 'tasks', t.id + '.md'), schemaFile = path.join(run, 'tasks', t.id + '.schema.json')
    fs.writeFileSync(promptFile, t.prompt)
    fs.writeFileSync(schemaFile, '{"type":"object"}')
    return { id: t.id, label: t.id, model: t.model, kind: 'lens', ...(t.agentType ? { agentType: t.agentType } : {}), promptFile, schemaFile, answerFile: path.join(run, 'answers', t.id + '.json') }
  })
  return { run, done: false, phase: 'Lenses', tasks }
}
if (sub === 'start') {
  fs.mkdirSync(path.join(run, 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(run, 'start.json'), JSON.stringify(rest))
  console.log(JSON.stringify(step(0)))
} else if (sub === 'submit') {
  const answers = path.join(run, 'answers')
  const answered = fs.existsSync(answers) ? fs.readdirSync(answers).sort() : []
  fs.appendFileSync(path.join(run, 'submits.jsonl'), JSON.stringify({ argv: rest, answered }) + '\\n')
  console.log(JSON.stringify(step(Number(fs.readFileSync(path.join(run, 'at'), 'utf8')) + 1)))
} else process.exit(4)
`

// The fake pi: logs each call (argv, the cwd, CLAUDE_PLUGIN_ROOT and how many fakes were alive at once) to FAKE_LOG,
// and acts on a word in its task prompt: FAIL exits 1, HANG sleeps, LIMIT says the usage limit, NOLOGIN says no provider
// is logged in, SILENT exits 0 with no answer, PROSE prints its answer as a bare object after prose with braces in it;
// otherwise it prints its answer in a fenced json block after a line of prose.
export const FAKE_PI = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const log = process.env.FAKE_LOG, argv = process.argv.slice(2), message = argv[argv.length - 1]
const me = path.join(log, 'live', String(process.pid))
fs.mkdirSync(path.dirname(me), { recursive: true })
fs.writeFileSync(me, '')
const alive = fs.readdirSync(path.dirname(me)).length
const prompt = fs.readFileSync(/Read the file (\\S+) and/.exec(message)[1], 'utf8')
fs.writeFileSync(path.join(log, 'call-' + process.pid + '.json'), JSON.stringify({ argv, message, prompt, alive, cwd: process.cwd(), root: process.env.CLAUDE_PLUGIN_ROOT }))
setTimeout(() => {
  fs.rmSync(me)
  if (prompt.includes('FAIL')) { console.error('boom'); process.exit(1) }
  if (prompt.includes('LIMIT')) { console.error("Error: You've hit your usage limit. Try again in 3 hours."); process.exit(1) }
  if (prompt.includes('NOLOGIN')) { console.error('No API key found for the selected model.'); process.exit(1) }
  if (prompt.includes('SILENT')) { console.log('done'); process.exit(0) }
  if (prompt.includes('PROSE')) { console.log('Checked {the diff} and found {"draft": tru} nothing else.\\nAnswer: {"answer": "prose {ok}", "n": 2} — that is all.'); process.exit(0) }
  console.log('I reviewed it.\\n\\n\\u0060\\u0060\\u0060json\\n{ "answer": "ok" }\\n\\u0060\\u0060\\u0060')
}, prompt.includes('HANG') ? 60000 : 300)
`
