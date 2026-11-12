// The one instruction for finding a pinned dependency's source (lib/dependency-source.mjs) reaches
// the agents that must open that code to settle a premise: the triage validator, every
// adversarial-review lens, and review's lenses and verifiers.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { DEPENDENCY_SOURCE_HOW } from './dependency-source.mjs'

test('the instruction names the pinned version, locked cargo calls, vendoring, flake inputs and other ecosystems', () => {
  assert.match(DEPENDENCY_SOURCE_HOW, /version the project pins/)
  assert.match(DEPENDENCY_SOURCE_HOW, /`manifest_path` from `cargo metadata --locked --format-version 1`/)
  assert.match(DEPENDENCY_SOURCE_HOW, /Cargo\.lock/)
  assert.match(DEPENDENCY_SOURCE_HOW, /`cargo fetch --locked`/)
  assert.match(DEPENDENCY_SOURCE_HOW, /Cargo\.lock exists but `--locked` refuses.*cannot be determined/)
  assert.match(DEPENDENCY_SOURCE_HOW, /no Cargo\.lock[^.]*throwaway copy/)
  assert.match(DEPENDENCY_SOURCE_HOW, /throwaway copy[^;]*`cargo metadata --format-version 1` there/)
  assert.match(DEPENDENCY_SOURCE_HOW, /resolved today, not a pinned one/)
  assert.match(DEPENDENCY_SOURCE_HOW, /`workspace_root` from `cargo metadata --no-deps --format-version 1`/)
  assert.match(
    DEPENDENCY_SOURCE_HOW,
    /unless `git ls-files --error-unmatch <that path>` succeeds and `git status --porcelain <that path>` is empty[^.]*resolved today, not pinned/,
  )
  assert.match(DEPENDENCY_SOURCE_HOW, /when a Cargo\.toml has uncommitted changes, a copy of the working tree without `target\/` and `\.git`/)
  assert.match(DEPENDENCY_SOURCE_HOW, /always remove the copy \(`git worktree remove <tmp>` when you added one\)/)
  assert.match(DEPENDENCY_SOURCE_HOW, /never write Cargo\.lock in the reviewed checkout/)
  assert.doesNotMatch(
    DEPENDENCY_SOURCE_HOW.replace(/throwaway copy[^;]*there/, ''),
    /cargo (?:metadata(?! --locked| --no-deps)|fetch(?! --locked))/,
    'only the throwaway copy resolves unlocked',
  )
  assert.match(DEPENDENCY_SOURCE_HOW, /vendor/)
  assert.match(DEPENDENCY_SOURCE_HOW, /flake\.lock/)
  assert.match(DEPENDENCY_SOURCE_HOW, /lockfile/)
  assert.doesNotMatch(DEPENDENCY_SOURCE_HOW, /[\r\n]/)
})

test('triage-findings: the validator prompt carries the instruction beside its premise discipline', async () => {
  const r = await runEngine('triage-findings', {
    args: { report: '/r.md' },
    script: {
      'log-run': { ok: true },
      'gather:report': {
        source: 'rust-audit',
        findings: [{ severity: 'High', title: 'leak', location: 'src/a.rs:10', detail: 'd', proposed_fix: '', thread_id: '' }],
      },
      validate: { stable_id: 'rust-audit::src/a.rs:10::leak', verdict: 'accept', reason: 'real', fix_pointer: 'rust-errors: x', premise_checked: '' },
      plan: { plan_markdown: 'BODY', summary: 'S', ledger: [] },
    },
  })
  const prompt = r.calls.find(c => c.label.startsWith('validate:'))?.prompt ?? ''
  assert.ok(prompt.includes(DEPENDENCY_SOURCE_HOW), 'validator prompt carries the instruction')
  assert.ok(prompt.indexOf('PREMISE DISCIPLINE') < prompt.indexOf(DEPENDENCY_SOURCE_HOW), 'after the premise discipline')
})
