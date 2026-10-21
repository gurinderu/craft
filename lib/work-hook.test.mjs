import { test } from 'vitest'
import assert from 'node:assert/strict'
import { SWITCH_ENV } from './role-hook.mjs'
import { CODEX_OTHER_LANGUAGE_TEXT, CODEX_PROMPT_TEXT, CODEX_SUBAGENT_TEXT, FINDINGS_TEXT, OTHER_LANGUAGE_TEXT, REVIEW_TEXT, SUBAGENT_TEXT, nudgeText, workText } from './work-hook-text.mjs'
import { OPENCODE_FINDINGS_TEXT, OPENCODE_OTHER_LANGUAGE_TEXT } from './work-hook-opencode.mjs'
import { harness } from './hook-harness.mjs'

test('the Claude Code texts per kind: one call first, one reason, a verbatim brief line, the launcher holds the memory', () => {
  const counts = [[FINDINGS_TEXT, 7], [REVIEW_TEXT, 5], [SUBAGENT_TEXT, 5]]
  for (const [text, n] of /** @type {[string, number][]} */ (counts)) {
    assert.equal(text.split('\n').length, n, text)
    assert.ok(text.split('\n').every(l => l.startsWith('craft: ')))
    assert.ok(text.includes(`${SWITCH_ENV}=0`))
  }
  for (const text of [FINDINGS_TEXT, REVIEW_TEXT]) {
    assert.ok(text.startsWith('craft: before your first tool call'))
    for (const name of ['craft: why:', 'main session', 'record-decision', 'record-rule', 'record-question', 'memory backend:']) assert.ok(text.includes(name), name)
    // Subagents lack the memory tools: the launcher briefs the records and records their verdicts (skills/memory, "Subagents").
    assert.match(text, /put the records craft:memory recalls, verbatim with their ids, into each brief, and record each finding you or a subagent reject or defer/)
  }
  // Findings: one call, a brief line that sends the subagent into the skill and has it report, not record (#288).
  assert.match(FINDINGS_TEXT, /^craft: before your first tool call on this request, make one call: Skill\("craft:addressing-findings"\)\./)
  assert.match(FINDINGS_TEXT, /re-review loop stays with this main session/)
  assert.match(FINDINGS_TEXT, /paste this line verbatim into each subagent's brief: "[^"]*craft:addressing-findings[^"]*report each finding you reject or defer, with its reason, in your result; your launcher records it\."/)
  assert.doesNotMatch(FINDINGS_TEXT, /craft:develop/)
  // Review: develop or the review workflow, both in the main session; a delegated reviewer only reports.
  // craft:review covers only Rust and Nix; any other diff goes to adversarial-review, as develop routes it (skills/develop).
  assert.match(REVIEW_TEXT, /make one call, here in the main session: Skill\("craft:develop"\) for the review loop up to a PR \(it picks the engine by the diff's languages\); for one pass, the craft:review workflow on a Rust or Nix diff, the craft:adversarial-review workflow on any other\. Never hand any of them to a subagent/)
  assert.match(REVIEW_TEXT, /craft:review runs the Rust or Nix gate[^;]*; craft:adversarial-review fans review lenses out over any language/)
  assert.doesNotMatch(REVIEW_TEXT, /language gate|craft:review workflow for one pass/)
  assert.match(REVIEW_TEXT, /at most 4 rounds, then it stops[^;]*\), then one full review before the PR/)
  assert.match(REVIEW_TEXT, /paste this line verbatim into its brief: "Review only: report findings only, change no code and record nothing; [^"]*"/)
  assert.doesNotMatch(REVIEW_TEXT, /addressing-findings/)
  const sub = SUBAGENT_TEXT.split('\n')
  for (const work of ['triaging PR comments', 'posting replies to review threads', 'fixing per review comments']) assert.ok(sub[0]?.includes(work), work)
  assert.match(sub[0] ?? '', /before your first tool call, run Skill\("craft:addressing-findings"\)/)
  assert.match(SUBAGENT_TEXT, /you lack the memory tools: the records your launcher recalled are in your brief; report each finding you reject or defer, with its reason, in your result/)
  assert.doesNotMatch(SUBAGENT_TEXT, /record-decision|record each/)
  assert.match(SUBAGENT_TEXT, /brief is only to review: report findings only, change no code and record nothing/)
})

test('the harness: Codex by turn_id or its PLUGIN_ROOT, Claude Code otherwise (its SessionStart carries model too)', () => {
  assert.equal(harness({ hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'x' }, {}), 'codex')
  assert.equal(harness({ hook_event_name: 'SessionStart', model: 'gpt-5' }, { PLUGIN_ROOT: '/p' }), 'codex')
  assert.equal(harness({ hook_event_name: 'SessionStart', model: 'claude-opus-5-5' }, { CLAUDE_PLUGIN_ROOT: '/p' }), 'claude-code')
  assert.equal(harness({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', turn_id: '' }, {}), 'claude-code')
})

test('the Codex texts send the session to SKILL.md, never to a Claude Code tool; findings may be delegated, a review stays here', () => {
  assert.deepEqual(workText('claude-code'), { prompt: FINDINGS_TEXT, subagent: SUBAGENT_TEXT })
  assert.deepEqual(workText('claude-code', 'findings'), { prompt: FINDINGS_TEXT, subagent: SUBAGENT_TEXT })
  assert.deepEqual(workText('claude-code', 'review'), { prompt: REVIEW_TEXT, subagent: SUBAGENT_TEXT })
  assert.deepEqual(workText('codex', 'review'), { prompt: CODEX_PROMPT_TEXT, subagent: CODEX_SUBAGENT_TEXT })
  assert.deepEqual(workText('codex', 'findings'), { prompt: CODEX_PROMPT_TEXT, subagent: CODEX_SUBAGENT_TEXT })
  assert.equal(CODEX_PROMPT_TEXT.split('\n').length, 6)
  assert.equal(CODEX_SUBAGENT_TEXT.split('\n').length, 2)
  for (const text of [CODEX_PROMPT_TEXT, CODEX_SUBAGENT_TEXT]) {
    for (const banned of ['Skill tool', 'Workflow', 'workflow', 'craft:develop', 'craft:review ']) assert.ok(!text.includes(banned), banned)
    for (const name of ['SKILL.md', 'craft:addressing-findings', `${SWITCH_ENV}=0`]) assert.ok(text.includes(name), name)
    assert.ok(text.split('\n').every(l => l.startsWith('craft: ')))
  }
  for (const name of ['craft:memory', 'record-decision', 'record-rule', 'record-question', 'memory backend:']) assert.ok(CODEX_PROMPT_TEXT.includes(name), name)
  // No review agent to dispatch: the session reviews, with a rubric for Rust or Nix and without one otherwise.
  assert.match(CODEX_PROMPT_TEXT, /craft ships no review agents or engines to Codex, so review the diff in this session yourself, not in a subagent/)
  assert.match(CODEX_PROMPT_TEXT, /craft:rust-review \(Rust\) or craft:nix-review \(Nix\), otherwise read the diff for defects/)
  assert.match(CODEX_PROMPT_TEXT, /findings by severity with file:line/)
  // Only findings work is delegated; the launcher briefs the records and records the subagent's verdicts.
  assert.match(CODEX_PROMPT_TEXT, /findings work may go to a subagent: brief it to read craft:addressing-findings' SKILL\.md[^:]*and work the findings with it, give it the records craft:memory recalls, and tell it: "Report each finding you reject or defer, with its reason, in your result; your launcher records it\." Record each one it reports\. A review stays in this session\./)
  assert.doesNotMatch(CODEX_PROMPT_TEXT, /delegating this|same instructions/)
  assert.match(CODEX_SUBAGENT_TEXT, /report each finding you reject or defer, with its reason, in your result; your launcher records it/)
  assert.doesNotMatch(CODEX_SUBAGENT_TEXT, /craft:memory/)
  assert.match(CODEX_SUBAGENT_TEXT, /brief is to review: report findings only, change no code/)
})

test('the findings texts recall before triage and re-review before any reply, in each harness\'s words', () => {
  const recall = /before triage \(its step 0\): [^;]*recall\(<finding keywords>, <path>\) for every path the findings touch/
  const reReview = /after the fixes are in \(every fixer returned and pushed\) and before posting any reply: run a light re-review of the fix commits only \(base: the commit the review was made on\), [^;]*, repeating until no Medium-or-higher finding is open \(the whole diff only on the human's word\); replies wait for it\./
  for (const text of [FINDINGS_TEXT, OPENCODE_FINDINGS_TEXT, CODEX_PROMPT_TEXT, OTHER_LANGUAGE_TEXT, OPENCODE_OTHER_LANGUAGE_TEXT, CODEX_OTHER_LANGUAGE_TEXT]) {
    assert.match(text, recall, text)
    assert.match(text, reReview, text)
  }
  assert.match(FINDINGS_TEXT, /right after loading it, before triage \(its step 0\): Skill\("craft:memory"\) and recall/)
  assert.match(FINDINGS_TEXT, /\), here in the main session with the craft:review workflow \{ base: <that commit>, fresh: true, fullEvery: 0 \} on a Rust or Nix diff, the craft:adversarial-review workflow \{ diffBase: <that commit> \} on any other, repeating/)
  assert.match(OPENCODE_FINDINGS_TEXT, /load the memory skill with the skill tool and recall/)
  assert.match(OPENCODE_FINDINGS_TEXT, /\), here in this session over git diff <that commit>\.\.HEAD: for Rust code the rust-review skill or the rust-audit tool, otherwise your own review pass, repeating/)
  assert.match(CODEX_PROMPT_TEXT, /read craft:memory's SKILL\.md \(its path is listed among your skills\) and recall/)
  assert.match(CODEX_PROMPT_TEXT, /\), your own pass over git diff <that commit>\.\.HEAD in this session, repeating/)
  assert.equal(nudgeText('claude-code'), 'craft: if this report completes the fixes for the review findings, run a light re-review of the fix commits only (base: the commit the review was made on), here in the main session with the craft:review workflow { base: <that commit>, fresh: true, fullEvery: 0 } on a Rust or Nix diff, the craft:adversarial-review workflow { diffBase: <that commit> } on any other, before posting replies, until no Medium-or-higher finding is open.')
  assert.match(nudgeText('codex'), /run a light re-review of the fix commits only \(base: the commit the review was made on\), your own pass over git diff <that commit>\.\.HEAD in this session, before posting replies/)
})
