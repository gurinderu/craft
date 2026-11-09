---
name: review-init
description: >-
  Your own review profile of a repository for the craft CLI review — `craft init` — kept outside it (~/.craft/projects/<id>/review.toml), never committed. Integration points: the external systems this code talks to over the network or through their API (kube-ovn, LINSTOR, a cloud API), each with its source git URL and deployed tag or commit, which the review reads; it proposes the project memory's `external` records for you to confirm. CI map: which GitHub CI check runs clippy, tests, fmt or the build, on a command line quoted from the workflow or the recipe it calls — the gate takes their result when it cannot build. Use before a repository's first review, on `not recorded: <system>`, when a deployed version changes, or when the gate's build signal is unknown or its CI map missing or stale. Triggers: craft init, set up my review profile, integration points, the deployed version changed, CI map. Not for library dependencies (a review finds those itself), nor the project's shared memory (memory).
---

# review-init — your review profile of a repository

`craft init` keeps, per reviewer and per repository, the systems the code **integrates with**:
it calls them over the network or through their API, or implements their contract (a
Kubernetes operator watching kube-ovn's CRDs, a client of LINSTOR's REST API). A review reads
each one's source at the revision you name, so a claim about how that system behaves rests on
its code, not on memory. Library dependencies are not asked for: the review opens the version
the lockfile pins on its own.

The profile is read, never built. The review itself is another matter: unless it is started
with `gate=false` (`craft review start --no-gate`), its mechanical gate **builds and runs the
branch's code** on your machine — clippy runs its build scripts and proc macros, `nix flake
check` its checks. Review a branch you do not trust with `gate=false`.

The binary cannot ask you anything inside an agent session. So: **propose, ask, write.**

## 1. Recall the memory's external systems

The project's shared memory may already record the systems the code relies on (`external`
records, written by earlier craft releases; the profile is where these systems live now). Recall them with the craft:memory skill — every active `external`
record, every scope — and keep the list as JSON, each record with `system`, `repo`, `scope` and
`versionFrom` with `versionMatch`, or a stated `version`. None recalled, or no memory configured:
go on without it.

## 2. Get the binary and propose

```sh
CRAFT_BIN="$(node "<this skill's base directory>/../../lib/craft-bin.mjs" ensure)" || exit $?
"$CRAFT_BIN" init --propose --cwd "$(git rev-parse --show-toplevel)" --craft-root "<this skill's base directory>/../.." --memory-externals - <<'CRAFT_MEMORY_EXTERNALS'
<the recalled records as one JSON list, on one line>
CRAFT_MEMORY_EXTERNALS
```

The quoted heredoc hands the records over as written: the shell reads no `'`, `$` or `\` in
them. With nothing recalled, drop the heredoc and `--memory-externals -`. A local build (`cargo build
--release` in craft's `cli/`) can stand for `$CRAFT_BIN`. It prints one JSON object: `profile`
(the file's path, outside the repository), `exists`, `integrations` (what the profile holds now:
`name`, `repo`, `ref`), `memory`, `discovery`, `ci` (the CI map the profile holds now) and
`ciCandidates`. It writes nothing.

- `memory` — the recalled records as candidates, each with `system`, `repo` (its source), `ref`
  (the revision read now from its `versionFrom` file with its `versionMatch` pattern, or its
  stated `version`), `scope`, `point` (the `--point` that writes it), `profileRef` (the revision
  the profile holds for that system, `null` when none) and, when the point would be refused,
  `refused` with why; `refused` at the top names each record that gave no candidate (withdrawn,
  a field missing, its file unreadable or naming no version). `ran: false` with `why` when no
  records were given or they could not be read.
- `discovery` — the candidates the repository's deployment manifests name (Helm charts and
  values, kustomizations, compose files, plain manifests, Terraform git modules) that neither the
  profile nor the memory covers, each with `system`, `repo` (empty or `repoGuessed` when unsure)
  and the `version` the manifest reads; `ran: false` with `why` when it could not run.
- `ciCandidates` — what the repository's `.github/workflows/*.yml` hold for the CI map:
  `resolved`, a job whose `run:` names the cargo command itself, each with `check` (the job's
  `name:`, else its id — the name GitHub reports), `matrix`, `signal` (`clippy`, `test` for
  `cargo test` or `cargo nextest`, `fmt`, `build` for `cargo build` or `cargo check`), `command`,
  `workflow`, `uses` (the local actions or reusable workflows its job runs, `uses: ./…`), `ci`
  (the `--ci` that writes it, those local files already among its `sources`) and, for a clippy
  command that does not pass `-D warnings`, a `note`: a warning does not fail that check unless
  the job denies warnings another way, so tell the reviewer before they confirm it; and
  `unresolved`, a job calling a recipe (`just`, `make`, `cargo xtask`, a script) whose words hint
  at a signal, with its `runs` lines, `hints`, `workflow` and `uses`. `ran: false` with `why`
  when the workflows could not be read.

## 3. Find the rest in the code, then ask

Manifests name what the project **deploys**; an operator usually talks to systems it does not
deploy. Look in the code for clients and contracts of external systems: Kubernetes clients of
another project's CRDs or API groups, generated API clients, gRPC or OpenAPI specs vendored
from another project, SDK imports of a service. Leave out the project's own components and
plain libraries.

Then ask the reviewer in words, one numbered list of every candidate (from the profile, the
memory, the discovery and the code), each with what you found and where — a memory record with
its system, its source and the revision its file names now, and the profile's own revision beside
it when they differ:

- which of these the code really integrates with (drop the rest; add any you missed) — a memory
  record is a candidate like any other, written only on the reviewer's yes;
- for each, the git URL of its source (correct a guessed or empty one);
- the **deployed** revision: a tag (`v1.12.3`) or a full 40-character commit — never a branch
  name, which the review refuses because its cache would serve it stale. A bare version whose
  upstream tag carries a `v` is resolved to it.

Tell the reviewer the revision is the profile's word: when the deployment moves to another
version, run this again.

## 3b. The CI map: resolve, then ask

The gate builds the branch with clippy itself. When it cannot — cargo ends with no compiler
error, a private registry without a token, say — it reads the CI map and takes the result
GitHub reports for the head's commit: a green mapped check passes its signal, a red one blocks
the review, a pending one gives none; a run that ended `cancelled`, `skipped`, `timed_out`,
`startup_failure` or `action_required` gives none either (only `failure`, and a commit status in
`failure` or `error`, is red). So an entry is a claim that a check **runs that command**; it is
written only on the reviewer's word.

- **Resolve each unresolved candidate** by reading the recipe its run line calls — the `justfile`
  recipe, the `Makefile` target, the script, the `xtask` — in the repository, following it to
  the cargo command it runs. Propose an entry only with the command line you saw there, quoted
  as written (`cargo clippy --workspace --all-targets -- -D warnings`). A bare check name, or a
  recipe you could not follow to a cargo command, is never coverage: leave it out and say so.
- **List every file the command goes through** as the entry's `sources`, repository-relative:
  the `justfile`, the `Makefile`, the `xtask`'s source, the script, and each local action or
  reusable workflow the job runs (`uses: ./…` — a composite action's `action.yml`). A cargo alias
  lives in `.cargo/config.toml`, which is hashed on its own whenever it exists. An entry whose
  job runs a local `uses:` it does not list is refused.
- **Matrix jobs**: GitHub reports one check per combination, `<check> (<values>)`; the entry's
  `check` is the job's name, and every run named `<check> (…)` must be green for its signal.
  A `name:` holding `${{ … }}` is reported expanded — ask for the name the PR's checks show.
- Then ask the reviewer in words, one numbered list beside the integration points: for each
  entry, its check, signal, the command line and where you read it (the workflow, or the recipe
  and its line). They confirm, drop, or correct each; add any check you missed.

The profile also keeps the hash of each file an entry rests on — the workflow, each source, the
cargo config —, taken at the write: when any of them changes, the gate skips that entry and says
the CI map is stale, naming the file — come back here. The gate reads CI only for a working tree
with no uncommitted changes to tracked files: CI built the head's commit, not your edits.

## 4. Write

```sh
"$CRAFT_BIN" init --write --cwd "$(git rev-parse --show-toplevel)" \
  --point 'kube-ovn=https://github.com/kubeovn/kube-ovn.git@v1.12.3' \
  --point 'linstor=git@github.com:LINBIT/linstor-server.git@v1.29.0' \
  --ci '{"check":"Rust","signal":"clippy","command":"cargo clippy --all-targets -- -D warnings","workflow":".github/workflows/ci.yml","sources":[]}' \
  --ci '{"check":"lint","signal":"clippy","command":"cargo clippy --workspace -- -D warnings","workflow":".github/workflows/ci.yml","sources":["justfile"]}'
```

`--write` replaces the whole list: pass every point to keep, the ones already there included.
The same holds for the CI map: one `--ci` per entry to keep. A fresh confirmation is a resolved
candidate's `ci` as printed, or the same JSON with the command line you quoted from the recipe
and the recipe files in `sources`; its files are hashed at the write. An entry already held is
passed back exactly as `ci` prints it, `hashes` included: those are kept as recorded, so a
stale entry stays stale until you confirm it again — then pass it without `hashes`, read anew.
An entry whose command does not run its signal's cargo command, whose workflow or a source is
missing, whose job runs a local `uses:` it does not list, or whose `hashes` miss one of its
files, is refused and nothing is written.
At most 8; a name is letters, digits, `.`, `_` or `-`. A confirmed memory record goes in as its
`point`, as printed. A refused point is named on stderr and nothing is written; so is a profile
written by a craft of another format. Report the file's path, the points and the CI map entries written.

## What the review does with it

`craft review start` reads the profile and fetches each point's source, shallow, into
`~/.craft/sources/<host>/<path>@<ref>` (or `$CRAFT_SOURCES_DIR`), once per revision. A source
it cannot fetch (no network, no git, a branch, an unknown tag) is named in the report's
**External sources** section, and that system is reviewed without its context; the review goes
on. A finding that names a system the profile lacks prints `not recorded: <system>`: come back
here.

When the gate cannot build the branch, it reads the CI map and asks GitHub (`gh api`, the
repository gh names from the checkout's remote) for the head commit's check runs and statuses.
Its Gate section then reads, say, `clippy, test via CI (Rust, tests) for 1a2b3c4`; a red check
blocks as a local red would; a check still running gives no signal. CI brings no findings on the
change's lines, and the Gate section says so. A check of one name in several check suites (two
workflows, a re-run in another event) counts in each, so a red in any blocks; within one suite
the latest run counts. More check runs or statuses than one page of 100 gives no signal at all,
as do uncommitted changes in the working tree. Without a map, without `gh` or its login, or
offline, the gate stays unknown and says why; a stale entry is named with this skill as the way
back.
