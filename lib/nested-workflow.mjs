// How one engine launches another. The Workflow tool's registry names the same engine differently
// depending on where it runs, and a nested launch that guesses one spelling silently loses the
// other environment. The engines import this and esbuild bundles it in (lib/build-engines.mjs).

// Launches a nested workflow under the name that resolves where this engine actually runs. In the
// installed plugin the registry lists engines under the plugin prefix, and a launch by the bare
// name refuses to resolve — observed live: the review pins ran zero agents, and rust-audit's two
// nested reviews died inside its fan-out (realm @nick/craft, node #83). In a checkout of this repo
// the same engines are registered bare. So: the qualified name first, the bare one as fallback.
// The fallback fires ONLY on the sandbox's name-resolution refusal — `workflow()` THROWS on an
// unknown name (documented contract), and the refusal observed live reads `no workflow with that
// name` — never on the nested run itself failing: relaunching a failed review under the second
// spelling would run the whole review twice. A `null` return is a nested engine that died, not a
// missing name — no fallback there either. And when NEITHER spelling resolves, the throw names
// both attempts AND carries the last refusal verbatim — its `Available:` listing is the diagnosis
// that located the live failure at a consumer — so the caller fails loud instead of skipping the
// review, and the record distinguishes a name that would not resolve from a run that died.
/**
 * @param {(name: string, args: unknown) => Promise<unknown>} launchWorkflow  the sandbox's `workflow`
 * @param {string} name
 * @param {unknown} nestedArgs
 * @param {(msg: string) => void} [warn]
 * @returns {Promise<unknown>} the nested run's result — `null` when it died
 */
export async function nestedWorkflow(launchWorkflow, name, nestedArgs, warn = () => {}) {
  /** @param {unknown} e @returns {unknown} the refusal's message, or the thrown value itself */
  const messageOf = e => (e && /** @type {{ message?: unknown }} */ (e).message) || e
  /** @param {unknown} e */
  const unresolved = e => /no workflow with that name/i.test(String(messageOf(e)))
  try {
    return await launchWorkflow(`craft:${name}`, nestedArgs)
  } catch (e) {
    if (!unresolved(e)) throw e
    warn(`nested workflow 'craft:${name}' did not resolve here — retrying as '${name}'`)
    try {
      return await launchWorkflow(name, nestedArgs)
    } catch (e2) {
      if (unresolved(e2)) {
        throw new Error(`nested workflow '${name}': neither 'craft:${name}' nor '${name}' resolved — the nested run did NOT happen (last refusal: ${String(messageOf(e2))})`)
      }
      throw e2
    }
  }
}
