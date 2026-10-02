import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { baselineCount, ceilingProblems, fenceProblems } from './check-dup.mjs'
import { FENCE_CLOSE, FENCE_OPEN } from './inline-regions.mjs'

// jscpd reads .jscpd.json, not inline-regions.mjs: its ignorePattern is the fence pair spelled out by
// hand. A fence regex that moves without it would put every inlined region back into the gate (red at
// once), or — loosened — let a stray fence-like comment hide real code from it (silent). jscpd also
// skips an ignorePattern its regex engine cannot compile, with only a warning.
test('.jscpd.json ignores exactly the craft-inline regions the checker reads', () => {
  /** @type {{ ignorePattern?: unknown }} */
  const config = JSON.parse(fs.readFileSync(new URL('../.jscpd.json', import.meta.url), 'utf8'))
  assert.deepEqual(config.ignorePattern, [`(?m)${FENCE_OPEN.source}[\\s\\S]*?${FENCE_CLOSE.source}`])
})

/** @param {Record<string, string>} files @returns {string} */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-dup-'))
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

const COPY = 'export function f(x) {\n  return x + 1\n}\n'

test('fenceProblems: a fence-shaped pair outside workflows/*.js hides code from jscpd, so it is refused', () => {
  const root = tree({
    'lib/a.mjs': `// >>> craft-inline lib/b.mjs f\n${COPY}// <<< craft-inline\n`,
    'opencode/plugin/c.ts': `// <<< craft-inline\n`,
    'lib/d.test.mjs': `const s = \`\n// >>> craft-inline lib/b.mjs f\n\``,
    'workflows/e.js': `// >>> craft-inline lib/b.mjs f\n${COPY}// <<< craft-inline\n`,
    'lib/node_modules/x/index.js': `// <<< craft-inline\n`,
    'lib/ok.mjs': `// the fences read \`// >>> craft-inline <source> <names…>\` and \`// <<< craft-inline\`\n${COPY}`,
  })
  try {
    assert.deepEqual(fenceProblems(root, ['lib', 'opencode/plugin', 'workflows']).sort(), [
      'lib/a.mjs:1: a craft-inline fence outside workflows/*.js — jscpd skips what it encloses, and only engine fences are checked against their source',
      'lib/a.mjs:5: a craft-inline fence outside workflows/*.js — jscpd skips what it encloses, and only engine fences are checked against their source',
      'lib/d.test.mjs:2: a craft-inline fence outside workflows/*.js — jscpd skips what it encloses, and only engine fences are checked against their source',
      'opencode/plugin/c.ts:1: a craft-inline fence outside workflows/*.js — jscpd skips what it encloses, and only engine fences are checked against their source',
    ])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('fenceProblems: a scanned root that contains workflows/ still exempts only the engines', () => {
  const root = tree({
    'workflows/e.js': `// <<< craft-inline\n`,
    'workflows/sub/f.js': `// <<< craft-inline\n`,
    'g.mjs': `// <<< craft-inline\n`,
  })
  try {
    assert.deepEqual(fenceProblems(root, ['.']).map(p => p.split(':')[0]).sort(), ['g.mjs', 'workflows/sub/f.js'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('baselineCount: the sum of the fingerprint counts; anything else is unreadable', () => {
  assert.equal(baselineCount({ version: 1, fingerprints: { a: 1, b: 2 } }), 3)
  assert.equal(baselineCount({ version: 1, fingerprints: {} }), 0)
  assert.equal(baselineCount({ version: 1 }), null)
  assert.equal(baselineCount({ fingerprints: { a: '1' } }), null)
  assert.equal(baselineCount({ fingerprints: { a: -1 } }), null)
})

test('ceilingProblems: the baseline may only shrink, and the ceiling follows it down', () => {
  assert.deepEqual(ceilingProblems({ baseline: 10, ceiling: 10, found: 10 }), [])
  // A planted copy absorbed by regenerating the baseline.
  assert.match(ceilingProblems({ baseline: 11, ceiling: 10, found: 11 }).join('\n'), /11 accepted copies, above the ceiling 10/)
  // A copy unified away, the baseline regenerated: the ceiling must come down with it.
  assert.match(ceilingProblems({ baseline: 9, ceiling: 10, found: 9 }).join('\n'), /lower the ceiling to 9/)
  // A copy unified away, the baseline not regenerated: its stale fingerprint would admit a new copy later.
  assert.match(ceilingProblems({ baseline: 10, ceiling: 10, found: 9 }).join('\n'), /1 fingerprint\(s\) no longer found.*npm run check:dup:baseline/)
  assert.match(ceilingProblems({ baseline: 10, ceiling: Number.NaN, found: 10 }).join('\n'), /no ceiling/)
})
