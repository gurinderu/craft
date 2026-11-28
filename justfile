# The gate as one call: `just gate` runs every recipe in the `gate` group below, in this order, a failed one
# included, prints each one's result and exits non-zero when any failed (`cargo xtask gate`, cli/xtask).
# Without `--base`, the mutation floor's base is origin/main when it resolves.
# `cargo xtask gate-steps` (the `gate-steps` step) fails when a check package.json, integrations/shared/check-*.mjs,
# CI's `test` job, AGENTS.md "Commands" or this file names is neither a step here nor excluded with its reason.
# A step standing for a package.json script is exactly that script's command (gate-steps holds them equal), and
# no line of a gate step or of `gate` may hide its own failure: just runs each as `sh -cu` and stops on a non-zero
# status, so no `-` prefix, no `||`, pipe, `;`, background `&` or `!` outside quotes, and no script recipe
# (`#!` or `[script]`) — gate-steps fails otherwise (cli/xtask/src/masking.rs).
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
