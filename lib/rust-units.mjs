// The Rust profile's unit discovery for the review engine's unitScope mode (realm @nick/craft, #362): a unit is
// a Cargo package (a crate), found by a probe that reads the Cargo manifests git lists, and joined to the
// others by its Cargo dependencies. The neutral modules (lib/unit-*.mjs, lib/review-unit-*.mjs) reach it
// only through the profile's `units` (lib/review-profiles.mjs); the words a confined lens and the contract
// lens read for a Rust unit are here too, so the prompts say "crate" and `pub` as they did.

// The Cargo packages, with what the batching needs of each (realm @nick/craft, #355): one line per package —
// `@@ <dir> <.rs lines> <pub lines> <package name> <dependency names>...` — and the diff's numstat. The awk
// reads [package] name, every [*dependencies] key (a `package = ` rename wins) and [dependencies.<name>]
// tables, never [workspace.*]. Lines count the .rs files git lists under the directory, a nested package's
// included. The awk is written without backslashes and `${`, so it survives the template literal as typed;
// its rules are joined by `; `, the terminator POSIX awk needs between rules on one line.
import { pluginScriptPrelude, shq } from './run-logging.mjs'

const PACKAGE_AWK = `/^[[:space:]]*[[]/ { h=$0; gsub(/[[:space:]]/,"",h); sec=h; dk=""; if (h ~ /^[[]workspace/) { sec="ws" } else if (h ~ /dependencies[.]/) { dk=h; sub(/^.*dependencies[.]/,"",dk); sub(/[]].*$/,"",dk); dep[dk]=dk; sec="dep-table" }; next }
sec=="[package]" && /^[[:space:]]*name[[:space:]]*=/ { v=$0; sub(/^[^"]*"/,"",v); sub(/".*$/,"",v); name=v; next }
sec=="dep-table" && /^[[:space:]]*package[[:space:]]*=/ { v=$0; sub(/^[^"]*"/,"",v); sub(/".*$/,"",v); dep[dk]=v; next }
sec ~ /dependencies[]]$/ && /^[[:space:]]*[A-Za-z0-9_-]/ { k=$0; sub(/^[[:space:]]*/,"",k); sub(/[^A-Za-z0-9_-].*$/,"",k); p=k; if ($0 ~ /package[[:space:]]*=[[:space:]]*"/) { p=$0; sub(/^.*package[[:space:]]*=[[:space:]]*"/,"",p); sub(/".*$/,"",p) }; dep[k]=p; next }
END { line="@@ " d " " c " " s " " name; for (k in dep) line=line " " dep[k]; print line }`

/** The prose probe: the agent runs the shell itself. @param {string} range  the lens diff range, as lensDiffRange spells it */
function proseSteps(range) {
  const packages = `git ls-files 'Cargo.toml' '*/Cargo.toml' | while read -r f; do grep -q '^\\[package\\]' "$f" || continue; d=$(dirname "$f"); c=$(git ls-files -- "$d" | grep '[.]rs$' | tr '\\n' '\\0' | xargs -0 -r cat | wc -l); s=$(git grep -h -E '^[[:space:]]*pub[[:space:](]' -- "$d" | wc -l); awk -v d="$d" -v c="$c" -v s="$s" '${PACKAGE_AWK.replace(/\n/g, '; ')}' "$f"; done`
  return `1. Packages: \`${packages}\`
   Return every line it printed, verbatim and in order, in packages, and the second field of each line (the directory; "." for the root) in roots.
2. Changed lines: \`git diff --numstat --no-renames ${range}\`
   Return every line it printed, verbatim, in numstat.`
}

const PROSE_HEAD = 'List the Cargo packages of this repository and the diff\'s line counts. Change nothing. Run each command below ONCE, exactly as written, in one Bash call each.'
const UNITS_CLI = 'lib/craft-units.mjs'
const UNITS_MISSING = 'CRAFT_UNITS: no usable copy'

/**
 * The probe of the Cargo packages and the diff's numstat. With the plugin's place, the agent runs the shipped
 * units CLI (realm @nick/craft, #377) — these prose commands ported to Node — and returns its JSON: the CLI is
 * located like the logger (pluginScriptPrelude: craftRoot, then CLAUDE_PLUGIN_ROOT, then this version's cached
 * copy, never the reviewed repository). When no copy qualifies or the CLI answers an error, the agent runs the
 * prose commands, so a probe is never worse than before; only both failing is a failed probe. Without the
 * plugin's place, the prose commands alone.
 * @param {string} range  the lens diff range, as lensDiffRange spells it
 * @param {import('./unit-graph.mjs').PluginPlace} [plugin]
 */
function cratesPrompt(range, plugin) {
  if (!plugin) return `${PROSE_HEAD}\n${proseSteps(range)}`
  const locate = pluginScriptPrelude(plugin.craftRoot, plugin.version, plugin.repo, UNITS_CLI, 'CRAFT_UNITS')
  return `List the Cargo packages of this repository and the diff's line counts. Change nothing.
A. Run this ONCE, exactly as written, in one Bash call:
\`\`\`sh
${locate}if [ -n "\${CRAFT_UNITS:-}" ]; then cd ${shq(plugin.repo || '.')} && node "$CRAFT_UNITS" ${range}; else echo ${shq(UNITS_MISSING)}; fi
\`\`\`
   If it printed a JSON object with no "error", that object IS your answer: return its roots, packages and numstat unchanged — every line verbatim and in order, nothing added, nothing reshaped — and stop.
B. Otherwise (it printed \`${UNITS_MISSING}\`, a JSON object with an "error", or nothing): run each command below ONCE, exactly as written, in one Bash call each, and answer from them. Only if these fail too, return roots [] and in error what failed (the CLI's error included).
${proseSteps(range)}`
}

/** @type {import('./unit-graph.mjs').UnitDiscovery} */
export const RUST_UNITS = {
  noun: 'crate',
  probePrompt: cratesPrompt,
  // Cargo matches a dependency to a package by name with `-` and `_` taken as one character.
  nameKey: name => name.replace(/-/g, '_'),
  signatures: `pub signatures and doc comments: \`git grep -n -E '^\\s*(pub|///)' -- <its path>\``,
  surface: r => `\`git grep -n -E '^\\s*(pub|///|#\\[)' -- ${r}\` and its Cargo.toml, with no -A/-B/-C context; a pub item's whole signature (a multi-line fn, a struct's fields, an enum's variants) by \`sed -n\` over just those lines, never past its opening brace into a body`,
  publicItems: 'pub items, error types and variants, trait bounds, Cargo features, re-exports, docs',
  changedItems: 'pub item (fn, type, variant, trait, const, re-export, Cargo feature)',
}
