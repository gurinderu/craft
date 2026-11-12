// A command the harness's permission layer refused in the steps that open no run to go on with — the fetch of the
// binary, the gate alone, a finished run's publication: who refused it and what to allow, and no resume offered.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const BIN = '/opt/craft'
const RUN = '/home/u/.craft/runs/cli/1794243266-1806000'
/** The service agent's answer as auto mode's classifier left it. @param {string} denied */
const refused = denied => ({
  exitCode: -1,
  stdout: '',
  stderr: `Permission for this action was denied by the Claude Code auto mode classifier. The command was not run. Denied command: ${denied} (timeout 420000 ms). The classifier gave no explanation.`,
})
/** The verdict line of a run's report. @param {{ report: string }} run */
const verdictOf = run => run.report.split('\n')[2] ?? ''
/** The command a step's prompt has the service agent run. @param {{ calls: { label: string, prompt: string }[] }} run @param {string} label */
const commandOf = (run, label) => run.calls.find(c => c.label === label)?.prompt.split('\n\n')[1] ?? ''
/** The prefix the `Bash(<prefix>:*)` rule in `said` names. @param {string} said */
const rulePrefix = said => /`Bash\((.+?):\*\)`/.exec(said)?.[1]

test('a gate alone the harness refused names who refused it and the rule for the command it issued, no resume', async () => {
  const command = `${BIN} review gate --cwd .`
  const run = await runEngine('review', { args: { gateOnly: true, craftBin: BIN }, script: { 'step:gate': refused(command) } })
  const line = verdictOf(run)
  assert.equal(commandOf(run, 'step:gate'), command, 'the binary bare, as the rule spells it')
  assert.ok(line.includes(`the harness's permission check refused the command, not craft — it was not run: \`${command}\`.`), line)
  assert.ok(command.startsWith(`${String(rulePrefix(line))} `), line)
  assert.doesNotMatch(line, /run=|resume|continue/)
})

test('a publication the harness refused posted nothing, says what to allow, and offers no resume', async () => {
  const run = await runEngine('review', {
    args: { craftBin: BIN, craftRoot: '/plugin', run: RUN, comment: true },
    script: { 'step:root': { exitCode: 0, stdout: 'root=/plugin\n', stderr: '' }, 'step:comment': refused(`${BIN} review comment --run '${RUN}'`) },
  })
  const command = commandOf(run, 'step:comment')
  assert.ok(command.startsWith(`${BIN} review comment `), command)
  assert.match(run.report, /^## Verdict\n\n⚠️ Nothing was posted on the PR — the harness's permission check refused the command, not craft/)
  assert.ok(command.startsWith(`${String(rulePrefix(run.report))} `), run.report)
  assert.doesNotMatch(run.report, /resume|is unknown/)
})

test('a fetch the harness refused names who refused it and offers no resume', async () => {
  const run = await runEngine('review', { args: {}, script: { 'step:resolve': refused('node /p/lib/craft-bin.mjs ensure --version 1.0.0') } })
  const line = verdictOf(run)
  assert.ok(
    line.includes("the harness's permission check refused the command, not craft — it was not run: `node /p/lib/craft-bin.mjs ensure --version 1.0.0`."),
    line,
  )
  assert.ok(line.includes('approve the command when the harness asks'), line)
  assert.doesNotMatch(line, /run=|resume|continue/)
})
