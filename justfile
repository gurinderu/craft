# The gate as one call: `just gate` runs every recipe in the `gate` group below, in this order, a failed one
# included, prints each one's result and exits non-zero when any failed (`cargo xtask gate`, cli/xtask).
# Without `--base`, the mutation floor's base is origin/main when it resolves.
# `cargo xtask gate-steps` (the `gate-steps` step) fails when a check package.json, integrations/shared/check-*.mjs,
# CI's `test` job, AGENTS.md "Commands" or this file names is neither a step here nor excluded with its reason.
# A gate step's line is exactly one of two forms, nothing else (cli/xtask/src/allowlist.rs):
#   npm run --silent <package.json script>      (` -- ${1:+--base "$1"}` appended only where the recipe takes `base`)
#   cd cli && cargo xtask <check>               (one of xtask's own checks)
# and `gate` is exactly `cd cli && cargo xtask gate "$@"`. A gate recipe is one line, with no dependency, no
# attribute but [group('gate')] and [doc(...)], and parameters only a name, *name/+name or a literal default;
# besides its recipes this file holds only `set positional-arguments`. gate-steps counts a step by the script or
# check its form names and nothing else in the line. What a package.json script itself runs is outside this check,
# as it was when the gate ran its steps through npm. Not a sandbox: an author set on bypassing it can edit the
# scripts or the xtask.
# `just gate --base <ref>` hands the base to the one step whose recipe takes `base`; a base no step takes is red.
# Needs `npm ci` and `npm ci --prefix integrations/opencode/plugin`, and cargo for the xtask.

set positional-arguments

gate *args:
    cd cli && cargo xtask gate "$@"

[group('gate')]
check-format:
    npm run --silent check:format

[group('gate')]
lint:
    npm run --silent lint

[group('gate')]
check-types:
    npm run --silent check:types

[group('gate')]
check-types-lib:
    npm run --silent check:types:lib

[group('gate')]
check-engines:
    npm run --silent check:engines

[group('gate')]
check-types-workflows:
    npm run --silent check:types:workflows

[group('gate')]
test:
    npm run --silent test

[group('gate')]
gate-steps:
    cd cli && cargo xtask gate-steps

[group('gate')]
check-workflows:
    npm run --silent check:workflows

[group('gate')]
check-workflow-size:
    npm run --silent check:workflow-size

[group('gate')]
check-skills:
    npm run --silent check:skills

[group('gate')]
check-js-boundary:
    npm run --silent check:js-boundary

[group('gate')]
check-delivery-parity:
    npm run --silent check:delivery-parity

[group('gate')]
check-opencode-frontmatter:
    npm run --silent check:opencode-frontmatter

[group('gate')]
check-evals:
    npm run --silent check:evals

[group('gate')]
check-deps:
    npm run --silent check:deps

[group('gate')]
check-dead-production:
    npm run --silent check:dead:production

[group('gate')]
check-dead:
    npm run --silent check:dead

[group('gate')]
check-dup:
    npm run --silent check:dup

# The gate hands this step its base (a recipe parameter named `base`); empty, only the file's form is checked.
[group('gate')]
check-mutation-floor base="":
    npm run --silent check:mutation-floor -- ${1:+--base "$1"}

# `validate .` reads only the marketplace manifest; check-plugin validates the plugin manifest with its hooks on a
# copy of integrations/claude-code with its symlinks dereferenced, as an install lays it out.
[group('gate')]
plugin-validate:
    npm run --silent check:marketplace

[group('gate')]
check-plugin:
    npm run --silent check:plugin
