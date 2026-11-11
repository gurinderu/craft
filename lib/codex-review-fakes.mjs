// Fake `craft` and `codex` binaries for the Codex review driver's tests (lib/codex-review.test.mjs). Each is written
// by a child process (`cat > tmp && chmod +x && mv`, as the Rust tests' write_executable does), never by the test
// process itself: a test that execs a file it holds open for writing can fail with ETXTBSY under a parallel runner.
import { execFileSync } from 'node:child_process'

/** Write `text` to `file` as an executable, through sh. @param {string} file @param {string} text */
export function writeExecutable(file, text) {
  execFileSync('sh', ['-c', 'cat > "$1.tmp" && chmod +x "$1.tmp" && mv "$1.tmp" "$1"', 'sh', file], { input: text })
}

// The fake binary: `review start` lays out one step of tasks from FAKE_TASKS (JSON) in FAKE_RUN; `review submit`
// logs its argv to submits.jsonl there, hands out again (twice at most) each task with no answer that was not
// abandoned, as the binary retries, and then finishes the run with one finding and FAKE_FILING as its telemetry write;
// under FAKE_BROKEN every submit and status prints no step.
export const FAKE_CRAFT = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const [, , cmd, sub, ...rest] = process.argv
const run = process.env.FAKE_RUN
if (cmd !== 'review') process.exit(3)
if (sub === 'start') {
  fs.mkdirSync(path.join(run, 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(run, 'start.json'), JSON.stringify(rest))
  const tasks = JSON.parse(process.env.FAKE_TASKS).map(t => {
    const promptFile = path.join(run, 'tasks', t.id + '.md'), schemaFile = path.join(run, 'tasks', t.id + '.schema.json')
    fs.writeFileSync(promptFile, t.prompt)
    fs.writeFileSync(schemaFile, JSON.stringify({ type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' }, note: { type: 'string' } } }))
    return { id: t.id, label: t.id, model: t.model, kind: 'lens', ...(t.agentType ? { agentType: t.agentType } : {}), promptFile, schemaFile, answerFile: path.join(run, 'answers', t.id + '.json') }
  })
  fs.writeFileSync(path.join(run, 'step.json'), JSON.stringify({ run, done: false, tasks }))
  console.log(JSON.stringify({ run, done: false, tasks }))
} else if (sub === 'submit' && process.env.FAKE_BROKEN) {
  console.log('not json'); process.exit(1)
} else if (sub === 'submit') {
  fs.appendFileSync(path.join(run, 'submits.jsonl'), JSON.stringify(rest) + '\\n')
  const answered = fs.existsSync(path.join(run, 'answers')) ? fs.readdirSync(path.join(run, 'answers')).sort() : []
  const step = JSON.parse(fs.readFileSync(path.join(run, 'step.json'), 'utf8'))
  const all = fs.readFileSync(path.join(run, 'submits.jsonl'), 'utf8').trim().split('\\n').map(l => JSON.parse(l))
  const abandoned = all.flatMap(s => s.flatMap((a, i) => (a === '--abandoned' ? [s[i + 1]] : [])))
  const missing = step.tasks.filter(t => !answered.includes(t.id + '.json') && !abandoned.includes(t.id))
  const count = all.length
  if (missing.length && count < 3) { console.log(JSON.stringify({ ...step, tasks: missing })); process.exit(0) }
  fs.writeFileSync(path.join(run, 'answered.json'), JSON.stringify(answered.map(f => [f, fs.readFileSync(path.join(run, 'answers', f), 'utf8')])))
  console.log(JSON.stringify({ run, done: true, report: path.join(run, 'report.md'), verdict: 'Approve', line: 'Approve — fake review', findings: [{ severity: 'High', file: 'src/a.rs', line: 3, title: 'a fake finding', tier: 'confirmed' }], ...(process.env.FAKE_FILING ? { filing: JSON.parse(process.env.FAKE_FILING) } : {}) }))
} else process.exit(4)
`

// The fake codex: logs each call (argv, stdin, the cwd and CLAUDE_PLUGIN_ROOT) to FAKE_LOG, counts the processes
// alive at once, and acts on a word in its prompt: FAIL exits 1 (FAIL-ONCE only the first time), HANG sleeps, LIMIT says the usage limit, NOLOGIN
// answers as Codex with no account logged in (401, observed with codex-cli 0.167.0); otherwise it
// writes an answer with a null optional field to the -o file.
export const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const log = process.env.FAKE_LOG, argv = process.argv.slice(2)
const stdin = fs.readFileSync(0, 'utf8')
const me = path.join(log, 'live', String(process.pid))
fs.mkdirSync(path.dirname(me), { recursive: true })
fs.writeFileSync(me, '')
process.on('SIGTERM', () => { fs.rmSync(me, { force: true }); process.exit(143) })
const alive = fs.readdirSync(path.dirname(me)).length
fs.writeFileSync(path.join(log, 'call-' + process.pid + '.json'), JSON.stringify({ argv, stdin, alive, cwd: process.cwd(), root: process.env.CLAUDE_PLUGIN_ROOT }))
const out = argv[argv.indexOf('-o') + 1]
setTimeout(() => {
  fs.rmSync(me)
  const once = path.join(log, 'failed-once')
  if (stdin.includes('FAIL-ONCE') && !fs.existsSync(once)) { fs.writeFileSync(once, ''); console.error('boom'); process.exit(1) }
  if (/\\bFAIL\\b(?!-)/.test(stdin)) { console.error('boom'); process.exit(1) }
  if (stdin.includes('NOLOGIN')) { console.error('ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses'); process.exit(1) }
  if (stdin.includes('LIMIT')) { console.error("ERROR: You've hit your usage limit. Try again in 3 hours."); process.exit(1) }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({ answer: 'ok', note: null }))
}, stdin.includes('HANG') ? 60000 : 300)
`
