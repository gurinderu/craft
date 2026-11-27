// The service steps a driver of the CLI's step protocol gets the `craft` binary and the plugin root by (integrations/shared/cli-step-binary.mjs,
// realm @nick/craft, node #453): what the service agent is told to run and to return, and the agent itself, watched for
// the account's usage limit — for any kind of run.
import { pluginRootCheck, pluginScriptPrelude, shq } from './plugin-script.mjs'
import { SERVICE_AGENT_TYPE, makeDefaultTypeFallback } from './service-agent.mjs'
import { limitWatch } from './cli-review-limit.mjs'
import { isObject } from './cli-review-step.mjs'

/** @typedef {import('./cli-step-binary.mjs').Located} Located */
/**
 * A service step: `sent` is the one command its prompt asks run ('' for a script), which names the refused command when
 * the harness's refusal quotes none, as auto mode's classifier does not.
 * @typedef {(label: string, title: string, prompt: string, sent?: string) => Promise<unknown>} Serve
 */

// The fetcher of the released binary, inside the plugin: the POSIX entry, so a consumer needs no Node to get it. The
// service step runs in the harness's Bash; under Git Bash, MSYS or Cygwin the script names the binary craft.exe (not
// observed on a Windows host).
const FETCHER = 'integrations/shared/craft-cli.sh'
// What marks the plugin root a run's records are stamped with (their craftCommit), located beside a given binary: the
// fetcher, which every Claude Code plugin copy holds. The binary files without it (cli/crates/craft-review/src/filing/store.rs).
const ROOT_MARK = FETCHER

/** What a service step returns: the command's exit status and its output, copied whole. */
export const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['exitCode', 'stdout', 'stderr'],
  properties: { exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' } },
}

/**
 * The service step's instructions around `steps`.
 * @param {string} steps @param {string} [stdout]  what its stdout is @returns {string}
 */
export const servicePrompt = (steps, stdout = 'one JSON value') => `${steps}

Return {exitCode, stdout, stderr}: the last command's exit status, and its stdout and stderr each copied VERBATIM and WHOLE. stdout is ${stdout} the caller parses: never summarize, reformat, pretty-print or shorten it. Run nothing else.`

/**
 * The step that gets the binary of this plugin version: integrations/shared/craft-cli.sh, located like the logger (craftRoot,
 * then CLAUDE_PLUGIN_ROOT, then this version's installed copy), fetches the version it is stamped with, so a candidate
 * stamped with another is skipped like an unusable one and the next tried; the fetch's environment is pinned — CRAFT_BIN
 * emptied because this step gets the released binary, CRAFT_REPO because the locating shell holds the reviewed repo's
 * path in it, CRAFT_RELEASE_BASE, CRAFT_API_BASE and CRAFT_TARGET so no stray setting changes which binary runs. The step prints the plugin root it found the fetcher in and the
 * binary's path, so the binary — which, fetched under ~/.craft/bin, finds no plugin root above itself — is handed the
 * root its prompts name.
 * @param {Located} o @param {string} version @returns {string}
 */
export function resolvePrompt(o, version) {
  const stamped = `craft_stamped() {
  CRAFT_WHY="not stamped with craft ${version} ($1)"
  grep -q ${shq(`^version=${version} `)} "$1"
}
`
  const locate = stamped + pluginScriptPrelude(o.craftRoot || undefined, version, o.repo, FETCHER, 'CRAFT_FETCHER', 'craft_stamped "$CRAFT_REAL"')
  return servicePrompt(
    `Run this ONCE, exactly as written, in one Bash call:

\`\`\`sh
${locate}if [ -z "\${CRAFT_FETCHER:-}" ]; then printf '%s\\n' "no usable ${FETCHER} — \${CRAFT_FETCHER_WHY}" >&2; exit 1; fi
CRAFT_BIN_PATH="$(CRAFT_BIN= CRAFT_REPO= CRAFT_RELEASE_BASE= CRAFT_API_BASE= CRAFT_TARGET= sh "$CRAFT_FETCHER" --ensure --print-path)" || exit $?
${rootAbove('CRAFT_FETCHER')}printf 'root=%s\\nbin=%s\\n' "$CRAFT_ROOT_PATH" "$CRAFT_BIN_PATH"
\`\`\``,
    "two lines, root=<the plugin root> and bin=<the binary's path>,",
  )
}

/**
 * The shell that sets CRAFT_ROOT_PATH to the plugin root holding the script located in `varName` (two directories up,
 * `integrations/shared/<script>`), as the Windows binary reads it when cygpath is there. @param {string} varName @returns {string}
 */
const rootAbove = varName => `CRAFT_ROOT_PATH="$(dirname "$(dirname "$(dirname "$${varName}")")")"
if command -v cygpath >/dev/null 2>&1; then CRAFT_ROOT_PATH="$(cygpath -m "$CRAFT_ROOT_PATH")"; fi
`

/**
 * The step that locates the plugin root beside a given craftBin with no craftRoot, for the run's records only: they are
 * stamped with its commit whatever binary runs (realm @nick/craft, nodes #456, #539), and a binary outside any plugin
 * finds none above itself; the prompts keep the binary's own root. Located like the fetcher — the plugin root the harness names, then this version's installed
 * copy, never inside the reviewed repo — and printed as the root a given craftRoot is.
 * @param {Located} o @param {string} version @returns {string}
 */
export function locatePrompt(o, version) {
  const locate = pluginScriptPrelude(undefined, version, o.repo, ROOT_MARK, 'CRAFT_ADAPTER')
  return servicePrompt(
    `Run this ONCE, exactly as written, in one Bash call:

\`\`\`sh
${locate}if [ -z "\${CRAFT_ADAPTER:-}" ]; then printf '%s\\n' "no usable ${ROOT_MARK} — \${CRAFT_ADAPTER_WHY}" >&2; exit 1; fi
${rootAbove('CRAFT_ADAPTER')}printf 'root=%s\\n' "$CRAFT_ROOT_PATH"
\`\`\``,
    'one line, root=<the plugin root>,',
  )
}

/**
 * The step that checks a craftRoot given beside craftBin, which no fetch locates: by the rule every plugin script is
 * located by (plugin-script.mjs), it must hold the plugin manifest outside the reviewed repo.
 * @param {Located} o @returns {string}
 */
export const rootPrompt = o =>
  servicePrompt(
    `Run this ONCE, exactly as written, in one Bash call:

\`\`\`sh
${pluginRootCheck(o.craftRoot, o.repo)}\`\`\``,
    'one line, root=<the plugin root>,',
  )

/**
 * The service agent that runs the binary, watched for the account's usage limit, and that watch.
 * @param {{ agent: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>, log: (message: string) => void }} sb
 */
export function serviceOf(sb) {
  const limit = limitWatch()
  const watched = limit.service((p, opts) => sb.agent(p, opts))
  const service = makeDefaultTypeFallback(
    (/** @type {string} */ p, /** @type {Record<string, unknown>} */ opts) => watched(p, opts),
    sb.log,
    () => !!limit.seen(),
  )
  return { limit, service }
}

/**
 * One service step through `service`: a step that came back with nothing once the usage limit was seen stopped on it.
 * @param {import('./cli-review-record.mjs').Service} service @param {ReturnType<typeof limitWatch>} limit @returns {Serve}
 */
export const serveWith =
  (service, limit) =>
  async (label, title, prompt, sent = '') => {
    const got = await service.run(prompt, { label, phase: title, schema: RUN_SCHEMA, model: 'haiku', effort: 'low', agentType: SERVICE_AGENT_TYPE })
    if (got == null && limit.seen()) return { limit: limit.seen() }
    return sent && isObject(got) ? { ...got, sent } : got
  }
