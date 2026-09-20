// ================= Slicing the diff a lens reviews =================
//
// WHY. Measured 2026-09-19 on a live 53-file/10220-insertion run: lenses were 38 agents and 13592
// of 18468 agent-seconds — 73.6% of the run — and the same split appears in tokens (77% of volume,
// 2.8M of cache re-read per lens agent). The cost is not the prompt: a lens prompt is ~3700
// characters and carries a `git diff` COMMAND, not the diff. The agent pulls the diff itself, and
// from then on every turn re-reads it. The most expensive lens spent 726 seconds over 99 turns.
//
// So the quantity that matters is a PRODUCT — context × turns — and a reference stops being a
// reference the moment it is followed: bytes fetched by a tool land in the same window as bytes
// pasted into the prompt, and are paid for again on every subsequent turn. Handing agents links
// instead of text therefore changes nothing by itself. What changes it is a smaller multiplicand:
// each lens pulling the files it is responsible for rather than the whole diff.
//
// WHAT THIS IS NOT. Narrowing the DIFF a lens reviews is not narrowing what it may READ. The lens
// prompt requires context expansion — tracing definitions, uses and consumers, and pinning off-site
// premises to a file:line actually opened. That stays whole-repository. A slice says "these changed
// files are yours to judge", never "this is all you may look at"; the `whereChecked` discipline is
// what keeps a sliced lens honest about premises living outside its slice.
//
// WHAT THE FILE LIST NOW CARRIES, AND THE BOUND ON IT. The changed-file list comes from a cheap
// model agent transcribing `git diff --name-only`. Before slicing it was advisory: a lens got a
// glob that covered the whole diff whatever the list said, so a dropped or mangled path was
// harmless. Slicing promotes that list to the authoritative scope of the code-intrinsic lenses, and
// a file missing from it is reviewed by none of them. The quoting cases are handled by
// `pathspecLiteral`; a model that simply omits a line is not, and there is no reconciliation
// against git at dispatch time.
//
// It is bounded rather than solved, and the bound is structural: the five WHOLE_DIFF_LENSES below
// keep the profile's glob, so a file absent from the list is still read by them. A drop costs the
// code-intrinsic pass over that file, never the whole review — the difference between a thinner
// review and a silent hole. Accepted on that basis; the reconciliation is worth doing and is not
// done here.
//
// THE RISK IS REAL AND IS NOT SOLVED HERE. A defect visible only in the relation between two
// changed files lands on whoever holds both — and if they were split, possibly on nobody. That is
// why grouping is by DIRECTORY rather than by size alone: a change and the change it must agree
// with are overwhelmingly siblings, so cohesion buys back most of what the split costs. It does not
// buy back all of it, and the honest test is not the clock but the finding count. Measured baseline
// to beat: 17 Confirmed High on that run.

// Files whose relation to everything else is the point — a manifest, a lockfile, a schema — are
// pulled into EVERY slice rather than assigned to one. They are small and they are what the rest of
// the diff is checked against; a slice that cannot see the manifest cannot tell that a shipped CRD
// is missing the field the code writes, which is one of the findings the baseline run reported.
export const SHARED_SUFFIXES = ['.lock', '.yml', '.yaml', '.toml', '.json']

// The directory depth a group is keyed on. Two is the working compromise measured against the
// baseline tree: depth 1 collapses everything under `bin/` or `crates/` into one slice and buys
// nothing, while depth 3+ splits a module from its own tests.
export const GROUP_DEPTH = 2

export function isShared(file) {
  return SHARED_SUFFIXES.some(s => file.endsWith(s))
}

export function groupKey(file, depth = GROUP_DEPTH) {
  const parts = String(file).split('/')
  return parts.length <= depth ? (parts.slice(0, -1).join('/') || '.') : parts.slice(0, depth).join('/')
}

// Split one oversized group by descending into deeper directories until it fits, or until going
// deeper stops separating anything. Without this the top-level grouping is decorative on the shape
// real diffs actually have: on the measured tree, depth 2 put 36 of 53 files in one slice, leaving
// the multiplicand almost untouched — the work looks partitioned and is not.
export function splitDeep(group, cap, depth) {
  if (group.files.length <= cap || depth > 8) return [group]
  const byKey = new Map()
  for (const f of group.files) {
    const k = groupKey(f, depth)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(f)
  }
  // A level that separates NOTHING is not a reason to stop — it is a shared prefix to walk through.
  // Every file of the measured 36-file module sits under `.../src`, so stopping at the first
  // undivided level returned the group untouched and the partition was decorative. Descend instead;
  // the depth bound and the "no path is that deep" check below are what terminate this.
  if (byKey.size <= 1) {
    const deeper = splitDeep(group, cap, depth + 1)
    return deeper.length > 1 ? deeper : [group]
  }
  return [...byKey.entries()].flatMap(([key, files]) => splitDeep({ key, files }, cap, depth + 1))
}

/**
 * Partition changed files into cohesive slices.
 *
 * Returns `[]` when slicing is not worth it — fewer files than `minFiles`, or only one group — and
 * the caller then dispatches the lens against the whole diff as before. Returning an empty array
 * rather than a single all-files group is deliberate: "do not slice" and "slice into one" are
 * different instructions to the caller, and collapsing them hides which one happened.
 *
 * Each slice is `{ key, files }` where `files` INCLUDES the shared files, so every slice can check
 * the code it holds against the manifest that declares it.
 */
// How many shared files may ride along in EVERY slice. Unbounded, this works against the very cost
// the partition exists to cut: a tree with a chart directory or a fixture tree can carry more
// changed manifests than source files, and each slice would pull all of them, paid ×slices ×rounds.
// Shallowest-first, so the repository-root manifest — the one a slice most often has to check its
// code against — is the one that survives the cap.
export const MAX_SHARED_PER_SLICE = 8

export function sliceDiff(files, { minFiles = 12, maxSlices = 6, maxFilesPerSlice = 0, owns = null } = {}) {
  const all = (Array.isArray(files) ? files : []).map(String).filter(Boolean)
  // `owns` is the PROFILE's question — which of the changed files this language reviews — and it is
  // asked here rather than by the caller filtering first. Filtering first was the obvious wiring and
  // it is wrong: the rust profile matches `*.rs`, so the manifest and the lockfile would be gone
  // before this function saw them, and no slice could be given the file its code must agree with.
  // The baseline run's shipped-CRD finding is exactly the one that dies that way.
  // SHARED WINS OVER OWNED, and getting this backwards made the header comment above a lie for
  // every real caller. The rust profile's `detect` matches `Cargo.toml`, the nix profile's matches
  // `flake.lock` — so asking "is it shared AND not owned" put each profile's own manifest into ONE
  // slice, exactly the file every other slice has to check its code against. It also produced a
  // degenerate code-free slice holding nothing but manifests, costing one agent per lens per round
  // to review no code at all. A manifest is shared BECAUSE of what it is, not because the profile
  // happens not to claim it.
  const isOwned = typeof owns === 'function' ? owns : f => !isShared(f)
  const shared = all.filter(isShared)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, MAX_SHARED_PER_SLICE)
  const owned = all.filter(f => isOwned(f) && !isShared(f))
  if (owned.length < minFiles) return []

  const byKey = new Map()
  for (const f of owned) {
    const k = groupKey(f)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(f)
  }
  if (byKey.size <= 1) return []

  // The cap defaults to an EVEN SHARE across the allowed slices, so the ceiling follows the diff
  // instead of being a constant that is either meaningless on a small change or useless on a large
  // one. Ceil, so a diff that divides evenly is not split one slice further than asked.
  const cap = maxFilesPerSlice > 0 ? maxFilesPerSlice : Math.max(1, Math.ceil(owned.length / maxSlices))
  let groups = [...byKey.entries()]
    .flatMap(([key, fs]) => splitDeep({ key, files: fs }, cap, GROUP_DEPTH + 1))
    .sort((a, b) => b.files.length - a.files.length || a.key.localeCompare(b.key))

  // Merging is AGGLOMERATIVE BY NEAREST SIBLING, not by taking whatever fell off the end of a sorted
  // list. Sweeping the tail into one bag was the obvious version and it destroyed the very property
  // the partition exists for: on the measured tree it tore a module's own submodule away from it and
  // dropped that submodule in a 21-file drawer with four unrelated crates — so the slice that had to
  // judge a change was the one slice that could not see what the change must agree with.
  // Cohesion is the whole mechanism, so when two groups must become one they are the two that are
  // already closest in the tree, and size breaks the tie so the merge lands on the small ones.
  while (groups.length > maxSlices) {
    // THE CAP OUTRANKS KINSHIP, and this ordering is the whole correctness of the merge. Nearest-
    // sibling alone re-merged exactly what the deep split had just separated — the four children of
    // one module are each other's closest relatives, so they collapsed straight back into the
    // 36-file slice, and the partition ended where it started. So a merge that would exceed the cap
    // is not considered at all while any merge under it exists; only when nothing fits does the
    // smallest available merge win, because at that point some slice must grow and the least bad
    // choice is the smallest one.
    let best = null
    let fallback = null
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const shared = commonPrefixLength(groups[i].key, groups[j].key)
        const size = groups[i].files.length + groups[j].files.length
        const cand = { i, j, shared, size }
        if (!fallback || size < fallback.size) fallback = cand
        if (size > cap) continue
        if (!best || shared > best.shared || (shared === best.shared && size < best.size)) best = cand
      }
    }
    best = best || fallback
    const a = groups[best.i]
    const b = groups[best.j]
    groups = groups.filter((_unused, idx) => idx !== best.i && idx !== best.j)
    groups.push({ key: uniqueKey(mergedKey(a.key, b.key), groups), files: [...a.files, ...b.files] })
  }
  groups.sort((a, b) => b.files.length - a.files.length || a.key.localeCompare(b.key))

  return groups.map(g => ({ key: g.key, files: [...g.files, ...shared] }))
}

// How many leading path segments two group keys share. The unit is the SEGMENT, not the character:
// `bin/service-a` and `bin/service-admin` share one directory, while a character measure would
// score them as nearly identical and merge them ahead of true siblings.
export function commonPrefixLength(a, b) {
  const x = String(a).split('/')
  const y = String(b).split('/')
  let n = 0
  while (n < x.length && n < y.length && x[n] === y[n]) n++
  return n
}

// A merged key names the shared ancestor when there is one, and lists both otherwise. The key is
// what the lens prompt shows the agent and what the log line carries, so a key that says
// the module's own directory tells a reader what the slice IS, where a concatenation of four
// unrelated paths tells them only that a merge happened.
export function mergedKey(a, b) {
  const n = commonPrefixLength(a, b)
  return n > 0 ? String(a).split('/').slice(0, n).join('/') : `${a} + ${b}`
}

// Two merges can land on the same ancestor and produce two slices with one name. The key is what a
// lens prompt shows and what the log line carries, so identical names make two different slices
// indistinguishable in the transcript — and the transcript is where a run is diagnosed.
export function uniqueKey(key, groups) {
  if (!groups.some(g => g.key === key)) return key
  let n = 2
  while (groups.some(g => g.key === `${key} (${n})`)) n++
  return `${key} (${n})`
}

/**
 * Lenses that must NOT be sliced, and why each one.
 *
 * These judge the diff AS A WHOLE, so a slice of it is not a smaller version of their question —
 * it is a different and wrong question. `negative-space` looks for what is missing, and absence is
 * only visible against the whole change. `intent` checks the author's stated claims, which are
 * stated about the change entire. `compat` asks what an other-versioned reader makes of the new
 * wire shapes, and a shape is only breaking in relation to every producer and consumer in the diff.
 *
 * `invariants` and `failure-windows` are here for a sharper reason than the other three, and they
 * were missed on the first pass. Their briefs are MIRROR WALKS: invariants asks, for each site,
 * where its mirror is — client against server, send against receive, offered against accepted — and
 * failure-windows asks for interleavings BETWEEN two components. Both halves of such a pair are
 * ordinary source files, so the shared-file rule does not reach them, and in a real tree the two
 * halves live in different modules by construction: a handler in one binary, the contract type in
 * another crate. Slice them and a guard present on one side with its mirror missing on the other is
 * visible to NO agent — the one concrete class of defect this partition would otherwise delete in
 * silence, which is the failure mode the whole engine exists to prevent.
 *
 * Everything else is code-intrinsic: it judges code by properties the code has in front of it.
 */
export const WHOLE_DIFF_LENSES = ['negative-space', 'intent', 'compat', 'invariants', 'failure-windows']

export function sliceableLens(lens) {
  return !WHOLE_DIFF_LENSES.includes(String(lens))
}

// How many lens agents may be in flight at once. Slicing multiplies the round-1 wave by the slice
// count — a dozen lenses over six slices is ~70 dispatches into what used to be a wave of a dozen —
// and an unwindowed wave of that size is the exact shape verification was windowed for: agents
// queue, the deadline clocks from DISPATCH rather than from execution, and it fires on healthy
// agents that simply waited. Larger than the verification window because a lens is one agent where
// a verification entry can be three, and because a lens legitimately runs for tens of minutes.
export const LENS_WINDOW_AGENTS = 16

// A path as a LITERAL git pathspec. Shell-quoting alone is not enough and the gap is silent: git
// reads a pathspec as wildmatch, so a real file named `f[1].rs` does not match itself; a leading `:`
// is read as pathspec magic; and `git diff --name-only` C-quotes paths holding spaces or non-ASCII,
// so the name that comes back is `"dir/a b.rs"`, quotes included, which then matches nothing.
// Every one of those hands the lens a SMALLER diff than it believes it has, with no error — the
// file is simply never reviewed. That risk arrives with slicing, because the file list stops being
// advisory (the glob covered everything) and becomes the authoritative scope.
export function pathspecLiteral(file) {
  let f = String(file ?? '')
  // Undo git's own C-quoting before handing the name back to git. The escapes are git's, not
  // JavaScript's: with `core.quotePath` at its default a non-ASCII name comes back as
  // `"caf\303\251.rs"` — OCTAL BYTES, one escape per byte of UTF-8. Handling only `\\` and `\"`
  // stripped the quotes and left the literal twelve characters `caf\303\251.rs`, which matches no
  // file — so the name was silently absent from its slice and reviewed by no code-intrinsic lens.
  // That is the exact failure this function exists to prevent, inside the function that prevents it.
  if (f.length > 1 && f.startsWith('"') && f.endsWith('"')) {
    const body = f.slice(1, -1)
    const bytes = []
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== '\\') { bytes.push(body.charCodeAt(i)); continue }
      const c = body[++i]
      const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
      if (Object.prototype.hasOwnProperty.call(simple, c)) { bytes.push(simple[c]); continue }
      // Octal, always three digits as git emits them. Anything else is not an escape git wrote, so
      // it is kept verbatim rather than guessed at.
      if (/[0-7]/.test(c) && /^[0-7]{2}/.test(body.slice(i + 1, i + 3))) {
        bytes.push(parseInt(body.slice(i, i + 3), 8))
        i += 2
        continue
      }
      bytes.push(body.charCodeAt(i))
    }
    // The bytes are UTF-8; decoding them is what turns `\303\251` back into `é`.
    f = new TextDecoder().decode(Uint8Array.from(bytes))
  }
  return `:(literal)${f}`
}
