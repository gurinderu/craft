// How a driver of the CLI's step protocol gets the `craft` binary and the plugin root it hands it (realm @nick/craft, node
// #453), for any kind of run: the released binary of this version fetched by the plugin's POSIX entry, or a given
// craftBin with its craftRoot checked, or the root located beside it only to file the run's records through. The
// sandbox spawns no process (#134), so each step is a service agent's one Bash call, its output copied whole.
import { shellWord } from './plugin-script.mjs'
import { locatePrompt, resolvePrompt, rootPrompt } from './cli-step-service.mjs'
import { absolutePath, commandOutput } from './cli-review-step.mjs'
import { harnessRefused } from './cli-review-refusal.mjs'
import { stopCause } from './cli-review-stop.mjs'

/** @typedef {{ craftBin: string | null, craftRoot: string, repo: string }} Located  what locates the binary and the plugin root: a given craftBin (null: the released one), a given craftRoot ('' none), the repository the run is over ('' the session's) */

/**
 * The plugin root and the binary's path (as a shell word: shellWord) the step printed, or why they are not there.
 * @param {unknown} got @returns {{ bin: string, root: string } | { error: string, harness?: string }}
 */
function resolvedBin(got) {
  const out = commandOutput(got)
  if ('error' in out) return out
  const bin = printedPath(out.stdout, 'bin')
  const root = printedPath(out.stdout, 'root')
  return bin && root
    ? { bin: shellWord(bin), root: driveRoot(root, bin) }
    : { error: `the fetch printed no absolute root= and bin= lines: ${out.stdout.slice(0, 200)}` }
}

/**
 * The root as the Windows binary reads it: beside a drive-path binary, Git Bash's `/c/…` (a step without cygpath, which
 * would have printed `C:/…`) becomes `C:/…`; any other root is left as it stands.
 * @param {string} root @param {string} bin @returns {string}
 */
const driveRoot = (root, bin) => {
  const m = /^[A-Za-z]:[\\/]/.test(bin) ? /^\/([A-Za-z])(\/.*)?$/.exec(root) : null
  return m?.[1] ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : root
}

/** The absolute path on the `<key>=` line of `stdout`, else null. @param {string} stdout @param {string} key */
const printedPath = (stdout, key) =>
  absolutePath(
    stdout
      .split('\n')
      .map(l => l.trim())
      .find(l => l.startsWith(`${key}=`))
      ?.slice(key.length + 1),
  )

/**
 * The checked root, or why it is not one — a harness refusal among the reasons, as commandOutput says it.
 * @param {unknown} got @returns {{ root: string } | { error: string, harness?: string }}
 */
function checkedRoot(got) {
  const out = commandOutput(got)
  if ('error' in out) return out
  const root = printedPath(out.stdout, 'root')
  return root ? { root } : { error: `the check printed no absolute root= line: ${out.stdout.slice(0, 200)}` }
}

/**
 * A service step: `sent` is the one command its prompt asks run ('' for a script), which names the refused command when
 * the harness's refusal quotes none, as auto mode's classifier does not.
 * @typedef {(label: string, title: string, prompt: string, sent?: string) => Promise<unknown>} Serve
 */

/** How to continue when the released binary is not to be got: a local build stands in for it. */
const LOCAL_BUILD = 'Pass craftBin=<absolute path> of a build (`cargo build --release` in cli/).'
/**
 * How to continue when the usage limit stopped the fetch or the check of a given root — the first step on either
 * path: the limit is the account's, so `way`, the way on that path (a local build, another root), does not lift it —
 * the run's own agents answer from the same account (realm @nick/craft, node #689).
 * @param {string} engine @param {string} way @returns {string}
 */
const afterTheLimit = (engine, way) =>
  `Run the ${engine} again once the limit resets: ${way} does not lift the limit — the ${engine}'s agents answer from the same account.`
/** How to continue when the given craftRoot is not a usable plugin root: another one, outside the reviewed repo. */
const ANOTHER_ROOT = "Pass the absolute path of a craft plugin root (an installed copy, or a checkout's integrations/claude-code) outside the reviewed repo."
/**
 * Why the check of a given craftRoot stopped, said by the cause the run record carries (stopCause): under the usage
 * limit or a harness refusal the root was not what failed — the check never ran to its answer — so how to continue is
 * the cause's own: run again after the reset (another root lifts the limit no more than a local build), or
 * allow the check that was refused; only otherwise is the root not a usable one, and another the way on (realm
 * @nick/craft, node #689).
 * @param {string} engine @param {string} craftRoot @param {{ error: string, harness?: string }} checked
 * @returns {{ incomplete: string, cause: import('./cli-review-stop.mjs').StopCause }}
 */
const rootStopped = (engine, craftRoot, checked) => {
  const notChecked = `${engine}: craftRoot=${JSON.stringify(craftRoot)} was not checked as the plugin root: `
  if (checked.harness !== undefined) {
    const incomplete = `${notChecked}${harnessRefused(checked.harness, null, 'the check of the craft plugin root')}`
    return { incomplete, cause: 'harness' }
  }
  const cause = stopCause(checked, 'start')
  return {
    incomplete:
      cause === 'limit'
        ? `${notChecked}${checked.error}. ${afterTheLimit(engine, 'another root')}`
        : `${engine}: craftRoot=${JSON.stringify(craftRoot)} is not a usable plugin root: ${checked.error}. ${ANOTHER_ROOT}`,
    cause,
  }
}
/**
 * The binary to run and the plugin root to hand it: a given craftBin as is, with a given craftRoot checked first, or
 * the root located only to file the run through (`recordRoot`; `note` saying why none was) — the prompts keep the
 * binary's own, so a local build is not run with another plugin's content; otherwise this version's released binary
 * fetched, with the root its fetcher was found in — or why it was not got, with how to continue by its cause.
 * @param {string} engine  the engine's name, as its answers say it @param {Located} o @param {string} craftVersion @param {Serve} serve
 * @returns {Promise<{ bin: string, root: string, recordRoot?: string, note?: string } | { incomplete: string, cause: import('./cli-review-stop.mjs').StopCause }>}
 */
export async function binAndRoot(engine, o, craftVersion, serve) {
  if (o.craftBin === null) {
    const fetched = resolvedBin(await serve('step:resolve', 'Start', resolvePrompt(o, craftVersion)))
    if ('harness' in fetched)
      return { incomplete: `${engine} could not get the craft binary ${craftVersion}: ${harnessRefused(fetched.harness, null)}`, cause: 'harness' }
    if ('error' in fetched) {
      const cause = stopCause(fetched, 'start')
      return {
        incomplete: `${engine} could not get the craft binary ${craftVersion}: ${fetched.error}. ${cause === 'limit' ? afterTheLimit(engine, 'a local build') : LOCAL_BUILD}`,
        cause,
      }
    }
    return fetched
  }
  if (!o.craftRoot) {
    const located = checkedRoot(await serve('step:locate', 'Start', locatePrompt(o, craftVersion)))
    // None located: the binary still looks above itself, at CLAUDE_PLUGIN_ROOT and at its own installed copy.
    return 'error' in located
      ? { bin: o.craftBin, root: '', note: `no craft plugin root was located for the run's telemetry: ${located.error}` }
      : { bin: o.craftBin, root: '', recordRoot: located.root }
  }
  const checked = checkedRoot(await serve('step:root', 'Start', rootPrompt(o)))
  if ('error' in checked) return rootStopped(engine, o.craftRoot, checked)
  return { bin: o.craftBin, root: checked.root }
}
