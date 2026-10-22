// The one key a repository is known by in craft's stores: a run record's `project` (lib/craft-log-run.mjs) and
// the hooks' `repo` (lib/hook-log.mjs, lib/push-hook.mjs) — one implementation, so a join between them cannot
// drift (realm @nick/craft, #283, #299).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Every hook run and the OpenCode plugin (in-process) ask for the key: a git that hangs must not hold them.
const GIT_TIMEOUT_MS = 1500

/** git's trimmed stdout in `cwd`, '' when it fails or outlives GIT_TIMEOUT_MS. @param {string[]} args @param {string} cwd @returns {string} */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).trim()
  } catch {
    return ''
  }
}

// The stable identity of the repository being reviewed. A run launched from a subdirectory, through
// a symlinked or differently-spelled path, or from a linked worktree would otherwise key its record
// to a DIFFERENT string than the next run — and the round chain breaks exactly the way a `.` key
// broke it.
//
// `--show-toplevel` does NOT collapse a linked worktree onto its main checkout — it reports the
// WORKTREE's own root, a different string from the main checkout's. Measured live in `~/.craft/runs`:
// rows are keyed to `.../.claude/worktrees/agent-a86b020e8815a0244` and
// `/private/tmp/.../scratchpad/wt-1254`, both linked worktrees of repos whose reviews are normally run
// from the main checkout — so `findPriorRound`'s exact-string match on `project` never reaches them,
// and the round chain silently restarts every time review happens to run from a worktree once and the
// main checkout the next time (or the reverse). `--git-common-dir` names the ONE `.git` a worktree and
// its main checkout share, so its parent is a key stable across both — for a main checkout, that
// parent is the same directory `--show-toplevel` already returned, so this changes nothing for the
// dominant case and only collapses the worktree one.
//
// Two things make "parent of the common dir" wrong on its own, both measured with real git (see
// craft-log-run.test.mjs):
//  - `git rev-parse` on git < 2.31 (no `--path-format`, shipped in 2021 — still current on e.g.
//    Ubuntu 20.04/Debian bullseye/RHEL 8) ECHOES the unrecognised flag to stdout and exits 0 rather
//    than failing: `commonDir` becomes the two-line string `"--path-format=absolute\n.git"`, whose
//    `dirname` is `"."` — every such run keys to the logger process's cwd, not the repo, and does so
//    silently. Guarded against by requiring the shape of a real answer (one line, absolute) before
//    trusting it.
//  - a submodule's common dir is `<super>/.git/modules/<name>` — its parent is `<super>/.git/modules`,
//    a directory that is neither a work tree nor unique per submodule: every submodule of one
//    superproject collapses onto that ONE key and can hand each other prior rounds; the same
//    derivation collides every bare repo beside another the same way. Guarded against by trusting the
//    parent-of-`.git` shortcut only when the common dir's own basename is literally `.git` (the plain
//    repo and linked-worktree shape) — a submodule's or bare repo's common dir never has that shape.
//
// This affects both sides: every NEW record's `project` field, and every read (`findPriorRound`,
// `recoverPartials`'s journal lookup) that keys off it — a deliberate, repo-wide re-keying, not a
// read-path patch, because a worktree review and a main-checkout review of the same repo are one
// round chain when the common dir's basename is `.git` (the plain repo and linked-worktree shape the
// guard above accepts). A worktree of a BARE repo, or of a SUBMODULE, does not have that shape, so the
// parent-of-`.git` shortcut correctly declines there and each side keys off its own `--show-toplevel`
// instead — the two round chains stay separate rather than merging. Measured as a degradation, not a
// defect: no cross-repo contamination, just lost round continuity for a topology this repo does not
// itself use. Not a git repo (or no git at all) → the real path (symlinks resolved, so a linked directory keeps
// one key), else the resolved one — still better than a relative one.
export function repoKey(p = process.cwd()) {
  const abs = path.resolve(p)
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], abs)
  // Shape-check before trusting it: git silently echoes an unrecognised flag to stdout (exit 0) on
  // git < 2.31, so a single absolute-path line is the bar for "this is really the common dir".
  const validCommon = commonDir && !commonDir.includes('\n') && path.isAbsolute(commonDir)
  if (validCommon && /(?:^|[\\/])\.git$/.test(commonDir)) {
    // Plain repo or linked worktree: the parent of `.git` is the identity they share.
    return path.resolve(path.dirname(commonDir))
  }
  // Submodule (common dir ends in `.git/modules/<name>`, not `.git`) or bare repo (no `.git` subdir
  // at all — the common dir IS the repo). `--show-toplevel` gives each submodule its own distinct
  // root; a bare repo has none, so fall back to the common dir itself — still unique per bare repo,
  // unlike the collapsed parent this branch exists to avoid.
  const top = git(['rev-parse', '--show-toplevel'], abs)
  if (top) return path.resolve(top)
  if (validCommon) return path.resolve(commonDir)
  try { return fs.realpathSync(abs) } catch { return abs }
}
