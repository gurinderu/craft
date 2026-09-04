// "Is this path inside that directory?" — asked in two places, in two languages, and both are load
// bearing for security. One table of cases, run against BOTH, so the question is answered once.
//
// Why a shared table rather than tests beside each implementation. This exact property has now been
// got wrong three separate times here, each time in a place the previous fix did not name:
//   — a prefix comparison that called `/x/store-evil` a child of `/x/store` (fixed in insideStore);
//   — a check applied to `CLAUDE_CONFIG_DIR` while an explicit craftRoot skipped it entirely;
//   — a `pwd -P` that resolved the DIRECTORY and re-appended the filename unresolved, so a
//     symlinked FILE pointing into the reviewed repository passed.
// Each fix was correct and each left a sibling wrong, because the property was tested where it had
// just been repaired. The cases below are the property; the implementations are rows.
//
// The two differ in polarity by design and that is not a discrepancy to paper over: `insideStore`
// asks "is this run directory inside the store?" to refuse everything OUTSIDE, while the shell
// predicate asks "is this logger inside the repo under review?" to refuse everything INSIDE. What
// they must agree on is CONTAINMENT itself — every row below is an answer to that, and each
// implementation is then read through its own polarity.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { containsPath } from './craft-log-run.mjs'
import { loggerPrelude } from './run-logging.mjs'

// Each case builds a real tree under `root` and names, relative to it, the parent directory and the
// candidate file. `contained` is the truth the two implementations must agree on.
const CASES = [
  {
    name: 'a file plainly beneath the directory',
    build: root => {
      fs.mkdirSync(path.join(root, 'repo', 'lib'), { recursive: true })
      fs.writeFileSync(path.join(root, 'repo', 'lib', 'craft-log-run.mjs'), 'console.log("PWNED")\n')
      return { parent: path.join(root, 'repo'), candidate: path.join(root, 'repo', 'lib', 'craft-log-run.mjs') }
    },
    contained: true,
  },
  {
    name: 'a SIBLING whose name merely shares a prefix',
    // The collision this project already met once: `/x/repo-evil` is not inside `/x/repo`, and a
    // comparison by string prefix says it is. Refusing it would break unrelated installs; accepting
    // it as "inside" is the bug.
    build: root => {
      fs.mkdirSync(path.join(root, 'repo'), { recursive: true })
      fs.mkdirSync(path.join(root, 'repo-evil', 'lib'), { recursive: true })
      fs.writeFileSync(path.join(root, 'repo-evil', 'lib', 'craft-log-run.mjs'), '// unrelated\n')
      return { parent: path.join(root, 'repo'), candidate: path.join(root, 'repo-evil', 'lib', 'craft-log-run.mjs') }
    },
    contained: false,
  },
  {
    name: 'a path that climbs out and back in with ..',
    build: root => {
      fs.mkdirSync(path.join(root, 'repo', 'lib'), { recursive: true })
      fs.writeFileSync(path.join(root, 'repo', 'lib', 'craft-log-run.mjs'), 'console.log("PWNED")\n')
      return {
        parent: path.join(root, 'repo'),
        candidate: path.join(root, 'repo', 'lib', '..', 'lib', 'craft-log-run.mjs'),
      }
    },
    contained: true,
  },
  {
    name: 'a symlinked DIRECTORY pointing inside',
    build: root => {
      fs.mkdirSync(path.join(root, 'repo', 'lib'), { recursive: true })
      fs.writeFileSync(path.join(root, 'repo', 'lib', 'craft-log-run.mjs'), 'console.log("PWNED")\n')
      fs.mkdirSync(path.join(root, 'outside'), { recursive: true })
      fs.symlinkSync(path.join(root, 'repo', 'lib'), path.join(root, 'outside', 'lib'))
      return { parent: path.join(root, 'repo'), candidate: path.join(root, 'outside', 'lib', 'craft-log-run.mjs') }
    },
    contained: true,
  },
  {
    name: 'a symlinked FILE pointing inside',
    // The one the previous round stopped short of: resolving the directory and re-appending the
    // basename leaves this looking like an outside path, and it executed the reviewed repo's script.
    build: root => {
      fs.mkdirSync(path.join(root, 'repo'), { recursive: true })
      fs.writeFileSync(path.join(root, 'repo', 'evil.mjs'), 'console.log("PWNED")\n')
      fs.mkdirSync(path.join(root, 'outside', 'lib'), { recursive: true })
      fs.symlinkSync(path.join(root, 'repo', 'evil.mjs'), path.join(root, 'outside', 'lib', 'craft-log-run.mjs'))
      return { parent: path.join(root, 'repo'), candidate: path.join(root, 'outside', 'lib', 'craft-log-run.mjs') }
    },
    contained: true,
  },
  {
    name: 'a chain of symlinks ending inside',
    build: root => {
      fs.mkdirSync(path.join(root, 'repo'), { recursive: true })
      fs.writeFileSync(path.join(root, 'repo', 'evil.mjs'), 'console.log("PWNED")\n')
      fs.mkdirSync(path.join(root, 'outside', 'lib'), { recursive: true })
      fs.symlinkSync(path.join(root, 'repo', 'evil.mjs'), path.join(root, 'outside', 'hop1'))
      fs.symlinkSync(path.join(root, 'outside', 'hop1'), path.join(root, 'outside', 'lib', 'craft-log-run.mjs'))
      return { parent: path.join(root, 'repo'), candidate: path.join(root, 'outside', 'lib', 'craft-log-run.mjs') }
    },
    contained: true,
  },
  {
    name: 'a genuinely unrelated directory',
    build: root => {
      fs.mkdirSync(path.join(root, 'repo'), { recursive: true })
      fs.mkdirSync(path.join(root, 'elsewhere', 'lib'), { recursive: true })
      fs.writeFileSync(path.join(root, 'elsewhere', 'lib', 'craft-log-run.mjs'), '// legitimate\n')
      return { parent: path.join(root, 'repo'), candidate: path.join(root, 'elsewhere', 'lib', 'craft-log-run.mjs') }
    },
    contained: false,
  },
  {
    name: 'a parent reached through a symlink',
    build: root => {
      fs.mkdirSync(path.join(root, 'real', 'lib'), { recursive: true })
      fs.writeFileSync(path.join(root, 'real', 'lib', 'craft-log-run.mjs'), 'console.log("PWNED")\n')
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'repo'))
      return { parent: path.join(root, 'repo'), candidate: path.join(root, 'repo', 'lib', 'craft-log-run.mjs') }
    },
    contained: true,
  },
]

function scratch() {
  // realpath because macOS hands out /var → /private/var, and a comparison between a resolved and an
  // unresolved side would report a difference the implementations did not make.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-contain-')))
}

// The shell predicate, read through its own polarity: the logger is REFUSED when it is inside the
// repo, so "refused" means "contained". Executed, because it is shell and only a shell can say.
function shellSaysContained(parent, candidate) {
  const prelude = loggerPrelude(path.dirname(path.dirname(candidate)), '1.0.0', parent)
  try {
    execFileSync('bash', ['-c', `${prelude}echo "USED=$CRAFT_LOGGER"`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home' },
    })
    return false
  } catch {
    return true
  }
}

for (const c of CASES) {
  test(`containment — ${c.name}`, () => {
    const root = scratch()
    try {
      const { parent, candidate } = c.build(root)

      assert.equal(
        containsPath(parent, candidate), c.contained,
        `containsPath disagrees about ${c.name}`,
      )
      assert.equal(
        shellSaysContained(parent, candidate), c.contained,
        `the shell predicate disagrees about ${c.name}`,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

test('the reviewed repository never executes, whichever route was tried', () => {
  // The table above asks what the predicates BELIEVE. This asks what actually happens, which is the
  // thing that matters: for every case whose file is a plant inside the repo, running the emitted
  // block must not run it.
  for (const c of CASES.filter(x => x.contained)) {
    const root = scratch()
    try {
      const { parent, candidate } = c.build(root)
      const prelude = loggerPrelude(path.dirname(path.dirname(candidate)), '1.0.0', parent)
      let out = ''
      try {
        out = execFileSync('bash', ['-c', `${prelude}node "$CRAFT_LOGGER"`], {
          encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home' },
        })
      } catch (e) {
        out = String(e.stdout || '') + String(e.stderr || '')
      }
      assert.ok(
        !out.split('\n').some(l => l.trim() === 'PWNED'),
        `${c.name}: the reviewed repository's script must never run`,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})
