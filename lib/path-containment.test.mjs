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
    name: 'a chain LONGER than the resolver is willing to follow',
    // The boundary the implementation itself introduces, which the historical bugs could not have
    // taught: the shell walk stops after a fixed number of hops. Stopping is right; what it does on
    // stopping is the question, and it used to fall through to acceptance — the path was still a
    // symlink, the comparison tested an unresolved string, nothing matched, and a 21-link chain
    // ending inside the repository executed. A bound that fails open is not a bound, it is a longer
    // attack. Both sides must call this contained: JS because realpath follows the whole chain,
    // shell because refusing is the only safe answer when it has stopped looking.
    build: root => {
      // The hops live OUTSIDE the repository on purpose. Built inside it, the row does not
      // discriminate: a walk that gives up early still leaves a path under the repo, so the
      // comparison catches it anyway and a fail-open bound looks safe. Only a chain that leaves and
      // returns makes full resolution the sole thing standing between the caller and the repo's
      // script — which is the attack as it was actually demonstrated.
      fs.mkdirSync(path.join(root, 'repo'), { recursive: true })
      fs.writeFileSync(path.join(root, 'repo', 'evil.mjs'), 'console.log("PWNED")\n')
      fs.mkdirSync(path.join(root, 'outside', 'hops'), { recursive: true })
      fs.mkdirSync(path.join(root, 'outside', 'lib'), { recursive: true })
      let prev = path.join(root, 'repo', 'evil.mjs')
      for (let i = 0; i < 21; i++) {
        const hop = path.join(root, 'outside', 'hops', `h${i}`)
        fs.symlinkSync(prev, hop)
        prev = hop
      }
      fs.symlinkSync(prev, path.join(root, 'outside', 'lib', 'craft-log-run.mjs'))
      return { parent: path.join(root, 'repo'), candidate: path.join(root, 'outside', 'lib', 'craft-log-run.mjs') }
    },
    contained: true,
  },
  {
    name: 'the filesystem root, which contains everything',
    // Degenerate, and both implementations inverted on it in the same way: a prefix test against `/`
    // compares with `//`, matches no ordinary path, and answers "outside" for everything — turning
    // the guard into an allow-all exactly where it should be strictest. The shared table earns its
    // keep here: asked of one side only, the wrong answer would have looked like agreement.
    build: root => {
      fs.mkdirSync(path.join(root, 'anywhere', 'lib'), { recursive: true })
      fs.writeFileSync(path.join(root, 'anywhere', 'lib', 'craft-log-run.mjs'), 'console.log("PWNED")\n')
      return { parent: '/', candidate: path.join(root, 'anywhere', 'lib', 'craft-log-run.mjs') }
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
  let out = ''
  try {
    out = execFileSync('bash', ['-c', `${prelude}echo "USED=$CRAFT_LOGGER"`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home' },
    })
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '')
  }
  // Read the MARKER, not merely a non-zero exit. Any exit code would do for "refused", so a prelude
  // with a shell syntax error would have satisfied every `contained: true` row while failing only
  // the two that expect acceptance — six rows passing for a reason unrelated to containment.
  if (/craft-log-run FAILED/.test(out)) return true
  if (/^USED=\/.+/m.test(out)) return false
  throw new Error(`the prelude neither resolved nor refused — it did something else:\n${out}`)
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
  // The root row is excluded, and not to make the test pass: with the declared repo `/` NOTHING can
  // be outside it, so the positive control below — a legitimate logger that must execute — has no
  // possible fixture. Skipping a case whose control cannot exist is honest; skipping one whose
  // control merely fails would not be.
  for (const c of CASES.filter(x => x.contained && x.name !== 'the filesystem root, which contains everything')) {
    const root = scratch()
    try {
      const { parent, candidate } = c.build(root)
      const prelude = loggerPrelude(path.dirname(path.dirname(candidate)), '1.0.0', parent)
      let out = ''
      try {
        // `process.execPath`, not the bare word: `node` is not on PATH in this scrubbed environment,
        // and that is exactly how the assertion below went vacuous — PWNED could not be printed
        // whether or not the predicate was bypassed.
        out = execFileSync('bash', ['-c', `${prelude}${JSON.stringify(process.execPath)} "$CRAFT_LOGGER"`], {
          encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home' },
        })
      } catch (e) {
        out = String(e.stdout || '') + String(e.stderr || '')
      }
      assert.ok(
        !out.split('\n').some(l => l.trim() === 'PWNED'),
        `${c.name}: the reviewed repository's script must never run`,
      )
      // POSITIVE CONTROL, and it is what makes the line above mean anything. With the symlink walk
      // disabled — the bypass fully restored — this assertion still passed, because `node` was not
      // resolvable in the scrubbed env and PWNED could not be printed either way. An absence proves
      // nothing until the same fixture is shown capable of producing the presence.
      const good = path.join(root, 'good')
      fs.mkdirSync(path.join(good, 'lib'), { recursive: true })
      fs.writeFileSync(path.join(good, 'lib', 'craft-log-run.mjs'), 'console.log("RAN")\n')
      const control = execFileSync('bash', ['-c', `${loggerPrelude(good, '1.0.0', parent)}${JSON.stringify(process.execPath)} "$CRAFT_LOGGER"`], {
        encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home' },
      })
      assert.match(control, /RAN/, `${c.name}: the fixture must be able to execute a legitimate logger, or the absence above proves nothing`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('a repository path that cannot be resolved disables nothing', () => {
  // `CRAFT_REPO` empty used to short-circuit the containment comparison for EVERY candidate at once,
  // so an unresolvable repo silently turned the guard off rather than turning the run off. It was
  // harmless only by coincidence — the later `cd <repo> && node …` failed too — which means the
  // guard's safety rested on a different line of a different command.
  const missing = path.join(os.tmpdir(), `craft-absent-${process.pid}`)
  fs.rmSync(missing, { recursive: true, force: true })
  const good = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-good-')))
  fs.mkdirSync(path.join(good, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(good, 'lib', 'craft-log-run.mjs'), 'console.log("RAN")\n')
  let refused = false
  let out = ''
  try {
    out = execFileSync('bash', ['-c', `${loggerPrelude(good, '1.0.0', missing)}echo "USED=$CRAFT_LOGGER"`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/tmp/nonexistent-home' },
    })
  } catch (e) {
    refused = true
    out = String(e.stdout || '') + String(e.stderr || '')
  }
  assert.ok(refused, 'an unresolvable repo must refuse, not proceed with containment switched off')
  assert.match(out, /craft-log-run FAILED/)
  fs.rmSync(good, { recursive: true, force: true })
})
