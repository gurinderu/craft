# The gate as one call: `just gate` runs every recipe in the `gate` group below, in this order, a failed one
# included, prints each one's result and exits non-zero when any failed (`cargo xtask gate`, cli/xtask).
# Without `--base`, the mutation floor's base is origin/main when it resolves.
# `cargo xtask gate-steps` (the `gate-steps` step) fails when a check package.json, integrations/shared/check-*.mjs,
# CI's `test` job, AGENTS.md "Commands" or this file names is neither a step here nor excluded with its reason.
# A step standing for a package.json script is exactly that script's command (gate-steps holds them equal).
# Every gate recipe, `gate` included, is held to a small form so an edit that could hide a failure fails gate-steps
# loudly (cli/xtask/src/allowlist.rs): one line; no dependency; no attribute but [group('gate')] and [doc(...)];
# parameters only a name, *name/+name or a literal default; commands joined by `&&`, each one of the commands used
# below (cd, cargo, node, npm, npx, python3, prettier, eslint, vitest, depcruise, knip and the plugin's tsc), with
# no environment assignment and no inline-code flag (node -e/-p/-r/--import, python3 -c, npm/npx -c); words and
# quoted strings, with only `2>&1`, `>&2` and `>file`; `"$@"`, `"$1"` and `${1:+--base "$1"}` only in a recipe
# that takes a parameter; no `{{` and no `-`/`@` prefix. Besides its recipes this file holds only
# `set positional-arguments` and the `export PATH` below. Not a sandbox: an author set on bypassing it can edit
# the xtask too.
# `just gate --base <ref>` hands the base to the one step whose recipe takes `base`; a base no step takes is red.
# Needs `npm ci` and `npm ci --prefix integrations/opencode/plugin`, and cargo for the xtask.

set positional-arguments

export PATH := justfile_directory() + "/node_modules/.bin:" + env_var('PATH')

gate *args:
    cd cli && cargo xtask gate "$@"

[group('gate')]
check-format:
    prettier --check .

[group('gate')]
lint:
    eslint --config integrations/shared/config/eslint.config.mjs integrations/shared integrations/pi integrations/opencode/plugin integrations/shared/config/knip.config.js integrations/shared/config/.dependency-cruiser.mjs --max-warnings 0

[group('gate')]
check-types:
    npm --prefix integrations/opencode/plugin run typecheck

[group('gate')]
check-types-lib:
    integrations/opencode/plugin/node_modules/.bin/tsc -p integrations/shared/tsconfig.json

[group('gate')]
check-engines:
    node integrations/shared/build-engines.mjs --check

[group('gate')]
check-types-workflows:
    node integrations/shared/check-workflow-types.mjs

[group('gate')]
test:
    vitest run --config integrations/shared/config/vitest.config.mjs

[group('gate')]
gate-steps:
    cd cli && cargo xtask gate-steps

[group('gate')]
check-workflows:
    node integrations/shared/check-workflows.mjs

[group('gate')]
check-workflow-size:
    node integrations/shared/check-workflow-size.mjs

[group('gate')]
check-skills:
    node integrations/shared/check-skills.mjs

[group('gate')]
check-js-boundary:
    node integrations/shared/check-js-boundary.mjs

[group('gate')]
check-delivery-parity:
    node integrations/shared/check-delivery-parity.mjs

[group('gate')]
check-opencode-frontmatter:
    python3 integrations/opencode/scripts/check-frontmatter.py agent integrations/opencode/agents/*.md && python3 integrations/opencode/scripts/check-frontmatter.py command integrations/opencode/commands/*.md

[group('gate')]
check-evals:
    node integrations/shared/check-evals.mjs

[group('gate')]
check-deps:
    depcruise --config integrations/shared/config/.dependency-cruiser.mjs integrations/shared integrations/pi integrations/opencode/plugin integrations/claude-code/src

[group('gate')]
check-dead-production:
    knip --config integrations/shared/config/knip.config.js --no-progress --production

[group('gate')]
check-dead:
    knip --config integrations/shared/config/knip.config.js --no-progress

[group('gate')]
check-dup:
    node integrations/shared/check-dup.mjs

# The gate hands this step its base (a recipe parameter named `base`); empty, only the file's form is checked.
[group('gate')]
check-mutation-floor base="":
    node integrations/shared/check-mutation-floor.mjs ${1:+--base "$1"}

# `validate .` reads only the marketplace manifest; check-plugin validates the plugin manifest with its hooks on a
# copy of integrations/claude-code with its symlinks dereferenced, as an install lays it out.
[group('gate')]
plugin-validate:
    npx --yes @anthropic-ai/claude-code plugin validate . --strict

[group('gate')]
check-plugin:
    node integrations/shared/validate-plugin.mjs
