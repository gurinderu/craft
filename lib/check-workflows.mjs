// Syntax-checks the scripts in workflows/. They can't be `node --check`'d directly: each combines a
// top-level `export`, top-level `await`, and top-level `return` — a trio that is only legal inside
// the workflow sandbox's wrapper. We reproduce that wrapper (strip the single leading `export`, wrap
// the body in an async function) and let `new Function` compile-check it. Exits non-zero on any
// syntax error so CI fails loudly. This does NOT run the scripts — sandbox globals (agent, parallel,
// phase, budget, log, workflow, args) stay unresolved free identifiers, which is fine for a parse.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
let bad = 0
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^export const meta/m, 'const meta')
  try {
    new Function(`async function __wf(){\n${src}\n}`)
    console.log('ok   ', f)
  } catch (e) {
    bad++
    console.error('FAIL ', f, '::', e.message)
  }
}
console.log(`\n${files.length - bad}/${files.length} workflow scripts parse`)
process.exit(bad ? 1 : 0)
