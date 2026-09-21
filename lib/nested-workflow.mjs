// How one engine launches another. The Workflow tool's registry names the same engine differently
// depending on where it runs, and a nested launch that guesses one spelling silently loses the
// other environment. The workflow scripts cannot import, so this reaches them the same way
// lib/run-logging.mjs does: a fenced region regenerated and byte-compared by
// `node lib/check-workflows.mjs`.

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
export async function nestedWorkflow(workflow, name, args, warn = () => {}) {
  const unresolved = e => /no workflow with that name/i.test(String((e && e.message) || e))
  try {
    return await workflow(`craft:${name}`, args)
  } catch (e) {
    if (!unresolved(e)) throw e
    warn(`nested workflow 'craft:${name}' did not resolve here — retrying as '${name}'`)
    try {
      return await workflow(name, args)
    } catch (e2) {
      if (unresolved(e2)) {
        throw new Error(`nested workflow '${name}': neither 'craft:${name}' nor '${name}' resolved — the nested run did NOT happen (last refusal: ${(e2 && e2.message) || e2})`)
      }
      throw e2
    }
  }
}
