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
const PACKAGE_AWK = `/^[[:space:]]*[[]/ { h=$0; gsub(/[[:space:]]/,"",h); sec=h; dk=""; if (h ~ /^[[]workspace/) { sec="ws" } else if (h ~ /dependencies[.]/) { dk=h; sub(/^.*dependencies[.]/,"",dk); sub(/[]].*$/,"",dk); dep[dk]=dk; sec="dep-table" }; next }
sec=="[package]" && /^[[:space:]]*name[[:space:]]*=/ { v=$0; sub(/^[^"]*"/,"",v); sub(/".*$/,"",v); name=v; next }
sec=="dep-table" && /^[[:space:]]*package[[:space:]]*=/ { v=$0; sub(/^[^"]*"/,"",v); sub(/".*$/,"",v); dep[dk]=v; next }
sec ~ /dependencies[]]$/ && /^[[:space:]]*[A-Za-z0-9_-]/ { k=$0; sub(/^[[:space:]]*/,"",k); sub(/[^A-Za-z0-9_-].*$/,"",k); p=k; if ($0 ~ /package[[:space:]]*=[[:space:]]*"/) { p=$0; sub(/^.*package[[:space:]]*=[[:space:]]*"/,"",p); sub(/".*$/,"",p) }; dep[k]=p; next }
END { line="@@ " d " " c " " s " " name; for (k in dep) line=line " " dep[k]; print line }`

/** The probe of the Cargo packages and the diff's numstat. @param {string} range  the lens diff range, as lensDiffRange spells it */
function cratesPrompt(range) {
  const packages = `git ls-files 'Cargo.toml' '*/Cargo.toml' | while read -r f; do grep -q '^\\[package\\]' "$f" || continue; d=$(dirname "$f"); c=$(git ls-files -- "$d" | grep '[.]rs$' | tr '\\n' '\\0' | xargs -0 -r cat | wc -l); s=$(git grep -h -E '^[[:space:]]*pub[[:space:](]' -- "$d" | wc -l); awk -v d="$d" -v c="$c" -v s="$s" '${PACKAGE_AWK.replace(/\n/g, '; ')}' "$f"; done`
  return `List the Cargo packages of this repository and the diff's line counts. Change nothing. Run each command below ONCE, exactly as written, in one Bash call each.
1. Packages: \`${packages}\`
   Return every line it printed, verbatim and in order, in packages, and the second field of each line (the directory; "." for the root) in roots.
2. Changed lines: \`git diff --numstat --no-renames ${range}\`
   Return every line it printed, verbatim, in numstat.`
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
