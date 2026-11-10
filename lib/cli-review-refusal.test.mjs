// A command the harness's permission layer refused before it ran, told apart from the craft binary's own refusals
// (lib/cli-review-refusal.mjs), and the stop the review driver says for it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { harnessRefusal, harnessRefused, harnessStop } from './cli-review-refusal.mjs'
import { shellWord } from './plugin-script.mjs'

const BIN = '/home/ubuntu/.craft/bin/0.47.0/craft'
const RUN = '/home/ubuntu/.craft/runs/cli/1794243266-1806000'
const DENIED = `${BIN} review submit --run '${RUN}' --agents 2 --output-tokens 182191`
/** The service agent's answer as auto mode's classifier left it. @param {string} denied */
const classifierSaid = denied => ({ exitCode: -1, stdout: '', stderr: `Permission for this action was denied by the Claude Code auto mode classifier. The command was not run. Denied command: ${denied} (timeout 420000 ms). The classifier gave no explanation.` })
const classifier = classifierSaid(DENIED)
/** The prefix a `Bash(<prefix>:*)` rule in `said` names. @param {string} said */
const rulePrefix = said => /`Bash\((.+?):\*\)`/.exec(said)?.[1]

test('the classifier\'s refusal is the harness\'s, with the command it quotes', () => {
  assert.deepEqual(harnessRefusal(classifier), { command: DENIED })
  assert.deepEqual(harnessRefusal({ ...classifier, stderr: '', stdout: classifier.stderr }), { command: DENIED }, 'in stdout as well')
  assert.deepEqual(harnessRefusal({ exitCode: 1, stdout: '', stderr: 'The command was not run.' }), { command: '' }, 'a marker alone, no command quoted')
  assert.deepEqual(harnessRefusal({ exitCode: -1, stdout: '', stderr: 'Permission to use Bash has been denied.' }), { command: '' }, 'the generic shape')
})

test('the quoted command is cut only at the trailing timeout or the end of its line, not at a ". " inside it', () => {
  const dotted = `${BIN} review submit --run '/r/a. b' --limit 'resets 3am. Later' --agents 1`
  assert.deepEqual(harnessRefusal(classifierSaid(dotted)), { command: dotted })
  const bare = `${dotted}\nThe classifier gave no explanation.`
  assert.deepEqual(harnessRefusal({ exitCode: -1, stdout: '', stderr: `The command was not run. Denied command: ${bare}` }), { command: dotted }, 'no timeout: the end of the line')
})

test('craft\'s own refusals, an OS error, a command that ran and no answer are not the harness\'s', () => {
  assert.equal(harnessRefusal({ exitCode: 1, stdout: '', stderr: 'craft: writing /r/state.json: permission was denied' }), null)
  assert.equal(harnessRefusal({ exitCode: 1, stdout: '', stderr: 'craft: reading /r/state.json: Permission denied (os error 13)' }), null)
  assert.equal(harnessRefusal({ exitCode: 126, stdout: '', stderr: `sh: ${BIN}: Permission denied` }), null, 'a binary that is not executable ran into the OS, not the harness')
  assert.equal(harnessRefusal({ exitCode: 0, stdout: '{}', stderr: 'The command was not run.' }), null)
  assert.equal(harnessRefusal(null), null)
})

test('the stop names the harness, quotes the command, says how to continue and which permission to allow', () => {
  const said = harnessStop(DENIED, shellWord(BIN), RUN)
  assert.ok(said.includes(`the harness's permission check refused the command, not craft — it was not run: \`${DENIED}\``), said)
  assert.ok(said.includes(`The steps done so far are kept in ${RUN}: continue the review with the Workflow \`craft:review run=${RUN}\``), said)
  assert.ok(said.includes(`add a Bash permission rule for \`${BIN} review:*\` with \`/permissions\` (\`Bash(${BIN} review:*)\`)`), said)
  assert.ok(said.includes("The binary's path changes with each plugin update, so the rule must be added again then"), said)
  const unquoted = harnessStop('', shellWord(BIN), '')
  assert.ok(unquoted.includes(`it was not run: a \`${BIN} review\` command`), unquoted)
  assert.ok(unquoted.includes('No run was started'), unquoted)
  assert.doesNotMatch(unquoted, /craft:review run=/)
})

test('the rule names the command\'s own prefix, the binary bare or quoted as the command spells it', () => {
  for (const path of [BIN, 'C:\\Users\\u\\.craft\\bin\\0.47.0\\craft.exe', "/opt/my tools/it's/craft"]) {
    const bin = shellWord(path)
    const command = `${bin} review submit --run '${RUN}' --agents 1`
    const prefix = rulePrefix(harnessStop(command, bin, RUN))
    assert.ok(prefix !== undefined && command.startsWith(`${prefix} `), `${command} | ${String(prefix)}`)
  }
  assert.equal(shellWord(BIN), BIN, 'the usual binary path needs no quoting')
})

test('a refusal with no run says who refused and what to allow, and offers no resume', () => {
  const said = harnessRefused(`${BIN} review gate --cwd .`, BIN)
  assert.ok(said.startsWith(`the harness's permission check refused the command, not craft — it was not run: \`${BIN} review gate --cwd .\`.`), said)
  assert.equal(rulePrefix(said), `${BIN} review`)
  assert.doesNotMatch(said, /run=|resume|continue/)
  const fetch = harnessRefused('', null)
  assert.ok(fetch.includes('it was not run: the fetch of the craft binary'), fetch)
  assert.doesNotMatch(fetch, /Bash\(/, 'no binary yet, so no rule for it')
})
