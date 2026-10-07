export const meta = {
  name: "review",
  description: "Elastic deep review of a diff — auto-detects the language(s) touched, scout-scaled lens fan-out, loop-until-dry, tool-grounded seed findings, adversarial + self-verification, synthesized into one Confirmed/Suspected/Unverified report with a verdict. Rust and Nix profiles built in.",
  whenToUse: 'The single review path for any diff/PR before commit or merge. priorDecisions is optional: without it the engine itself recalls the active decisions for the paths of the diff through the craft:memory skill, and the report names the source (an empty list skips the recall). To post findings on a PR pass comment — never post findings by hand: only comments from the engine carry the marker that ties a later rejection to its finding. Auto-detects language; pin with args.languages (e.g. ["rust"] or ["nix"]). Scales depth to the diff automatically. To review ANOTHER repository pass repo=<absolute path> — without it every git command runs in the checkout the session itself sits in; path= is a repo-relative pathspec, NOT a way to select the repo. The performance / api-idioms / api-boundary lenses are an OPTIONAL pass that is OFF by default — request it with optional=true (or optional=performance,api-boundary); every report names what it skipped. priorDecisions — ONLY inside an object argument, {priorDecisions: [<the active decision records of the project, recalled by the memory skill for the paths of the diff>]}; as a string (key=value or JSON text) it is refused and nothing of it applied, and in a key=value string nothing after it is read as an option — sets aside a finding the project already rejected — listed under Rejected before with who, when, why and a link, never dropped — unless it is Critical/High or its scope changed since the commit of the decision; a malformed value applies nothing and is named in the report. deadlineMs=<ms> is a diagnostic knob, not a review option: it replaces the per-phase wall-clock deadline table wholesale and will kill healthy lenses if set below their real duration.',
  phases: [
    { title: "Scout", detail: "cheap classification: resolve the diff base, detect language(s), classify size/categories, pick lenses (rigor is derived from the size, in code)", model: "haiku" },
    { title: "Gate", detail: "per-language CI-aware mechanical gate + tool-grounded seed findings" },
    { title: "Lenses", detail: "parallel per-lens review with context expansion; loop-until-dry" },
    { title: "Verify", detail: "cross-lens dedup, then adversarial refutation + self-verification of each finding" },
    { title: "Synthesize", detail: "calibrate severities, completeness critic, one merged report" }
  ]
};
function applyOption(m, out2, ignored) {
  const banned = (k) => k === "__proto__" || k === "constructor" || k === "prototype";
  if (m[7])
    return banned(m[7]) ? (ignored.push(m[7]), 0) : (out2[m[7]] = !0, 1);
  const key2 = (
    /** @type {string} */
    m[2]
  );
  if (banned(key2))
    return ignored.push(key2), 0;
  const quoted = m[4] ?? m[5];
  if (quoted !== void 0)
    return out2[key2] = quoted, 1;
  try {
    out2[key2] = JSON.parse(
      /** @type {string} */
      m[3]
    );
  } catch {
    out2[key2] = /** @type {string} */
    m[3];
  }
  return 1;
}
const OBJECT_ONLY_OPTIONS = ["priorDecisions"];
function parseOptions(text) {
  const pair = /(--?)?(\w[\w-]*)=("([^"]*)"|'([^']*)'|\S+)|(--)(\w[\w-]*)/g, out2 = {};
  let pairs = 0;
  const ignored = [];
  let m, cursor = 0;
  for (; (m = pair.exec(text)) !== null; ) {
    const gap = text.slice(cursor, m.index).trim();
    gap && ignored.push(...gap.split(/\s+/));
    const key2 = String(m[2] ?? m[7]);
    if (OBJECT_ONLY_OPTIONS.includes(key2))
      return out2[key2] = text.slice(m.index), { options: out2, pairs: pairs + 1, ignored, cut: key2 };
    cursor = pair.lastIndex, pairs += applyOption(m, out2, ignored);
  }
  const tail = text.slice(cursor).trim();
  return tail && ignored.push(...tail.split(/\s+/)), { options: out2, pairs, ignored, cut: "" };
}
function normalizeJsonArgs(text, warn) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed == "object" && !Array.isArray(parsed) ? (warn("⚠️ args arrived as a JSON string, not an object — parsed it; pass a real object to avoid this"), parsed) : (warn("⚠️ args arrived as a non-object JSON value — ALL options ignored, running with defaults"), {});
  } catch (e) {
    return warn(`⚠️ args arrived as a string that looks like JSON but is not (${String(e && /** @type {{ message?: unknown }} */
    e.message || e).slice(0, 60)}) — ALL options ignored, running with defaults`), {};
  }
}
function normalizeKeyValueArgs(text, warn) {
  const { options, pairs, ignored, cut } = parseOptions(text);
  return cut && warn(`⚠️ ${cut} arrived in the key=value string — it and everything after it were not read as options (its value cannot be delimited there); pass args as an object`), pairs ? (warn("⚠️ args arrived as a key=value string — parsed it; pass a real object to avoid this"), ignored.length && warn(`⚠️ ignored ${ignored.length} word(s) in args that are not options (${ignored.slice(0, 6).join(" ")}) — quote a value that contains spaces`), options) : (warn(`⚠️ args arrived as an unrecognized string (${text.slice(0, 40)}) — ALL options ignored, running with defaults`), {});
}
function normalizeArgs(args2, warn = () => {
}) {
  if (args2 && typeof args2 == "object" && !Array.isArray(args2)) return (
    /** @type {Record<string, unknown>} */
    args2
  );
  if (typeof args2 != "string" || !args2.trim()) return {};
  const text = args2.trim();
  return text.startsWith("[") || text.startsWith('"') ? (warn(`⚠️ args arrived as a JSON value that is not an object (${text.slice(0, 40)}) — ALL options ignored, running with defaults`), {}) : text.startsWith("{") ? normalizeJsonArgs(text, warn) : normalizeKeyValueArgs(text, warn);
}
const A = normalizeArgs(args, log);
function argString(key2) {
  return A[key2] ? String(A[key2]) : "";
}
const baseArg = argString("base"), intentArg = argString("intent"), postComments = !!A.comment;
let pathArg = argString("path"), repoArg = argString("repo");
const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/])/;
let ambiguousPath = "", scopeNotRun = [], scopeDetail = "";
const scopeSection = () => scopeNotRun.length ? `

## Scope
⚠️ ${scopeDetail || scopeNotRun.join(`
⚠️ `)}
` : "", DECISION_FIELD_MAX = { id: 80, title: 200, scope: 300, reason: 1200, who: 120, when: 40, link: 500 };
function decisionScopeParts(p) {
  return p.split(/[\\/]+/).filter((s) => s && s !== ".");
}
function decisionText(v) {
  return typeof v == "string" ? v.trim() : "";
}
function decisionFields(o) {
  const f = (k, alt = "") => decisionText(o[k]) || decisionText(o[alt]), links = Array.isArray(o.links) ? o.links : [], url = decisionText(links.find((l) => /^https?:\/\//.test(decisionText(l))));
  return { id: f("id"), title: f("title"), scope: f("scope") || ".", reason: f("reason", "body"), who: f("who", "author"), when: f("when", "date"), link: f("link") || url, commit: f("commit") };
}
function decisionProblem(o, d) {
  if (o.kind != null && decisionText(o.kind) !== "decision") return ` is a ${JSON.stringify(o.kind)} record, not a decision`;
  if (o.status != null && decisionText(o.status) !== "active") return ` is not active (status ${JSON.stringify(o.status)})`;
  if (!d.id || !d.title || !d.reason) return " lacks an id, a title or a reason";
  const over = Object.entries(DECISION_FIELD_MAX).find(([k, max]) => d[
    /** @type {keyof PriorDecision} */
    k
  ].length > max);
  return over ? `: ${over[0]} is ${d[
    /** @type {keyof PriorDecision} */
    over[0]
  ].length} chars, over the ${over[1]}-char ceiling` : decisionAnchorProblem(d);
}
const SAFE_SCOPE = /^[A-Za-z0-9._@+/ -]+$/;
function hasControlChar(s) {
  return [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}
function decisionAnchorProblem(d) {
  const ctl = (
    /** @type {const} */
    ["id", "scope", "commit"].find((k) => hasControlChar(d[k]))
  );
  return ctl ? `: ${ctl} contains a control character` : /^([\\/]|~|[A-Za-z]:)/.test(d.scope) || decisionScopeParts(d.scope).includes("..") ? `: scope ${JSON.stringify(d.scope)} is not a repo-relative path` : SAFE_SCOPE.test(d.scope) ? d.commit && !/^[0-9a-f]{7,40}$/i.test(d.commit) ? `: commit ${JSON.stringify(d.commit)} is not a commit hash` : "" : `: scope ${JSON.stringify(d.scope)} has a character outside letters, digits and ._@+/ -`;
}
function readPriorDecision(raw, i) {
  if (!raw || typeof raw != "object" || Array.isArray(raw)) return `decision #${i} is not an object`;
  const o = (
    /** @type {Record<string, unknown>} */
    raw
  ), d = decisionFields(o), problem = decisionProblem(o, d);
  return problem ? `decision #${i}${d.id && !hasControlChar(d.id) ? ` (${d.id})` : ""}${problem}` : d;
}
const PRIOR_DECISIONS_MAX = 100, DECISION_TITLE_OVERLAP = 0.6;
function parsePriorDecisions(raw) {
  if (raw == null || raw === "") return { decisions: [], refused: [] };
  if (typeof raw == "string") return { decisions: [], refused: ["priorDecisions arrived as a string — only a list inside an object argument is read (in a key=value string nothing from priorDecisions on was read as an option) — no decision applied"] };
  const list = raw;
  if (!Array.isArray(list)) return { decisions: [], refused: ["priorDecisions is not a list — no decision applied"] };
  const decisions = [], refused = [];
  return list.slice(0, PRIOR_DECISIONS_MAX).forEach((item, i) => {
    const d = readPriorDecision(item, i);
    typeof d == "string" ? refused.push(d) : decisions.some((x) => x.id === d.id) ? refused.push(`decision #${i} (${d.id}) repeats an id already given — not applied`) : decisions.push(d);
  }), list.length > PRIOR_DECISIONS_MAX && refused.push(`${list.length - PRIOR_DECISIONS_MAX} decision(s) past the cap of ${PRIOR_DECISIONS_MAX} were not applied — findings they would answer are raised normally`), { decisions, refused };
}
function titleWords(t) {
  return new Set(String(t ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}
function decisionAnswers(f, d) {
  const file = decisionScopeParts(String(f.file ?? "")), scope = decisionScopeParts(d.scope);
  if (!file.length || scope.length > file.length || scope.some((s, i) => s !== file[i])) return !1;
  const a = titleWords(f.title), b = titleWords(d.title);
  if (!a.size || !b.size) return !1;
  let shared = 0;
  for (const w of a) b.has(w) && shared++;
  return shared / Math.max(a.size, b.size) >= DECISION_TITLE_OVERLAP;
}
function reraisedBySeverity(sev) {
  return /^(critical|high)$/i.test(String(sev ?? "").trim());
}
function priorDecisionsRefusedSection(refused) {
  return refused.length ? `

## Prior decisions not applied
${refused.map((r) => `- ⚠️ ${r}`).join(`
`)}
` : "";
}
const RECALL_PATHS_MAX = 60, MEMORY_RECALL_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["backend", "why", "decisions"],
  properties: {
    backend: { type: "string", description: "the memory backend recall used, or none" },
    why: { type: "string", description: "one line: the rule that chose the backend, or why there is none, or that recall found nothing" },
    decisions: {
      type: "array",
      description: "the matching active decision records, verbatim",
      items: { type: "object", properties: { ...Object.fromEntries(["id", "kind", "title", "body", "scope", "status", "date", "author", "commit"].map((k) => [k, { type: "string" }])), links: { type: "array", items: { type: "string" } } } }
    },
    stale: {
      type: "array",
      description: "matching active decisions that no longer hold against the code, left out of decisions and NOT superseded",
      items: { type: "object", properties: { id: { type: "string" }, why: { type: "string" } } }
    }
  }
};
function memoryRecallPrompt(paths, base) {
  const listed = paths.slice(0, RECALL_PATHS_MAX), cut = paths.length - listed.length;
  return `Recall the remembered decisions of this project for a code review. READ ONLY: write, record, edit or create nothing anywhere (no memory record, no file, no MCP create call).
Scope: ${listed.length ? `these changed paths of the diff:
${listed.map((p) => `- ${p}`).join(`
`)}${cut ? `
(${cut} more path(s) cut at the bound of ${RECALL_PATHS_MAX} — not recalled for)` : ""}` : `the paths of \`git diff --name-only ${base || "$(git merge-base origin/main HEAD)"}...HEAD\``}
1. Invoke the craft:memory skill with the Skill tool and run its recall for those paths: kind decision, status active only, no topic.
2. If that skill is unavailable, follow its backend order yourself; the first that applies wins: (a) an explicit setting, env CRAFT_MEMORY, else a line \`craft-memory: <value>\` in AGENTS.md or CLAUDE.md at the repo root (mcp | harness | repo | none; a pinned backend that is unavailable means none); (b) a connected memory or knowledge-graph MCP server found by capability: load the deferred tools of the session with ToolSearch and take a server whose tools offer both a search over stored items and a create of a new item, judged by what the tools do, never by a server or tool name; use only its search; (c) the project memory files of the harness: Claude Code keeps them in \`~/.claude/projects/<slug>/memory/\` with \`MEMORY.md\` as the index, keyed by the repository's main checkout, never a worktree or subdirectory: root = \`dirname "$(git rev-parse --path-format=absolute --git-common-dir)"\`, \`pwd\` only outside a git repo; <slug> = root with every character that is not an ASCII letter or digit replaced by \`-\` (observed: \`/home/ubuntu/projects/my/craft\` → \`-home-ubuntu-projects-my-craft\`) — an observed convention (realm @nick/craft, node #209); \`~/.claude/projects/<slug>/memory\` must exist: read MEMORY.md, then only the matching files; else say \`none — harness memory directory <path>/memory not found\` and never guess a near match; (d) \`.craft/memory/decision/\` in the repo. None applies: backend none.
3. A record matches a path when its scope equals the path, is a directory containing it, names its component, or is \`.\`.
4. A stale matching decision — one that no longer holds against the code as it is now (its reason is gone): supersede nothing — leave it out of decisions and list it in stale as {id, why}; superseding stays with craft:addressing-findings.
Return {backend, why, decisions, stale}: backend names the store used (or none); why is one line naming the rule that chose it, or why there is none, or that recall found nothing; decisions are the matching active decision records verbatim in the record shape id, kind, title, body, scope, status, date, author, commit, links (nothing rewritten or summarised; [] when none); stale is [] when none.`;
}
const recallText = (v) => typeof v == "string" ? v.replace(/\s+/g, " ").trim() : "";
function staleTail(list) {
  const named = (Array.isArray(list) ? list : []).flatMap((x) => {
    const r = (
      /** @type {Record<string, unknown>} */
      x && typeof x == "object" ? x : {}
    ), id = recallText(r.id);
    return id ? [`${id} (${recallText(r.why) || "no reason given"})`] : [];
  });
  return named.length ? `; stale, left out: ${named.join(", ")}` : "";
}
function readMemoryRecall(raw, cut) {
  const r = (
    /** @type {Record<string, unknown>} */
    raw && typeof raw == "object" && !Array.isArray(raw) ? raw : {}
  ), tail = cut > 0 ? `; ${cut} changed path(s) past the bound of ${RECALL_PATHS_MAX} were not recalled for` : "", list = r.decisions;
  if (!Array.isArray(list)) return { decisions: [], memory: { source: "none", count: 0, why: `the recall agent died or returned no decision list, so no project memory was applied — findings are raised normally${tail}` } };
  const backend = recallText(r.backend) || "an unnamed backend", why = recallText(r.why) || "no reason given", stale = staleTail(r.stale);
  return list.length ? { decisions: list, memory: { source: "recalled", count: list.length, why: `${backend} (${why})${stale}${tail}` } } : { decisions: [], memory: { source: "none", count: 0, why: `${why} (backend ${backend})${stale}${tail}` } };
}
function initialMemory(raw, count = Array.isArray(raw) ? raw.length : 0) {
  return raw == null || raw === "" ? { source: "none", count: 0, why: "not recalled — the run ended before its recall step" } : { source: "passed", count, why: "passed by the launcher" };
}
function acceptedMemory(m, accepted) {
  return m.source === "recalled" ? { ...m, count: accepted } : m;
}
function memoryLine(m, forwarded = !1) {
  return m.source === "passed" ? `memory: passed by the launcher (${m.count})` : m.source !== "recalled" ? `memory: none — ${m.why}` : forwarded ? `memory: returned ${m.count} decision(s) from ${m.why}; each nested review reports how many it applied` : `memory: recalled ${m.count} decision(s) from ${m.why}`;
}
function memorySection(m, forwarded = !1) {
  return `

## Memory
- ${memoryLine(m, forwarded)}
`;
}
async function recallDecisions(ask, paths, base) {
  let raw;
  try {
    raw = await ask(memoryRecallPrompt(paths, base));
  } catch (e) {
    const msg = recallText(e instanceof Error ? e.message : String(e));
    return { decisions: [], memory: { source: "none", count: 0, why: `the recall agent did not run (${msg}) — no project memory applied; findings are raised normally` } };
  }
  return readMemoryRecall(raw, Math.max(0, paths.length - RECALL_PATHS_MAX));
}
function decisionsToCheck(findings, decisions) {
  const out2 = /* @__PURE__ */ new Set(
    /** @type {PriorDecision[]} */
    []
  );
  for (const f of findings) {
    if (reraisedBySeverity(f.severity)) continue;
    const d = decisions.find((x) => decisionAnswers(f, x));
    d && d.commit && out2.add(d);
  }
  return [...out2];
}
function scopeCheckScript(decisions) {
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  return decisions.map((d) => `if git cat-file -e ${q(`${d.commit}^{commit}`)} 2>/dev/null; then git diff --quiet ${q(d.commit)} -- ${q(d.scope)}; echo ${q(d.id)} $?; else echo ${q(d.id)} missing; fi`).join(`
`);
}
const SCOPE_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["unchanged", "missing", "reason"],
  properties: {
    unchanged: { type: "array", items: { type: "string" }, description: "ids whose line ended in exit status 0, exactly as printed" },
    missing: { type: "array", items: { type: "string" }, description: "ids whose line ended in the word missing, exactly as printed" },
    reason: { type: "string", description: "one line: anything that did not run" }
  }
};
function scopeCheckPrompt(decisions) {
  return `Run these lines in the repository under review, exactly as written (shell only, read only). Each prints a decision id and the exit status of \`git diff --quiet\` against that decision's commit, or the word missing when the repository does not have that commit.
${scopeCheckScript(decisions)}
Return {unchanged: [every id whose printed status was 0], missing: [every id printed with the word missing], reason: one line on anything that did not run}.`;
}
function readScopeCheck(ans) {
  const o = ans && typeof ans == "object" ? (
    /** @type {Record<string, unknown>} */
    ans
  ) : {}, ids = (v) => Array.isArray(v) ? v.filter((x) => typeof x == "string") : [];
  return Array.isArray(o.unchanged) ? { unchanged: ids(o.unchanged), missing: ids(o.missing) } : null;
}
async function runScopeCheck(toCheck, checkScopes, notes) {
  const unchanged = /* @__PURE__ */ new Set(
    /** @type {string[]} */
    []
  ), missing = /* @__PURE__ */ new Set(
    /** @type {string[]} */
    []
  );
  if (!toCheck.length) return { toCheck, unchanged, missing };
  const ids = readScopeCheck(await checkScopes(toCheck));
  ids == null && notes.push(`the scope-check agent died or answered unreadably — no decision could be shown unchanged, so the ${toCheck.length} decision(s) set nothing aside`);
  for (const id of ids?.unchanged || []) unchanged.add(id);
  for (const d of toCheck) ids?.missing.includes(d.id) && missing.add(d.id);
  return { toCheck, unchanged, missing };
}
function priorDecisionMark(d) {
  return `REJECTED BEFORE: ${d.reason} — ${d.who || "author not recorded"}, ${d.when || "date not recorded"}, ${d.link || "no link"} (decision ${d.id})`;
}
function commitMissingReason(d) {
  return `commit ${d.commit} not found in this repo — raised normally`;
}
function reraiseReason(f, d, unchanged, missing = /* @__PURE__ */ new Set()) {
  return reraisedBySeverity(f.severity) ? "a Critical/High finding is never set aside by a prior decision" : d.commit ? missing.has(d.id) ? commitMissingReason(d) : unchanged.has(d.id) ? "" : `the code in ${d.scope} changed since ${d.commit} (or that could not be checked)` : "the decision records no commit, so an unchanged scope cannot be established";
}
function splitByDecisions(findings, decisions, unchanged, tier, noteField = "why", missing = /* @__PURE__ */ new Set()) {
  const kept = [], setAside = [];
  let reraised = 0;
  for (const f of findings) {
    const d = decisions.find((x) => decisionAnswers(f, x));
    if (!d) {
      kept.push(f);
      continue;
    }
    const why = reraiseReason(f, d, unchanged, missing), note = `${String(f[noteField] ?? "")} · `;
    if (!why) {
      setAside.push({ ...f, priorTier: String(f.tier || tier), priorDecision: d.id, [noteField]: note + priorDecisionMark(d) });
      continue;
    }
    reraised++, kept.push({ ...f, [noteField]: `${note}Rejected before (decision ${d.id}, ${d.who || "author not recorded"}, ${d.when || "date not recorded"}) — raised again: ${why}.` });
  }
  return { kept, setAside, reraised };
}
function priorRejectedSection(setAside) {
  return setAside.length ? `

## Rejected before (set aside — not in the verdict)
` + setAside.map((f) => `- ${String(f.severity ?? "?")} · \`${String(f.file || "?")}:${String(f.line || 0)}\` · ${String(f.title ?? "")} · ${String(f.why ?? "")}`).join(`
`) : "";
}
async function applyPriorDecisions(tiers, decisions, checkScopes, noteField = "why") {
  let setAside = [];
  const notes = [];
  if (!decisions.length) return { tiers, setAside, reraised: 0, notes, refused: [] };
  const { toCheck, unchanged, missing } = await runScopeCheck(decisionsToCheck(Object.values(tiers).flat(), decisions), checkScopes, notes), refused = toCheck.filter((d) => missing.has(d.id)).map((d) => `decision ${d.id}: ${commitMissingReason(d)}`);
  let reraised = 0;
  const out2 = {};
  for (const [tier, list] of Object.entries(tiers)) {
    const r = splitByDecisions(list, decisions, unchanged, tier, noteField, missing);
    out2[tier] = r.kept, setAside = setAside.concat(r.setAside), reraised += r.reraised;
  }
  return notes.push(`${decisions.length} decision(s) given, ${setAside.length} finding(s) set aside as rejected before, ${reraised} raised again`), { tiers: out2, setAside, reraised, notes, refused };
}
const FINDING_COMMENT_MARKER = "<!-- craft-finding -->";
function commentLine(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}
function findingCommentBody(f) {
  return `[${commentLine(f.severity)}] ${commentLine(f.title)}

${String(f.why ?? "").trim()} — ${String(f.fix ?? "").trim()}

${FINDING_COMMENT_MARKER}`;
}
function pathSegments(p) {
  const segs = [];
  for (const s of String(p).split(/[\\/]+/))
    if (!(!s || s === ".")) {
      if (s === ".." && segs.length && segs[segs.length - 1] !== "..") {
        segs.pop();
        continue;
      }
      segs.push(s);
    }
  return segs;
}
function relativeToRepo(abs, repo) {
  const r = pathSegments(repo), p = pathSegments(abs);
  if (!r.length || p.length < r.length) return null;
  for (let i = 0; i < r.length; i++) if (p[i] !== r[i]) return null;
  return p.slice(r.length).join("/");
}
function resolveScopePath() {
  if (ABSOLUTE_PATH.test(pathArg)) {
    const rel = repoArg ? relativeToRepo(pathArg, repoArg) : null;
    if (rel != null)
      log(`⚠️ path=${pathArg} is absolute but sits inside repo=${repoArg} — read as the repo-relative scope ${shq(rel)}.`), pathArg = rel;
    else if (repoArg) {
      const msg = `the requested scope path=${pathArg} was DROPPED: it is ABSOLUTE and does not resolve inside repo=${repoArg}, and an absolute pathspec matches nothing (the review would have seen an EMPTY diff). The review below therefore covers the WHOLE repository, not the requested scope — re-run with a repo-relative path to narrow it.`;
      log(`⚠️ ${msg}`), scopeNotRun = ["the requested scope was DROPPED — an absolute `path` that does not resolve inside `repo`, so the review covered the whole repository instead"], scopeDetail = msg, pathArg = "";
    } else
      ambiguousPath = pathArg;
  }
}
resolveScopePath();
const craftRootArg = argString("craftRoot"), loggerPreludeNow = () => loggerPrelude(craftRootArg, CRAFT_VERSION, repoArg), LOGGER_PATH = '"$CRAFT_LOGGER"', viaArg = argString("_via"), strict = !!A.strict;
let priorDecisionsIn = parsePriorDecisions(A.priorDecisions), memory = initialMemory(A.priorDecisions, priorDecisionsIn.decisions.length);
for (const r of priorDecisionsIn.refused) log(`⚠️ priorDecisions: ${r}`);
const requestedLangs = A.languages, freshArg = !!A.fresh, fullEvery = fullEveryArg();
function fullEveryArg() {
  return A.fullEvery != null ? Math.max(0, Number(A.fullEvery)) : 3;
}
const GATE_TIME_BUDGET = `
TIME BUDGET (hard): wrap EVERY build/lint/test command in \`timeout\` so the shell kills it instead of
you waiting — e.g. \`timeout 600 cargo clippy … ; echo "EXIT=\${PIPESTATUS[0]}"\`. Allow roughly 10
minutes for the primary gate command and 5 for each optional one. A command that hits the timeout is
NOT a failure and NOT a retry: record that signal as unknown, say in notes which command timed out and
after how long, and move on to the next one. Never re-run a timed-out build hoping it is faster the
second time — the cache is no warmer and you will spend the whole review on it. status=fail is
reserved for a check that actually RAN and came back red. If the primary gate times out, the review
continues on the remaining signals with status=unknown — an incomplete gate beats a dead run.`, PROBE_BUDGETS = {
  "ci-check-runs": { max: 1, what: "gh api repos/{owner}/{repo}/commits/$SHA/check-runs" },
  "ci-commit-status": { max: 1, what: "gh api repos/{owner}/{repo}/commits/$SHA/status" },
  "ci-pr-checks": { max: 0, what: "gh pr checks — resolves by branch; forbidden, the SHA-scoped calls answer it" },
  "ci-pr-by-commit": { max: 0, what: "gh api …/commits/$SHA/pulls — forbidden in preflight; the gate owns PR lookup" },
  "workflow-file": { max: 2, what: "reading a .github/workflows/*.yml behind a green check" },
  "tool-inventory": { max: 2, what: "the one-shot command -v loop (once bare, once under the runner prefix)" },
  "runner-verify": { max: 2, what: "an instant <prefix>true / <prefix>rustc --version" },
  "blocker-probe": { max: 4, what: "the grep/ls/test questions behind a compile blocker, and for Nix the flake-metadata and `system`-match checks" },
  "repo-identity": { max: 2, what: "git rev-parse HEAD / git remote get-url origin" },
  "runner-discover": { max: 2, what: "the ls/test sweep for the dev-shell markers (.envrc, flake.nix, shell.nix, .direnv/)" }
};
function probeDeclarationBlock() {
  return `5. DECLARE YOUR PROBES. Return \`probes\`: one entry per source you consulted, \`{ "source": "<id>", "calls": <how many shell/API invocations you spent on it> }\`. Count every invocation, including ones that returned nothing. The ids and their budgets:
${Object.entries(PROBE_BUDGETS).map(([id, b]) => b.max === 0 ? `   - \`${id}\`: FORBIDDEN (${b.what}) — declaring calls > 0 here is a violation, not a note` : `   - \`${id}\`: at most ${b.max} (${b.what})`).join(`
`)}
   Use these ids EXACTLY; an id not on this list is itself reported as a violation, so a repeat cannot be relabelled into a fresh question. A source you did not consult is simply absent (do not declare it with \`calls: 0\`), and \`calls\` is a whole number ≥ 0 on every entry — a missing, non-integer or negative count is itself a violation. \`probes\` can NEVER be empty and is never emptied by a partial result: it reports what you ALREADY did, so running out of time shortens the list, it does not erase it — an empty list is reported as a violation, not read as a disciplined run. THE ENGINE AUDITS THIS: an over-budget or forbidden or unrecognized source is named in the run's log and carried into its record. Declaring fewer calls than you made is a false report, which is worse than an over-budget honest one.`;
}
function auditPreflightProbes(pf) {
  if (!pf) return [];
  const out2 = [], probes = Array.isArray(pf.probes) ? pf.probes : null;
  if (!probes)
    return out2.push("preflight declared no `probes` list — the per-source budget could not be audited"), out2;
  if (probes.length === 0)
    return out2.push("preflight declared an EMPTY `probes` list — a preflight consults something by definition, and an empty declaration is not a clean one (a partial run still reports what it did)"), out2;
  const seen = /* @__PURE__ */ new Map();
  for (const entry of probes) {
    const read = readProbeEntry(entry);
    if (typeof read == "string") {
      out2.push(read);
      continue;
    }
    seen.set(read.id, (seen.get(read.id) ?? 0) + read.calls);
  }
  return out2.push(...probeBudgetProblems(seen)), out2;
}
function readProbeEntry(entry) {
  const p = entry && typeof entry == "object" ? (
    /** @type {{ source?: unknown, calls?: unknown }} */
    entry
  ) : null, id = String(p && p.source || "").trim();
  if (!id) return "a `probes` entry has no `source`";
  if (!Object.prototype.hasOwnProperty.call(PROBE_BUDGETS, id))
    return `unrecognized probe source \`${id}\` — not one of the declared ids, so its budget is unknown`;
  const calls = probeCallCount(id, p ? p.calls : void 0);
  return typeof calls == "string" ? calls : { id, calls };
}
function probeCallCount(id, raw) {
  if (raw == null)
    return `probe source \`${id}\` declared no \`calls\` — an entry without a count cannot be audited, and a missing count is not zero`;
  const calls = Number(raw);
  return Number.isInteger(calls) ? calls < 0 ? `probe source \`${id}\` declared a negative call count ${calls} — a call cannot be un-made, and a negative must not offset a real one` : calls : `probe source \`${id}\` declared a non-integer call count \`${String(raw)}\` — invocations are counted in whole numbers`;
}
function probeBudgetProblems(seen) {
  const out2 = [];
  for (const [id, total] of seen) {
    const { max, what } = PROBE_BUDGETS[
      /** @type {keyof typeof PROBE_BUDGETS} */
      id
    ];
    max === 0 && total > 0 ? out2.push(`forbidden probe source \`${id}\` used ${total}×: ${what}`) : total > max && out2.push(`probe source \`${id}\` used ${total}×, budget ${max}: ${what}`);
  }
  return out2;
}
const PREFLIGHT_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["runner", "blockers", "missingTools", "ciCovers", "probes", "partial", "notes"],
  properties: {
    runner: { type: "string", description: 'prefix every build/lint command needs, e.g. "direnv exec . " or "nix develop -c " — empty string if commands run bare' },
    blockers: { type: "array", items: { type: "string" }, description: 'reasons this tree CANNOT compile here, one per line, e.g. "sqlx query macros need a live Postgres; no offline .sqlx cache and no DATABASE_URL"' },
    missingTools: { type: "array", items: { type: "string" }, description: "gate tools not on PATH (cargo-audit, cargo-deny, semgrep, …)" },
    ciCovers: { type: "array", items: { type: "string" }, description: 'signals a GREEN CI check already establishes for this exact HEAD, as "<signal> via <check name>" — e.g. "test via cargo nextest", "deny-bans via cargo-deny"' },
    // `minItems`/`minimum` are load-bearing, not decoration: without them `probes: []` and a negative
    // count were both VALID answers that the audit then read as clean — the cheapest possible path to
    // a green audit. The schema now refuses the shape and `auditPreflightProbes` refuses it again.
    probes: { type: "array", minItems: 1, description: "one entry per source consulted, with how many shell/API invocations it cost — audited against PROBE_BUDGETS; never empty, not even in a partial result, since it reports what was already done", items: { type: "object", additionalProperties: !1, required: ["source", "calls"], properties: { source: { type: "string", description: "the probe-source id from the prompt's list, exactly" }, calls: { type: "integer", minimum: 0, description: "invocations spent on that source, including ones that returned nothing" } } } },
    partial: { type: "boolean", description: "true if ANY of the four fields was left unfinished (ran out of time, a command failed, gh unavailable) — the matching field is then empty and notes says which and why" },
    notes: { type: "string" }
  }
};
function preflightPrompt(profile, ctx) {
  return `You are the PREFLIGHT for a ${profile.lang} review: resolve, cheaply and once, what the later steps must not rediscover. Diff base: ${ctx.baseRef ? `\`${flattenField(ctx.baseRef)}\`` : "uncommitted changes / most recent commit"}.

This is reconnaissance, NOT the gate. Run nothing that compiles, builds, or takes more than a few seconds. Every answer below comes from reading the working tree or asking the API.

1. RUNNER. Does this repo pin its toolchain and system libraries in a dev shell? Look for \`.envrc\`, \`flake.nix\`, \`shell.nix\`, \`.direnv/\`. If so and \`direnv\`/\`nix\` is on PATH, the prefix is \`direnv exec . \` (preferred when \`.envrc\` exists and is allowed) or \`nix develop -c \`. Verify it works with something instant — \`<prefix>rustc --version\` or \`<prefix>true\` — never with a build. Outside such a shell, system libraries (openssl, protobuf, pkg-config) are absent and any build dies in a C dependency unrelated to the diff. Empty string only if the repo genuinely needs no prefix.

2. BLOCKERS — things that make a local build impossible no matter how long it runs, so nobody downstream wastes minutes proving it:
${profile.id === "rust" ? "   - compile-time-checked SQL: `sqlx` in `Cargo.lock` with NO offline cache (no `.sqlx/` at the repo root or in the changed package) and no `DATABASE_URL` — every query macro tries to reach a live database and the crate fails to compile.\n   - a build script or macro that needs a generated file, a private registry token (`CARGO_REGISTRIES_*`), or a service that is not running.\n   - a toolchain the repo pins (`rust-toolchain.toml`) that is not installed and cannot be fetched offline." : "   - an input the flake cannot fetch offline, a private registry/token the evaluation needs, or a builder platform this machine is not (`system` mismatch)."}
   Do this MECHANICALLY, not by judgement — these are \`grep\`/\`test\` questions with yes-or-no answers, and the one time this was left to inference the blocker was missed and the gate paid for a doomed compile anyway:
${profile.id === "rust" ? '   ```\n   grep -q \'^name = "sqlx"\' Cargo.lock && echo SQLX\n   ls -d .sqlx */.sqlx **/.sqlx 2>/dev/null            # offline cache anywhere in the tree\n   [ -n "$DATABASE_URL" ] && echo HAS_DB_URL\n   ```\n   SQLX present, no `.sqlx` directory found and no `DATABASE_URL` ⇒ report the blocker. Run those three commands; do not reason about whether the crate "probably" builds.' : "   Check the concrete inputs: `nix flake metadata` resolving offline, and whether the flake's `system` matches this machine."}
   Report each blocker as one plain line naming what cannot run and WHY. Report nothing you have not actually checked.

3. MISSING TOOLS. Which of ${profile.id === "rust" ? "`cargo-audit`, `cargo-deny`, `cargo-semver-checks`, `semgrep`" : "`statix`, `deadnix`, `nixpkgs-fmt`/`alejandra`, `nix-instantiate`"} are genuinely unavailable? ONE command answers it for every tool at once — run it exactly, do not probe tool-by-tool:
   \`\`\`
   for t in ${profile.id === "rust" ? "cargo-audit cargo-deny cargo-semver-checks semgrep" : "statix deadnix nixpkgs-fmt alejandra nix-instantiate"}; do
     p=$(command -v "$t" 2>/dev/null); [ -z "$p" ] && [ -x "$HOME/.cargo/bin/$t" ] && p="$HOME/.cargo/bin/$t"
     echo "$t: \${p:-MISSING}"
   done
   \`\`\`
   A dev shell usually has a NARROWER PATH than the login shell, so if the runner prefix from step 1 is non-empty, run the same loop once more under it and treat a tool as PRESENT if EITHER pass found it — that mistake silently dropped the entire \`cargo audit\` signal from a real run. Name the invocation that works (e.g. "cargo-audit: ~/.cargo/bin/cargo-audit, outside the dev shell"). Only a tool MISSING in both passes goes in \`missingTools\` — an absent tool is an intentional skip downstream, never a failure.

4. CI COVERAGE. Which signals does a GREEN check already establish for THIS EXACT commit? TWO calls answer it, both SHA-scoped — the check-runs endpoint and the commit-status endpoint. Run those two, once each, and NOTHING else — in particular do NOT run \`gh pr checks\` and do NOT look the PR up by commit: those resolve by branch (empty on a review worktree or detached HEAD) or hand you a PR whose head may have moved past your commit, and both then need the SHA test this call satisfies by construction.
   \`\`\`
   SHA=$(git rev-parse HEAD)
   gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" --jq '.check_runs[] | "\\(.name) \\(.status) \\(.conclusion)"'
   gh api "repos/{owner}/{repo}/commits/$SHA/status" --jq '.statuses[] | "\\(.context) completed \\(.state)"'
   \`\`\`
   Owner/repo from \`git remote get-url origin\`. Both calls, once each: check-runs alone misses CI that reports through the older commit-status API, and that omission looks exactly like "no CI". Keep only \`completed\` rows whose conclusion/state is \`success\`.
   Then read the workflow behind a green check to learn what it ACTUALLY runs, not what its name suggests: a job called \`cargo-deny\` running \`check bans\` covers bans and NOT advisories or licenses, and that distinction is the whole value of this step. HARD CAP — this is where the pass runs away with the clock: read AT MOST 2 workflow files, only for green checks that map to a gate signal (build/test/clippy/fmt or a security tool). Never enumerate \`.github/workflows/*\` wholesale. Past the cap, the remaining green checks go in \`notes\` BY NAME ONLY and NEVER in \`ciCovers\` — \`ciCovers\` means "do not re-run this locally", and a check whose workflow you did not open cannot support that: its name is a guess at what it ran, which is exactly what the \`cargo-deny\`/\`check bans\` example above shows going wrong. Only a signal you read the workflow for goes in \`ciCovers\`.
   List one entry per covered signal, e.g. "test via cargo nextest", "deny-bans via cargo-deny (command: check bans)". If gh is missing, unauthenticated or offline, return an empty list and say so in notes.

${probeDeclarationBlock()}

BUDGET (hard): reconnaissance, target ~90 seconds, three minutes is the ceiling. Past the dispatch deadline nothing cuts you off — the caller simply STOPS WAITING for you and dispatches a second preflight, so everything you do after that point is discarded and paid for twice, and if the second pass is as slow the gate loses even the runner prefix. So at three minutes STOP and RETURN. A thorough preflight costing more than the steps it saves is a net loss (measured: the first version took 207s and made the gate+preflight pair SLOWER than the gate had been alone). Never run a build, a test, or a full lint here.

PARTIAL RESULTS ARE THE EXPECTED SHAPE, NOT A FAILURE — but they must be legible as partial. Any of the four FINDINGS fields above (runner, blockers, missingTools, ciCovers) you did not finish: set \`partial: true\`, return the field EMPTY, and open \`notes\` with \`PARTIAL: <field> not established (<why>)\`, one clause per unfinished field. \`partial\` is the flag downstream reads — the note explains it, it does not replace it. An empty \`ciCovers\` with no such note means "CI covers nothing", and a downstream step will re-establish every signal locally on that reading — so never let "I ran out of time" arrive looking like "I checked and there was nothing".
\`probes\` (step 5) IS EXPLICITLY EXCLUDED FROM THAT INSTRUCTION: it is not a finding but a report of what you ALREADY DID, so it can never be returned empty — a run cut short declares the calls it had already spent, and an empty \`probes\` is read as a violation, never as a disciplined pass.

Return runner, blockers, missingTools, ciCovers, probes, partial, notes.`;
}
function preflightIsPartial(pf) {
  return pf ? pf.partial === !0 ? !0 : /\bPARTIAL:/.test(flattenField(pf.notes || "")) : !1;
}
function preflightBrief(pf) {
  if (!pf) return `PREFLIGHT UNAVAILABLE — the preflight step failed or passed its deadline and returned nothing. Nothing below is resolved for you: no command prefix, no compile blockers, no tool inventory, no CI coverage. Establish what you need yourself, CHEAPLY (read the tree; never run a build to read its error), and say "preflight unavailable" in your provenance so the record shows this run was short one step.
`;
  const lines = [
    "PREFLIGHT (already resolved — do NOT rediscover any of this):",
    `- Command prefix for every build/lint/test command: ${pf.runner ? `\`${flattenField(pf.runner)}\`` : "(none needed — commands run bare)"}. Commands run without it die in missing system libraries, not in your diff.`
  ];
  return pf.blockers?.length && lines.push(`- CANNOT BUILD HERE: ${pf.blockers.map(flattenField).join(" · ")}. Any step that needs a compile is UNRUNNABLE — skip it and say so; do NOT run it to watch it fail.`), pf.missingTools?.length && lines.push(`- Not installed (probed both bare and inside the dev shell): ${pf.missingTools.map(flattenField).join(", ")} — an absent tool is an intentional skip, never a failure. If you can nonetheless invoke one (a full path, \`nix run nixpkgs#<tool> --\`), do, and say so in provenance.`), lines.push(pf.ciCovers?.length ? `- Already GREEN in CI for this exact commit: ${pf.ciCovers.map(flattenField).join(" · ")}. Do NOT re-run these locally — CI ran the project's real command on a clean machine. Cite the check in provenance instead.` : "- CI covers nothing for this commit (or could not be consulted) — every signal must be established locally or reported unknown."), pf.notes && lines.push(`- Preflight notes: ${flattenField(pf.notes)}`), lines.join(`
`) + `
`;
}
function rustDepContext(_ctx) {
  return '8. **Dependency context** — review against the crate versions the project ACTUALLY pins, not against crates-in-the-abstract. Resolve them: `cargo metadata --format-version 1` (or read `Cargo.lock`) and match the external crates the changed files `use` to their locked versions. For any nontrivial dependency the diff touches, check whether the usage is correct *for that pinned version* — a since-deprecated/removed/renamed API, a changed default, a known footgun of that exact version. Consult context7 for the crate\'s version-specific docs instead of trusting memory. Turn a genuine version-specific misuse into a seed finding (source "dep-context", severity Medium, ruleId "DEP-001"). Known-vulnerable versions are already covered by `cargo audit` (ruleId "DEP-002") — do not duplicate. Best-effort: skip silently if `cargo metadata` fails or the diff touches no external crate.';
}
function rustGate(ctx) {
  return `You are establishing the mechanical gate for a Rust review, CI-aware, and collecting tool-grounded seed findings. Diff base: ${ctx.baseRef ? `\`${flattenField(ctx.baseRef)}\`` : "uncommitted changes / most recent commit"}.

${preflightBrief(ctx.preflight)}
GATE (CI-aware, per the rust-review skill — load it):
0. USE THE PREFLIGHT ABOVE. Its command prefix goes on every cargo invocation; its blockers make the matching steps unrunnable (skip them and record WHY in provenance — "pedantic seeds unavailable: sqlx macros need Postgres"); its ciCovers list is the set of signals you must NOT re-establish locally. It was resolved by a separate step precisely so this one does not pay to rediscover it. If it is absent or empty, fall back to establishing these yourself — but cheaply, by reading the tree, never by running a build to read its error.
1. Detect a PR + CI — if preflight returned a non-empty ciCovers, that list is the VERIFIED SUBSET of the detection, not the whole of it: preflight reads at most two workflow files, so a green check past that cap is named in its \`notes\` BY NAME ONLY and is absent from ciCovers. So: never re-run the gh detection for a signal already in ciCovers (~90s for an answer you were handed), and for a check named in \`notes\` but NOT in ciCovers, either open that one workflow yourself to learn what it actually runs — and only then treat it as coverage — or establish the signal locally. A bare check name is never coverage; \`test-and-lint\` may run neither. If ciCovers is non-empty and \`notes\` names no further green checks, the detection is complete and you skip the gh calls entirely. \`gh pr checks --json name,state,bucket,link\` resolves the PR from the CURRENT BRANCH NAME, which fails whenever you are not sitting on the PR's own head branch — a review worktree (\`pr-1203-review\`), a detached HEAD, or a local rename all look like "no PR" even though CI ran and is green. That is a false negative that costs the whole CI shortcut, so when the branch lookup comes up empty, LOOK UP THE PR BY COMMIT before giving up:
   \`\`\`
   SHA=$(git rev-parse HEAD)
   gh api "repos/{owner}/{repo}/commits/$SHA/pulls" --jq '.[].number'   # PRs whose head is this commit
   gh pr checks <number> --json name,state,bucket,link
   \`\`\`
   Derive owner/repo from \`git remote get-url origin\`. Also accept a PR found this way when its head SHA equals your HEAD — say so in provenance (\`via CI · PR #N · matched by SHA\`). Only if BOTH the branch and the commit lookup find nothing, or gh is missing/unauthenticated/offline, fall through to the local gate. Match generously: a check named \`cargo nextest\`, \`unit-tests\`, \`ci / test (stable)\` etc. all cover the TEST signal; \`just clippy\`, \`lint\`, \`clippy (stable)\` cover CLIPPY. A green check is the BEST evidence available — it ran on a clean machine with a warm cache and the project's real configuration. Prefer it over anything you could run here.

1b. NEVER stand up infrastructure to satisfy this gate. If a check needs a database, a container, a broker, a network service or a fixture server, that check is CI's — do not start Postgres, run \`docker\`/\`docker compose\`, apply migrations, or seed anything. Record that signal as unknown with the reason ("integration tests need Postgres; not run locally — CI owns this"). You are establishing whether a DIFF is reviewable, not reproducing the build farm. A review that never starts is worth far less than one with an unestablished test signal.
2. For build/test/clippy/fmt: if a conclusive GREEN check covers it, treat it as PASSED and record provenance "via CI #<n>". Do NOT require the check to be marked \`required\` — most repos have no branch protection at all (\`isRequired\` is then null for every check, and \`gh api …/branches/<b>/protection\` 404s), so demanding it would make this whole shortcut dead code and send you into a local build you did not need. Required-ness decides whether RED blocks a merge upstream; it says nothing about whether GREEN is trustworthy evidence — a passing job ran the project's real command on a clean machine. If a check covering fmt/clippy/test/build FAILED, set status=fail and list it in failedChecks (note whether it was required). A red check unrelated to those four is worth a line in notes, not a gate failure. Only when the signal is genuinely pending or absent, run it locally under the TIME BUDGET below.
   TAKE THE PROJECT'S LINT SEMANTICS, USE YOUR OWN SCOPE AND FORMAT. First READ the project's lint recipe — a \`clippy\`/\`lint\` target in \`justfile\`/\`Makefile\`/\`Taskfile\`, an \`[alias]\` in \`.cargo/config.toml\`, or the step its CI workflow runs (\`.github/workflows/*.yml\`) — and lift its SEMANTIC flags: the feature selection (\`--all-features\`, \`--features …\`, \`--no-default-features\`) and every \`-A\`/\`-W\`/\`-D\` lint level it sets. Those decide verdicts: a project that allows \`clippy::too_many_arguments\` will otherwise get gate failures on lints it deliberately permits, and linting the wrong feature set lints code that never ships.
   Then run it SCOPED and SHORT, which change only how much is built and how it prints, never what a lint says about a given crate:
   \`cargo clippy -p <each changed package> --all-targets --message-format=short <their feature flags> -- <their -A/-W flags> -D warnings\`
   Resolve the changed packages from the diff paths via \`cargo metadata --no-deps --format-version 1\`. Fall back to the whole workspace only when the diff genuinely spans it.
   Note the trade-off in notes: a scoped run cannot see a break this change causes in a DEPENDENT crate elsewhere in the workspace. That is CI's job — and if CI covered clippy you should not be running this at all (step 2 above). When you scope, say so, and name the packages.
   If the project defines no recipe, use \`cargo fmt --check\` and \`cargo clippy -p <changed> --all-targets --message-format=short -- -D warnings\`.
   TESTS: run them locally ONLY if CI did not cover them AND they need no infrastructure (per 1b) — and then scoped, \`cargo test -p <changed package>\`, never the whole workspace. If the changed package's tests need a service, or a bare \`cargo test\` starts pulling one up, stop and record the test signal as unknown. Do not chase a green suite; that is not what this gate is for.
3. Security tools (\`cargo audit\`, \`cargo deny\`) — usually absent from CI, so usually yours to run, but they get the SAME two rules as everything else:
   - CI COVERAGE. If preflight lists one as already green for this commit, do not re-run it. Note the sub-command: a CI job running \`cargo deny check bans\` covers bans ONLY — advisories and licenses remain yours.
   - THE PROJECT'S SCOPE, NOT THE TOOL'S DEFAULTS. Run the sub-checks the project actually configures. \`cargo deny check\` with no arguments runs advisories/bans/licenses/sources, and the unconfigured ones fall back to cargo-deny's defaults — so a \`deny.toml\` containing only \`[bans]\` will "fail" licenses and advisories on a policy the project never wrote. That is a property of the tool, not a defect in the diff. Read \`deny.toml\` (and the CI invocation) and run exactly the configured sub-checks; if a sub-check has no configuration, skip it and say so in notes rather than reporting a default-policy failure.
   - ATTRIBUTION decides which list it lands in, and only failedChecks stops the review. Check \`git diff --name-only\` against the base for \`Cargo.toml\`/\`Cargo.lock\`:
     · the diff DOES touch a dependency manifest → a vulnerability with a published fix is this change's problem: failedChecks, status=fail.
     · the diff does NOT touch one → the advisory predates this change and no edit to these files can clear it. Put it in **carriedChecks**, prefixed "PRE-EXISTING: ", and do NOT let it set status=fail. It is still reported in full — carriedChecks is printed on every verdict, not just red ones — but a gate exists to answer "is THIS DIFF reviewable", and blocking every diff in a repository on a dependency backlog it did not create means no review in that repository ever runs.
   The same attribution applies to a red \`cargo deny\` sub-check: caused by this diff → failedChecks; pre-existing → carriedChecks.
4. status = fail if any of fmt/clippy/test/build is red (CI or local), or a security check red is attributable to this diff per 3; pass if all green; unknown if you could not establish it. Anything in carriedChecks NEVER moves status — that is the whole distinction.

SEED FINDINGS (tool grounding — beyond the gate, scoped to the changed crates):
5. Pedantic seeds (a SEPARATE, optional pass — never a substitute for the gate in step 2; SKIP OUTRIGHT if preflight 0b found a compile blocker), on the SAME changed packages and the SAME feature flags you resolved there, so the two passes see the same code: \`cargo clippy -p <pkg> --all-targets --message-format=short <their feature flags> -- -W clippy::pedantic -W clippy::nursery\`. Only fall back to the whole workspace when the diff genuinely spans it. Keep the last ~200 diagnostic lines; if you truncate, SAY how many you dropped in notes — a silent cut reads as "there were only N". Turn each NEW pedantic/nursery diagnostic on changed lines into a seed finding (severity Low/Medium, source "clippy-pedantic"). Do not fail the gate on these. This step is optional: if it exceeds the budget, skip it and note that the pedantic seeds are absent.
${ctx.isLibrary ? '6. This is a library: run `cargo semver-checks check-release` if installed; each reported break is a seed finding (severity High, source "semver-checks"). If not installed, log and skip.' : "6. Not a library — skip semver-checks."}

7. SAST seed (semgrep) — decide what configs apply, then run only if any do:
   - If a \`./semgrep/\` rules dir exists in the repo, ALWAYS include \`--config=./semgrep/\` (repo-specific banned-API/taint rules — the whole point of keeping them in-repo).
${ctx.securitySensitive ? "   - This diff IS security-sensitive: also include `--config=p/rust --config=p/secrets`." : "   - This diff is NOT security-sensitive: do not pull the generic rulesets; rely on `./semgrep/` only (skip step 7 entirely if that dir is absent)."}
   If at least one config applies and \`semgrep\` is installed, scope it to the changed Rust files (\`git diff --name-only ${ctx.baseRef ? `--merge-base ${shq(ctx.baseRef)}` : "HEAD"} -- '*.rs'\`) and run \`semgrep --error <configs> <files>\`. Turn each result into a seed finding (source "semgrep"; map semgrep ERROR→High, WARNING→Medium, INFO→Low). These are SEEDS, never gate failures — semgrep taint/secrets over-reports, and downstream verification refutes the false positives. If semgrep is absent or no config applies, log and skip.

${rustDepContext(ctx)}

${GATE_TIME_BUDGET}
EVIDENCE RULE: report a check as pass/fail ONLY if you ran it yourself (quote the command and its exit status / decisive output line in notes) or saw it conclusively green/red in CI (cite the check name). Never infer a pass. If the changed files are not part of a cargo project, do NOT fabricate a temporary crate/harness around them to lint or build — record build/clippy/test as not establishable (status=unknown) and say why in notes.

Set provenance to a one-line summary like "clippy/test via CI #123; fmt/audit/deny local". Put gate failures in failedChecks (NOT seedFindings). Seed findings come from clippy-pedantic / semver / semgrep / dep-context only. On every seed finding set \`ruleId\` to the matching rust-review rules.md catalog ID (e.g. "DEP-001") or "" if none fits.`;
}
function nixDepContext(_ctx) {
  return '6. **Dependency context** — review against the flake inputs the project ACTUALLY pins. Resolve them from `flake.lock` (the locked `rev`/`narHash` per input). Flag inputs that are unpinned, channel-based (`<nixpkgs>`), or floating where they should be locked, and `inputs.*.follows` that should dedupe nixpkgs but don\'t (source "dep-context", severity Medium, ruleId "DEP-001"). Best-effort: skip silently if there is no flake.';
}
function nixGate(ctx) {
  return `You are establishing the mechanical gate for a Nix review and collecting tool-grounded seed findings. Diff base: ${ctx.baseRef ? `\`${flattenField(ctx.baseRef)}\`` : "uncommitted changes / most recent commit"}.

${preflightBrief(ctx.preflight)}
GATE (per the nix-review skill — load it):
0. USE THE PREFLIGHT ABOVE rather than rediscovering it: its command prefix, its blockers (a step that cannot evaluate here is skipped and reported, never run to watch it fail), its missing tools, and its ciCovers — signals already green in CI for this exact commit are cited, not re-run.
1. If a \`flake.nix\` exists: \`nix flake check\` — a failure is a gate failure (list it in failedChecks), not a seed.
2. Formatter: run \`alejandra --check .\` or \`nixpkgs-fmt --check\` (whichever the repo uses — check for a formatter in the flake / a treefmt config). Mismatches are seeds (source "fmt", Low), never a gate failure unless CI enforces fmt.
3. \`nix eval\`/\`nix build\` the attrs the diff touches — an eval or build error on changed code is a gate failure.
4. status = fail if \`nix flake check\` or an eval/build of touched attrs is red; pass if green; unknown if you could not establish it (e.g. nix not installed).

SEED FINDINGS (tool grounding — scoped to the changed files):
5. Linters — \`statix check\` (anti-idioms) and \`deadnix\` (dead bindings) on the changed \`.nix\` files. Turn each diagnostic on changed lines into a seed finding (source "statix"/"deadnix", severity Low/Medium, ruleId "MNT-001"). Do not fail the gate on these. If a linter is absent, log and skip.

${nixDepContext(ctx)}

${GATE_TIME_BUDGET}
EVIDENCE RULE: report a check as pass/fail ONLY if you ran it yourself (quote the command and its exit status / decisive output line in notes) or saw it conclusively green/red in CI. Never infer a pass; a tool you could not run is "skipped" in notes, never a pass.

Set provenance to a one-line summary like "nix flake check pass; statix/deadnix local". Put gate failures in failedChecks (NOT seedFindings). Seed findings come from statix / deadnix / fmt / dep-context only. On every seed finding set \`ruleId\` to the matching nix-review rules.md catalog ID (e.g. "MNT-001") or "" if none fits.`;
}
const CONDITIONAL_LENSES = ["failure-windows"], SURFACE_GATED_LENSES = { "negative-space": "crossBoundarySymbol", compat: "wireForm", invariants: "invariantType" }, NON_CONTRACT_DIRS = /* @__PURE__ */ new Set(["test", "tests", "__tests__", "testdata", "fixtures", "__fixtures__", "__snapshots__"]), PROSE_EXT = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
function isChartDir(d) {
  return /^(charts?|helm)$/i.test(d);
}
const CONTRACT_PATH_CLASSES = [
  { name: "contracts-crate", test: (p) => p.dirs.some((s, i) => s === "crates" && /^(contracts|.*-contracts)$/.test(p.dirs[i + 1] ?? "")) },
  { name: "crd-dir", test: (p) => p.dirs.includes("crds") },
  { name: "crd-manifest", test: (p) => /\.(ya?ml|json)$/i.test(p.base) && p.base.split(/[._-]/).some((t) => /^(crds?|customresourcedefinitions?)$/i.test(t)) },
  { name: "helm-chart", test: (p) => /^Chart\.ya?ml$/.test(p.base) },
  { name: "helm-values", test: (p) => /^values([._-].*)?\.ya?ml$/i.test(p.base) && (p.dirs.length === 0 || p.dirs.some(isChartDir)) },
  { name: "helm-template", test: (p) => /\.(ya?ml|tpl)$/i.test(p.base) && p.dirs.some((s, i) => s === "templates" && p.dirs.slice(0, i).some(isChartDir)) },
  { name: "openapi", test: (p) => /(openapi|swagger)/i.test(p.base) && /\.(ya?ml|json)$/i.test(p.base) },
  { name: "proto", test: (p) => /\.proto$/i.test(p.base) },
  { name: "graphql", test: (p) => /\.(graphqls?|gql)$/i.test(p.base) },
  { name: "avro", test: (p) => /\.(avsc|avdl|avpr)$/i.test(p.base) },
  { name: "json-schema", test: (p) => /(^|\.)schema\.json$/i.test(p.base) || /\.jsonschema$/i.test(p.base) },
  { name: "db-migration", test: (p) => p.dirs.some((s) => /^(migrations?|migrate|alembic)$/i.test(s)) },
  { name: "plugin-manifest", test: (p) => p.dirs[p.dirs.length - 1] === ".claude-plugin" && /\.json$/i.test(p.base) }
];
function contractPathClass(f) {
  const segs = pathSegments(f || ""), base = segs[segs.length - 1] ?? "", dirs = segs.slice(0, -1);
  return !base || PROSE_EXT.test(base) || dirs.some((s) => NON_CONTRACT_DIRS.has(s.toLowerCase())) ? "" : CONTRACT_PATH_CLASSES.find((c) => c.test({ dirs, base }))?.name ?? "";
}
function isContractOrSchemaPath(f) {
  return contractPathClass(f) !== "";
}
const OPTIONAL_LENSES = ["performance", "api-idioms", "api-boundary"], OPTIONAL_NONE = [void 0, null, "", !1, "false", "none"], OPTIONAL_ALL = [!0, "true", "all"];
function parseOptionalRequest(raw) {
  if (OPTIONAL_NONE.includes(raw)) return { lenses: [], unknown: [] };
  if (OPTIONAL_ALL.includes(raw)) return { lenses: [...OPTIONAL_LENSES], unknown: [] };
  const names = (Array.isArray(raw) ? (
    /** @type {unknown[]} */
    raw
  ) : String(raw).split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
  return { lenses: names.filter((n) => OPTIONAL_LENSES.includes(n)), unknown: names.filter((n) => !OPTIONAL_LENSES.includes(n)) };
}
const optionalRequest = parseOptionalRequest(A.optional);
function warnUnknownOptional() {
  optionalRequest.unknown.length && log(`⚠️ optional=${JSON.stringify(A.optional)} names ${optionalRequest.unknown.join(", ")}, which is not an optional lens — the optional roster is ${OPTIONAL_LENSES.join(", ")}. Only the recognised names were admitted.`);
}
warnUnknownOptional();
const optionalRequested = optionalRequest.lenses, optionalDispatched = /* @__PURE__ */ new Set(), optionalNamedByCritic = /* @__PURE__ */ new Set(), optionalTally = () => optionalTallyFrom(results, optionalDispatched, optionalRequested), optionalSection = () => {
  const skipped = optionalTally().skipped;
  if (!skipped.length) return "";
  const named = skipped.filter((l) => optionalNamedByCritic.has(l));
  if (failedProfiles(results).length) {
    const unrequested = skipped.filter((l) => !optionalRequested.includes(l)), criticLine2 = named.length ? `
⚠️ The completeness critic named ${named.join(", ")} as an uncovered surface for THIS diff. It was not dispatched; once the gate is green, weigh including it in that re-run.
` : "";
    return `

## Not looked at — the optional pass did not run
⚠️ These lenses were NOT dispatched, so this review makes NO statement about what they cover: ${skipped.join(", ")}. That is an absence of a result, not a clean one. The mechanical gate is red, which blocks this review by itself — fix the gate first.${unrequested.length ? ` ${unrequested.join(", ")} ${unrequested.length === 1 ? "is" : "are"} off by default; add \`optional=${unrequested.join(",")}\` to the re-run only if you want ${unrequested.length === 1 ? "it" : "them"}.` : ""}
` + criticLine2;
  }
  const criticLine = named.length ? `
⚠️ The completeness critic named ${named.join(", ")} as an uncovered surface for THIS diff. It was still not dispatched — the optional pass is bought by an explicit request, not by a model mid-run — so buy it deliberately with \`optional=${named.join(",")}\`.
` : "";
  return `

## Not looked at — the optional pass did not run
⚠️ These lenses were NOT dispatched, so this review makes NO statement about what they cover: ${skipped.join(", ")}. That is an absence of a result, not a clean one. They are off by default because they returned no High findings on the run that was measured — one diff of one repository, so the basis is a single point, not a settled law; to buy them, re-run with \`optional=true\` (or \`optional=${skipped.join(",")}\`).
` + criticLine;
}, results = [];
function failedProfiles(results2) {
  return results2.filter((r) => r.gateStatus === "fail");
}
function mergeGateStatus(results2) {
  return failedProfiles(results2).length ? "fail" : results2.every((r) => r.gateStatus === "pass") ? "pass" : "unknown";
}
function profilesRanLenses(results2) {
  return results2.some((r) => (r.ranLenses || []).length > 0 || (r.lensRounds || []).some((x) => x.returned > 0));
}
function gateRecord(results2) {
  return {
    status: mergeGateStatus(results2),
    provenance: results2.map((r) => `[${r.profile.id}] ${r.gateProvenance}`).join(" · "),
    carriedChecks: results2.flatMap((r) => (r.carriedChecks || []).map((c) => `[${r.profile.id}] ${c}`))
  };
}
function passedProfiles(results2) {
  return results2.filter((r) => r.gateStatus !== "fail");
}
function savedSurfaceDrops(results2, dispatched) {
  const ran = new Set(dispatched);
  return [...new Set(passedProfiles(results2).flatMap((r) => r.surfaceDropped || []))].filter((l) => !ran.has(l)).sort();
}
function surfaceGateRecord(results2, { dispatched, namedByCritic }) {
  const dropped2 = savedSurfaceDrops(results2, dispatched), named = new Set(namedByCritic);
  return {
    dropped: dropped2,
    dispatched: [...dispatched].sort(),
    namedByCritic: dropped2.filter((l) => named.has(l)),
    lensesRan: profilesRanLenses(results2)
  };
}
function optionalTallyFrom(results2, dispatched, requested = []) {
  const ran = new Set(dispatched), asked = new Set(requested), passed = new Set(passedProfiles(results2)), inScope = [...new Set(results2.flatMap((r) => (r.optionalScope || []).filter((l) => passed.has(r) || asked.has(l))))];
  return { ran: inScope.filter((l) => ran.has(l)), skipped: inScope.filter((l) => !ran.has(l)) };
}
const surfaceGateDispatched = /* @__PURE__ */ new Set(), surfaceGateNamedByCritic = /* @__PURE__ */ new Set(), surfaceGateTally = () => ({ dropped: savedSurfaceDrops(results, surfaceGateDispatched) }), surfaceGateSection = () => {
  const dropped2 = surfaceGateTally().dropped;
  if (!dropped2.length) return "";
  const named = dropped2.filter((l) => surfaceGateNamedByCritic.has(l));
  return `

## Not run — the diff does not touch the surface these lenses need
⚠️ These whole-repo lenses were NOT dispatched, so this review makes NO statement about what they cover: ${dropped2.join(", ")}. Each fires only when the diff touches the surface its defect class needs (a cross-boundary symbol, a wire/serialized form, an invariant-bearing type), and this diff does not. That is an absence of a result, not a clean one.
` + (named.length ? `
⚠️ The completeness critic named ${named.join(", ")} as an uncovered surface for THIS diff. It was still NOT dispatched — the surface gate is the deliberate boundary, not something a model re-opens mid-run — so treat this as a visible gap, not a clean pass.
` : "");
}, PROFILES = {};
PROFILES.rust = {
  id: "rust",
  lang: "Rust",
  detect: (files) => files.some((f) => /\.rs$/.test(f) || /(^|\/)Cargo\.toml$/.test(f)),
  diffGlobs: ["'*.rs'"],
  rubricSkill: "rust-review",
  fpRules: "fp-rules.md",
  // exclusion catalog (FP-*/KEEP-*); '' for a profile that ships none
  // Rules whose per-occurrence reporting buries the review — capped mechanically by rollupPool.
  // Only completeness nits belong here: never a rule whose individual instances carry distinct risk.
  rollupRuleIds: ["API-001", "API-003", "API-004", "API-005"],
  navSkill: "rust-navigation",
  reviewerAgent: "craft:rust-reviewer",
  securityHints: "auth, crypto, input parsing, unsafe, FFI, or dependencies",
  usesLibrary: !0,
  alwaysLenses: ["intent"],
  safetyLens: "safety",
  scoutRules: "Decide what is \"in play\" from the diff: unsafe → safety; async/threads → concurrency; SQL/untrusted input → safety; loops/collections → performance; changed `pub` surface → api-idioms; a changed HTTP-framework handler / route, an error enum or its IntoResponse (error→HTTP-status) mapping, an OpenAPI/response-annotation, or a repository error-mapping the handlers surface → api-boundary (web-service diffs only — pick it when the diff touches the api/handler layer or the error-to-status plumbing); new/changed tests → tests; new branching / growing files / large refactor → maintainability; a changed operation on a domain entity that carries a status/lifecycle field, soft-delete, scoped foreign keys, or a documented derived/effective quantity → invariants (pick it for any medium-or-larger diff touching the domain/application/infrastructure layers); a changed reconcile loop / controller / operator (a reconcile or requeue fn, a status or condition update, a create-or-patch of a child/external resource, a finalizer or delete path), a changed typed watch / secondary-watch setup (a `watcher`/`Controller::watches`/`secondary_watches`/object-mapper), or a changed admission / validating-webhook handler → reconciler (pick it whenever the diff touches a controller/reconcile loop, a retry / idempotent-apply flow, a Kubernetes typed watch, or an admission webhook — this lens reads the Helm chart's webhook `failurePolicy` and CRD schemas, not just the Rust); a changed serde attribute / renamed-or-retagged field or enum variant / added non-defaulted field on a type that is persisted (JSONB, blob, cache, event log, message payload) or sent over the wire, a migration renaming/retyping a column the code (de)serializes, a changed CLI flag / subcommand / exit code / output format, a changed config key / env var read / default value, a changed Helm chart value or template, a changed CRD schema or API version list, a changed proto/OpenAPI definition, or a renamed or removed exported/public name other code references → compat (pick it whenever the diff changes a contract that a party running another version reads, calls or deploys against — stored or wire data, the CLI/config/chart surface, an API/schema version, an exported name). ('intent' is enforced by the engine and added automatically — do not count it toward your choices.) `performance`, `api-idioms` and `api-boundary` are the OPTIONAL pass: pick them on the same signals as ever, but the engine admits them only on a run that explicitly asked for the optional pass and drops them otherwise — so do not treat their absence from a run as a judgement about the code they cover.",
  gate: rustGate,
  depContext: rustDepContext,
  lenses: ["safety", "errors", "concurrency", "performance", "api-idioms", "api-boundary", "reconciler", "failure-windows", "compat", "maintainability", "tests", "intent", "invariants"],
  lensBrief: {
    safety: 'safety / injection / secrets: unwrap/expect/panic on reachable paths, unsafe without SAFETY, SQL/command injection, path traversal, hardcoded secrets, unbounded deserialization. Also BUILD-PROFILE DIVERGENCE (SAF-007/SAF-008), where the code you review is not the code that ships: (a) arithmetic on an untrusted-input path whose outcome differs between the dev/test profile (`overflow-checks` ON) and the shipping release profile (OFF by default — read `[profile.release]` in the crate AND workspace root before assuming, it may be re-enabled). The profile-gated panic is the FLOOR of the impact, not the ceiling: do NOT close it as "does not reproduce in release" — say what the release build does INSTEAD (a silent wrap that truncates a length, misresolves an index, or corrupts state is worse than the panic, because nothing reports it), and report both facets. (b) a `debug_assert!` carrying a load-bearing invariant — an unsafe precondition, a bounds/length check, a trust-boundary validation — which compiles out in `--release`, leaving the shipped binary unguarded.',
    errors: "error handling: recoverable failures handled with panic/unwrap, dropped #[must_use]/error values, Result-vs-panic, typed-error-vs-anyhow at API boundaries.",
    concurrency: "concurrency / async: blocking calls inside async, lock held across .await, unbounded channels, inconsistent lock order (deadlock), missing Send/Sync.",
    performance: "performance: allocation in hot loops, to_string/to_owned where a borrow works, Vec::new+push where size is known, N+1 / repeated work in loops.",
    "api-idioms": "API shape & public-surface idioms — spend the budget on impactful breaks, not per-item completeness nits. HIGH-VALUE (surface individually): public-API guideline breaks (API-006) — an unsealed trait meant to be closed, a private/unstable type or dependency leaked through a `pub` signature, an owned String/Vec/PathBuf parameter where &str/&[T]/&Path fits, a public enum/error without #[non_exhaustive], missing common-trait impls (Debug/Clone); a wildcard `_ =>` on a business enum that silently swallows new variants (API-002); a library leaking Box<dyn Error>/anyhow at its boundary (ERR-003). LOW-VALUE (do NOT file one finding per occurrence): missing `///` on a pub item (API-003), #[allow] without a justifying comment (API-004), crate-root #![deny(warnings)] (API-005), oversized fn / deep nesting (API-001) — roll repeated instances of each into ONE finding that names the pattern with a representative file:line, and raise an individual one only when it sits on a genuinely public library API, the doc is wrong or misleading (not merely absent), or the #[allow] hides a real defect.",
    "api-boundary": "API boundary correctness for web services: trace every error the changed service/repository can produce to the HTTP status the handler actually returns. A domain Conflict / AlreadyExists / unique-violation / not-found (an empty fetch_one / zero-row / RowNotFound) that collapses into a generic 500 — because a broad `#[from]` on the error enum folds it into a catch-all variant, or a blanket DbError→500 in IntoResponse swallows it — instead of surfacing 409/400/404 is a finding. Method: walk the error enum `#[from]`/`From` chains and the IntoResponse/handler match arms; where the service intends a distinct typed status (a Conflict variant meaning 409, a validation error meaning 400, a not-found meaning 404) confirm a matching arm actually maps it, and flag any typed 4xx that has no variant to land in or that a `#[from]` merges into a generic error before the boundary sees it. Also OpenAPI/utoipa completeness: does the handler annotation (e.g. #[utoipa::path] responses(...)) list EVERY status the handler can actually return — cross-check the statuses the code produces (especially 404/409/400) against the documented response set, and flag any the code returns but the responses(...) omits.",
    reconciler: "reconciler / controller and retry-loop correctness. READ the craft:distributed-races catalogue (its path is in the RACE CATALOGUE line below): it holds the question, the answer needed and WHERE to read it for every class R1–R15. A reconcile must converge from every state another actor can leave behind. First MAP the primary object, every child it writes, every object it READS that another controller owns, and every requeue/error outcome the pass can return. Then answer each class from its carrier, not from comments, for EVERY instance in the diff, not the first convenient one. R1–R6 need evidence from OUTSIDE the diff: (R1) self-triggering write — enumerate EVERY write to the primary in a pass, including the status/conditions the generic driver/error path writes on every pass (holds and errors included): does it change a field every pass (lastTransitionTime), does the primary's own watch (no predicate / no generation filter) re-enqueue it sooner than the requeue the code relies on, and is it skipped when nothing changed? (R2) wake source — for EVERY outcome the requeue/error policy can return (await-change included), what event or timer guarantees a pass by the deadline the code promises? None → the bound is fiction. (R3) foreign stale cache — not our own stale read (that is R12): for EACH object another controller owns that a release/delete/label removal depends on, name that controller and its observed-generation gate (an applied/desired generation pair, e.g. status.observedGeneration vs metadata.generation); can it still act (recreate a child from the OLD template) after we decided from its absent/finished state? The decision must wait until its observed generation catches up. Read that controller's code. (R4) permissions — check every API verb/resource the diff newly calls against the shipped Role/ClusterRole/chart; a missing grant is a 403 only a real cluster shows. (R5) protection released on a change of intent (spec) instead of end of use, when the consumer outlives the spec. (R6) migration window — objects created before this change lack a field/label/status the new logic relies on: what does the new code do with them, delete path included? R7–R15 (create/patch divergence, partial-failure strand, cleanup, status churn, feature gate, 409/404 race, swallowed error with no timer, strict decode on a shared stream, webhook failurePolicy) — work them from the catalogue. If the catalogue cannot be read, R1–R6 above stand on their own and you say so. A question you cannot answer from evidence is an open finding, not a pass; name the interleaving or request order that produces the bad state.",
    "failure-windows": "durability & failure windows BETWEEN the writes of one pass, and interleavings BETWEEN two controllers. Not in-process concurrency (locks, Send/Sync, blocking in async) — that is the concurrency lens; here every window is opened by a process that stopped or an API call that failed between two committed writes. Work it as a procedure, in order. (1) ENUMERATE every mutating API request the changed path issues, IN EXECUTION ORDER — CREATE, status PATCH, finalizer PATCH, DELETE, annotation write — as a numbered list; if you cannot write the list, say so instead of judging the path. (2) For EACH ADJACENT PAIR in that list, assume the first committed and the second returned 500 or the process died between them, and answer one question: what does the NEXT pass read, and does it recover? A value captured in THIS pass in memory (a mode, an origin, a derived name) and written only by a LATER request is LOST when that later request never lands; and a recovery path that re-derives it by name reads whichever object CURRENTLY carries that name — possibly a different object. Name the pair and the state it strands. (3) For each object this controller SHARES with another controller, play the interleaving out: A reads the object, B begins deletion and scans for dependents, A commits its create AFTER that scan. A one-shot dependency scan is not a guard — say what the scan would have to be (a re-check after the write, a finalizer, a conflict-detecting write) for the window to close. (4) For each guard that REFUSES an operation while its source is terminating, ask whether the counterparty WAITING on that operation counts the refused object as in-progress. Refusal plus waiting is a mutual block, and it is fixed by handling the never-started case, not by raising a timeout. REPORT SHAPE: a finding must name the REQUEST ORDER that produces the state (pair i→i+1, or the two-controller interleaving), and must say explicitly what that order does NOT establish — the behaviour of the live external system, or actual data loss — so the claim is exactly the size of its evidence.",
    maintainability: "maintainability & structural simplification (load the refactoring skill): missed code judo — a behavior-preserving reframing using the existing architecture that would make this change dramatically simpler or delete a whole category of complexity; file pushed across ~700 lines (decomposition smell); ad-hoc conditional / one-off branch / scattered special-case spliced into an unrelated or shared flow instead of a dedicated abstraction; needless optionality (Option that always holds), as-casts where From/TryFrom belongs, Box<dyn Any>/downcasting where a typed model fits. Flag only concrete, behavior-preserving restructurings the author could have taken — not hypothetical rewrites.",
    tests: 'tests as a COVERAGE ADVERSARY (not a presence check): enumerate what a regression could SILENTLY break, then check each has a test that would FAIL on that regression. The litmus test: if you deleted the production line/branch that carries a contract, would the suite still pass green? If yes, that contract is UNTESTED → finding (cite the missing test). Cover, at minimum: (a) every NEW branch and every distinct ERROR CONTRACT the code / handler / OpenAPI (or other documented interface) promises — not-found→404, forbidden / wrong-owner, bad-request→400, conflict→409, a typed 4xx that must not collapse into a 500 — each needs a test asserting THAT status/error, not just the happy path; (b) every SECURITY / AUTHORIZATION boundary — tenant or owner isolation: is there a test exercising a DIFFERENT user/tenant/scope and ASSERTING denial? A single-user happy path does NOT prove isolation; on a NEW authz-guarded endpoint a missing cross-tenant/cross-owner denial test is a HIGH-severity gap; (c) every behavioral CLAIM in the stated spec — identity preserved / "in place", a state that must stay put or transition exactly once, a field that must be scrubbed, an idempotent no-op — each needs a test that pins it and would fail if the claim were violated; (d) self-exclusion / dedup / unlink / bookkeeping guards — a uniqueness check that must exclude the row itself, a back-reference that must be cleared. Vacuous tests (assert!(true), no assertions) count as absent coverage.',
    intent: 'intent / spec conformance: does the change actually do what it is supposed to do? Work from the STATED SPEC / AUTHOR CLAIMS block (the verbatim PR/commit description), not just the one-line inferred intent. ENUMERATE every explicit claim or invariant the author wrote — patterns like "never fails on X", "the only way to Y", "idempotent" / "no-op", "in place" / "preserves Z", "always" / "never", and any documented trade-off — and for EACH claim trace the concrete code path that would carry it out. A claim the code contradicts is a finding (cite the exact file:line that violates it): e.g. an "idempotent no-op" that actually wipes a field, "the only way to change X" that silently no-ops for some inputs, "never fails on X" that returns Err on a transient/non-NotFound error. Also flag correct-looking code with wrong behavior, missed requirements, off-by-one against the spec.\n\nSECOND HALF, AND IT IS THE ONE THAT GETS SKIPPED: the author also makes claims INSIDE the diff, and those are checkable the same way. Enumerate every assertion carried by a doc comment, an inline comment stating an invariant or an ordering ("only after X", "never reached when Y", "callers guarantee Z"), a `# Safety`/`# Panics` section, a test name, or a test docstring — and for EACH one find the line that would have to be true for it, and check it. Three specific shapes, all observed in real reviews: (a) a comment that describes behaviour the code around it no longer has, because the code changed in this very diff and the paragraph above it did not — a stale comment is not a style nit, it is a false statement the next reader will act on; (b) a contract doc that contradicts the call site the diff creates (the doc says "called only where P holds" and the new caller does not establish P); (c) a test whose name or docstring claims an invariant the body does not pin — most often because BOTH sides of the assertion are hardcoded to the same constant, or because every case in the table varies nothing that the code under test reads, so the assertion is true whatever the production code does. For (c) apply the deletion litmus: name the production line the test claims to protect, and say whether the test would still pass with that line deleted. Report each as: the claim verbatim, where it is written, and the file:line that falsifies it — an unestablished premise IS the finding, you do not need a crash to report it.',
    invariants: "domain invariants & lifecycle: before judging a changed operation, read the invariants documented or enforced on the TYPES it manipulates (grep the domain/entity/service modules for doc-comment invariants, status/state enums, `effective_*` / derived getters, `*_scoped` reference ids, validation fns, and transient two-phase lifecycle states — a pending-delete/soft-delete window or an in-progress-mutation state). Flag where the change (a) accepts an entity in a transient/invalid lifecycle state, (b) crosses a scope boundary (a tenant/project/network/address-range) without re-validating or re-deriving the scoped references it carries, (c) uses a raw value where a documented derived/effective quantity is required, (d) mutates/scrubs one field but not a sibling field the same invariant governs, or (e) REIMPLEMENTS an eligibility / capacity / compatibility / authorization check that an EXISTING sibling function already performs — grep for the function doing the same job (a catalog/availability filter, a permission gate, a `*_available` / `filter_*` / `*_has_room` predicate) and diff the new path against it DIMENSION BY DIMENSION; flag any FAIL-CLOSED dimension the sibling enforces but the new path drops (a hardware/family/version compatibility filter, a missing-data→unavailable rule, an overcommit/effective-quantity conversion), because the two gates disagree the moment one is missing a dimension — that is a present correctness bug, not merely future drift. MIRROR WALK (run this when the diff touches a protocol, a state machine, a codec, or any two-sided contract — the finding IS the asymmetry, you do not need a crash to report it): (1) ENUMERATE the invariants the code must uphold — the error enum is the index, each variant names a rule someone decided to enforce, and the spec/RFC and doc comments name the rest; (2) for each invariant GREP EVERY ENFORCEMENT SITE (the guard, the version check, the bounds/limit test, the capability predicate); (3) for each site ask where its MIRROR is and whether it is guarded the same, along four axes — client↔server (the server rejects X, does the client?), send↔receive (the outgoing value is filtered, is the incoming one re-validated?), offered↔accepted (we constrain what we offer, do we constrain what we accept back?), one-param↔all-params (one negotiated parameter is validated, are its siblings — version, algorithm, limit, scope?). Missing siblings travel in packs; (4) DIFF EACH CANDIDATE AGAINST THE LAST RELEASED TAG (`git diff <tag> -- <file>`): a guard PRESENT in the release and GONE at HEAD is a regression, and that raises its severity — say which it is. Report each as: the invariant, enforced-at file:line, missing-mirror-at file:line, which axis, and what the gap lets through downstream (a panic, a silent drop, a downgrade, an accepted-but-should-be-rejected message).",
    compat: "backward compatibility: what every party still holding the OLD shape makes of the change — data written by earlier versions, replicas not yet rolled, scripts and charts pinned to the last release, clients that never upgrade, repositories that reference a name. READ the craft:compatibility catalogue (its path is in the COMPATIBILITY CATALOGUE line below): it holds the question, the answer needed and WHERE to read it for every class C1–C13. Your pathspec shows only this profile's source files, and much of the contract is not in them: ALSO run the same `git diff` range with NO pathspec (`--stat` first) and read every changed CRD, chart template and values file, config, env read, CLI definition, IDL (proto/OpenAPI), migration and doc. First MAP every surface the diff changes that something OUTSIDE this version reads, calls or deploys against, and name its consumers. Then answer each class from its carrier, for EVERY instance in the diff, not the first convenient one. These classes need evidence from OUTSIDE the diff: (C1) old data under the new shape — data already persisted (JSONB/blob/enum columns, caches, event logs, queue payloads, state files, objects in a cluster store) under the OLD shape: does it still decode under the new one with no backfill (a rename with no alias, a new required field with no default, a reordered variant, a changed storage key)? (C2) rolling deploy, BOTH directions — old and new replicas run concurrently: new writers must still emit what old readers require AND new readers must accept what old writers emit; a bare rename breaks old readers — keep the serialized key stable or split the flip across two deploys. (C3) read-only alias — an alias / fallback / accept-both covers only new-code-reads-old-data, NOT old code reading new data during a rollout or after a rollback; call that asymmetry out explicitly. (C4) migration vs running code — a migration renames/retypes/drops/tightens a column or enum the still-running old code reads or writes. (C8) schema field narrowed — a CRD/JSON-Schema/OpenAPI field removed (structural schemas prune it silently), made required, enum shrunk, pattern/range tightened or retyped while old objects or clients exist. (C9) API version lifecycle — a new version with no conversion, the storage version switched with no migration of stored objects, a version no longer served (or dropped while still in status.storedVersions) while clients or objects use it. (C11) rollout order across components — every allowed upgrade order works: new controller + old chart/CRDs (helm upgrade does not update crds/), old controller + new CRD, new client + old server, old client + new server. (C12) renamed exported identifier — an export, route/RPC, metric or label, event type, CLI subcommand, plugin skill/agent/workflow name that consumers reference: grep every consumer of the OLD name, repo-wide and in docs/charts/dashboards. (C13) regression or standing state — diff each surface against the LAST RELEASED TAG (`git describe --tags --abbrev=0`, then `git diff <tag> -- <surface>`): a contract present in the release and gone at HEAD is a regression and raises severity; one already shipped is a standing state — say which. C5–C7 and C10 (CLI flags/exit codes/output format, config keys/env vars/Helm values, changed defaults, proto/OpenAPI breaks) — work them from the catalogue. If the catalogue cannot be read, the classes above stand on their own and you say so. A question you cannot answer from evidence is an open finding, not a pass; name the old party, the new shape and the sequence (write → upgrade → read, or the deploy order) that breaks.",
    "negative-space": "negative space / cross-surface interaction: the bug the diff ENABLES in UNCHANGED code. A new status/type/enum-variant/column that pre-existing endpoints mutate blindly; a latent bug in an unchanged helper the diff makes reachable for the first time."
  }
}, PROFILES.nix = {
  id: "nix",
  lang: "Nix",
  detect: (files) => files.some((f) => /\.nix$/.test(f) || /(^|\/)flake\.lock$/.test(f)),
  diffGlobs: ["'*.nix'", "'flake.lock'"],
  rubricSkill: "nix-review",
  fpRules: "",
  rollupRuleIds: [],
  navSkill: "",
  reviewerAgent: "craft:nix-reviewer",
  securityHints: "secrets handling (agenix/sops-nix), fetchers/hashes, module security options, or build-script interpolation",
  usesLibrary: !1,
  alwaysLenses: ["intent"],
  safetyLens: "injection",
  scoutRules: `Decide what is "in play" from the diff: derivations / fetchers / hashes → packaging+purity; flake inputs / flake.lock / IFD → reproducibility; string interpolation into build or shell scripts → injection; devShell / direnv / formatters → dev-env; NixOS or home-manager modules / options / secrets → modules; dead or anti-idiomatic Nix → maintainability. ('intent' is enforced by the engine and added automatically — do not count it toward your choices.)`,
  gate: nixGate,
  depContext: nixDepContext,
  lenses: ["purity", "reproducibility", "injection", "packaging", "dev-env", "modules", "maintainability", "intent"],
  lensBrief: {
    purity: "purity: impure builtins (currentTime/getEnv/<nixpkgs>), fetchers without a fixed hash — anything that makes a build non-reproducible (PUR-*).",
    reproducibility: "reproducibility: unpinned/channel inputs, missing flake.lock entries, import-from-derivation (IFD), --impure reliance (REP-*).",
    injection: "injection: untrusted values interpolated into build or shell scripts; builtins.exec (INJ-*).",
    packaging: "packaging: mkDerivation correctness — dep hashes (cargoHash/vendorHash/npmDepsHash), builder choice, phases, meta/license (PKG-*).",
    "dev-env": "dev-env: devShell/direnv correctness, writeShellApplication, the allowUnfree-not-propagated-to-nix-develop gotcha (DEV-*).",
    modules: "modules: NixOS/home-manager option typing and defaults, cross-platform (Linux+Darwin), secrets kept out of the world-readable store — agenix/sops-nix (MOD-*).",
    maintainability: "maintainability: dead code (deadnix), anti-idioms (statix), needless rec/with, over-abstraction (MNT-*).",
    intent: 'intent / spec conformance: does the change do what it should? Work from the STATED SPEC / AUTHOR CLAIMS block (the verbatim PR/commit description), not just the one-line inferred intent. ENUMERATE every explicit claim or invariant the author wrote — patterns like "never fails on X", "the only way to Y", "idempotent" / "no-op", "in place" / "preserves Z", "always" / "never", documented trade-offs — and for EACH claim trace the concrete code path that would carry it out; a claim the code contradicts is a finding (cite the exact file:line). Also flag correct-looking code with wrong behavior.',
    "negative-space": "negative space / cross-surface interaction: the breakage the diff ENABLES in UNCHANGED Nix — a renamed option or output that existing modules/consumers still reference; a changed default that unchanged config relies on."
  }
};
function supportedLangLabel(profiles) {
  return Object.values(profiles).map((p) => p.lang).join("/");
}
function resolveProfilePin(profiles, requested) {
  if (!requested) return { pinned: null, unknown: [] };
  const list = (
    /** @type {unknown[]} */
    (Array.isArray(requested) ? requested : [requested]).filter(
      /** @returns {id is string} */
      (id) => typeof id == "string"
    ).map((id) => id.trim().toLowerCase()).filter(Boolean)
  );
  if (!list.length) return { pinned: null, unknown: [] };
  const uniq = [...new Set(list)];
  return { pinned: uniq.filter((id) => !!profiles[id]), unknown: uniq.filter((id) => !profiles[id]) };
}
function unknownPinMessage(profiles, unknown) {
  const q = (xs) => xs.map((x) => `\`${x}\``).join(", ");
  return `unknown language pin ${q(unknown)} — available: ${q(Object.keys(profiles))}`;
}
function noLanguageMessage(profiles, fileCount, materialCount = fileCount) {
  return `NOTHING WAS REVIEWED — none of the ${fileCount} changed file(s) match a supported language profile (this engine reviews ${supportedLangLabel(profiles)} only), and ${materialCount} of them carry reviewable content that therefore went unreviewed. This is not an approval: no lens ran and no finding could have been produced.`;
}
function noChangedFilesMessage() {
  return "NOTHING WAS REVIEWED — the diff came back EMPTY: no changed file was detected against the resolved base. Either there is genuinely nothing to review here (an already-merged branch, or a `path` scope that matches nothing) or the base/scope is wrong and detection failed. No lens ran, so this is not an approval — check the base and re-run.";
}
const INERT_EXT = /\.(md|markdown|rst|adoc|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf)$/i, INERT_NAMES = /* @__PURE__ */ new Set([
  "license",
  "licence",
  "notice",
  "codeowners",
  ".gitignore",
  ".gitattributes",
  "license.txt",
  "licence.txt",
  "notice.txt",
  "copying.txt",
  "authors.txt",
  "contributors.txt",
  "changelog.txt",
  "changes.txt",
  "readme.txt",
  "robots.txt",
  "humans.txt",
  "todo.txt",
  "notes.txt",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "flake.lock",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "pipfile.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "deno.lock",
  "mix.lock",
  "pubspec.lock",
  "podfile.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "cabal.project.freeze",
  "conan.lock",
  "herd.lock"
]), GENERATED_PATH = /(^|\/)(__generated__|generated|node_modules|vendor)\//i, GENERATED_FILE = /(\.snap|\.min\.(js|css|mjs|cjs)|\.pb\.(go|cc|h|rs|ts)|_pb2(_grpc)?\.py|\.gen\.(go|rs|ts)|\.generated\.[a-z0-9]+|\.g\.dart)$/i;
function isInertUncovered(f) {
  const base = (
    /** @type {string} */
    String(f).split("/").pop().toLowerCase()
  );
  return INERT_EXT.test(String(f)) || INERT_NAMES.has(base) || GENERATED_PATH.test(String(f)) || GENERATED_FILE.test(String(f));
}
function materialUncovered(files) {
  return files.filter((f) => !isInertUncovered(f));
}
const ANCILLARY_NAMES = /* @__PURE__ */ new Set([
  "dockerfile",
  "containerfile",
  "justfile",
  "makefile",
  "gnumakefile",
  "procfile",
  "vagrantfile",
  "deny.toml",
  "rustfmt.toml",
  "clippy.toml",
  "rust-toolchain.toml",
  "rust-toolchain",
  ".editorconfig",
  ".dockerignore",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".eslintrc",
  "codecov.yml",
  "renovate.json",
  "dependabot.yml",
  ".pre-commit-config.yaml"
]), ANCILLARY_PATH = /(^|\/)(\.github|\.gitlab|\.circleci|\.woodpecker|\.buildkite)\//i;
function isAncillaryConfig(f) {
  const p = String(f), base = (
    /** @type {string} */
    p.split("/").pop().toLowerCase()
  );
  return ANCILLARY_NAMES.has(base) || ANCILLARY_PATH.test(p) || /\.dockerfile$/i.test(base);
}
function coverageGapFiles(files) {
  return materialUncovered(files).filter((f) => !isAncillaryConfig(f));
}
function resolveCoverage({ profiles, changedFiles: changedFiles2, detectedActive: detectedActive2, pinnedLangs: pinnedLangs2 }) {
  const files = (
    /** @type {unknown[]} */
    Array.isArray(changedFiles2) ? changedFiles2 : []
  ), detected2 = (
    /** @type {P[]} */
    Array.isArray(detectedActive2) ? detectedActive2 : []
  );
  if (!files.length) return { outcome: "empty", active: [], material: [] };
  const material = materialUncovered(files);
  if (!material.length && !detected2.length) return { outcome: "nothing-to-review", active: [], material };
  let active2 = detected2;
  return !active2.length && Array.isArray(pinnedLangs2) && pinnedLangs2.length && (active2 = /** @type {string[]} */
  pinnedLangs2.map((id) => (
    /** @type {P} */
    profiles[id]
  ))), active2.length ? { outcome: "review", active: active2, material } : { outcome: "no-profile", active: [], material };
}
function nothingToReviewMessage(fileCount) {
  return `NOTHING NEEDED REVIEWING — all ${fileCount} changed file(s) are documentation, assets, lockfiles or generated output; none carries reviewable code. No lens ran because none had anything to look at.`;
}
function uncoveredNotRunNote(material) {
  const shown = material.slice(0, 5).join(", ");
  return `${material.length} changed file(s) matched no language profile and were NOT reviewed (${shown}${material.length > 5 ? `, +${material.length - 5} more` : ""})`;
}
function verdictSuffix({ notRun: notRun2 = [], coverageNotes: coverageNotes2 = [], floorPremiseHeld: floorPremiseHeld2 = !0 } = {}) {
  return notRun2.length || !floorPremiseHeld2 ? " (INCOMPLETE)" : coverageNotes2.length ? " (PARTIAL COVERAGE)" : "";
}
function telemetryLostSection(lost) {
  const lines = (
    /** @type {unknown[]} */
    (Array.isArray(lost) ? lost : []).filter((l) => String(l ?? "").trim())
  );
  if (!lines.length) return "";
  const landed = lines.filter((l) => /^the run directory \(the record itself landed\)/.test(String(l))), unconfirmed = lines.length - landed.length, head2 = unconfirmed ? `${unconfirmed} record write(s)/read(s) for this run could not be confirmed, so the run store may be missing or incomplete for it. Read the verdict below — not the store — for what this run actually did.` : `This run's record is in the store, but ${landed.length} run director${landed.length === 1 ? "y" : "ies"} could not be folded into it, so what those held is not there. Read the verdict below for what this run actually did.`;
  return [
    unconfirmed ? "## ⚠️ Telemetry lost" : "## ⚠️ Telemetry incomplete",
    head2,
    ...lines.map((l) => `- ${String(l).replace(/[\r\n]+/g, " ").slice(0, 300)}`),
    "",
    ""
  ].join(`
`);
}
const FINDING_ITEM = {
  type: "object",
  additionalProperties: !1,
  required: ["severity", "title", "file", "line", "why", "fix", "blastRadius", "source", "ruleId", "whereChecked"],
  properties: {
    severity: { type: "string", enum: ["Critical", "High", "Medium", "Low", "Info"] },
    title: { type: "string", description: "one-line what is wrong" },
    file: { type: "string", description: "path; empty string if not applicable" },
    line: { type: "integer", description: "1-based line; 0 if not applicable" },
    why: { type: "string", description: "why it matters" },
    whereChecked: { type: "string", description: "OFF-SITE EVIDENCE: the file:line you actually opened to establish a load-bearing premise that lives OUTSIDE the cited defect site — a dependency's behaviour, reachability from an entry point, the absence of a guard in a caller, what a sibling path does. Several may be comma-separated, each with a few words on what it shows. Empty string ONLY when the finding is fully self-contained at the cited file:line and rests on no off-site claim" },
    fix: { type: "string", description: "direction of the fix" },
    blastRadius: { type: "string", description: "callers affected / breaking-change note; empty if n/a" },
    source: { type: "string", description: "lens name or tool name that produced this" },
    ruleId: { type: "string", description: `catalog rule ID from the active profile's rules.md (e.g. "CON-003" for rust, "PUR-001" for nix) if the finding maps to one; empty string otherwise` },
    fp: { type: "string", description: "line-tolerant fingerprint; empty if not from a ledger" },
    symbol: { type: "string", description: "enclosing fn/type name; empty if unknown" },
    tier: { type: "string", description: "confirmed|suspected|unverified|refuted; empty if n/a" },
    disposition: { type: "string", description: "open|closed|rejected|justified|deferred; empty if n/a" }
  }
}, PRIOR_ROUND_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["found", "round", "head", "ledger", "ledgerCount", "priorFindings", "journalSourced", "reason"],
  properties: {
    found: { type: "boolean" },
    round: { type: "integer", description: "the prior round number; 0 when found=false" },
    head: { type: "string", description: "prior HEAD sha; empty when found=false" },
    ledger: { type: "array", items: {
      type: "object",
      additionalProperties: !1,
      required: ["fp", "file", "line", "symbol", "severity", "tier", "disposition", "source", "ruleId", "title", "why"],
      properties: {
        fp: { type: "string" },
        file: { type: "string" },
        line: { type: "integer" },
        symbol: { type: "string" },
        severity: { type: "string" },
        tier: { type: "string" },
        disposition: { type: "string" },
        source: { type: "string" },
        sources: { type: "array", items: { type: "string" } },
        ruleId: { type: "string" },
        title: { type: "string" },
        why: { type: "string" },
        // Optional (not in `required`): present only on an item whose `why` the loader script shortened for
        // transport, and it points at where the FULL `why` is recoverable — the finding's birth record: a
        // finalized record filename, or a surviving partial-directory basename for an evidence-recovery item.
        // The schema must PERMIT it so the loader's verbatim copy validates — additionalProperties
        // is false, so an emitted `whyRef` the schema did not name would null out the whole prior round.
        whyRef: {
          type: "object",
          additionalProperties: !1,
          required: ["record", "fp"],
          properties: {
            record: { type: "string" },
            fp: { type: "string" }
          }
        }
      }
    }, description: "prior findings with fp/symbol/tier/disposition; empty when found=false" },
    ledgerCount: { type: "integer", description: "the ledger length the script computed — copy it as printed; the workflow checks it against the array it received and treats a mismatch as a truncated transport" },
    reason: { type: "string", description: "why there is no prior round (no-store, no-index, no-candidate-rows, unattributable-rows-only, ancestry-rejected, detail-unreadable, partial-only, git-unavailable); empty when found=true" },
    priorFindings: { type: "integer", description: "total findings the prior round reported (its record findings.total); 0 when found=false or unknown — used to detect a round that found bugs but persisted no ledger" },
    journalSourced: { type: "boolean", description: "true when this ledger was reconstructed from a stalled run's journal.jsonl rather than a normal completed round; false when found=false. Its `head` may equal the OPERATOR'S current HEAD (a re-run on the same stalled commit before any fix), so the workflow must not diff head...HEAD off it — see shouldFullRescan." },
    sameFpBasis: { type: "boolean", description: "true when the prior round fingerprinted its findings under the SAME basis as this round (the basis is not the engine revision: a telemetry-only revision bump keeps it); false when it differs or is unknown, and when found=false. The recidivism/tombstone check compares fp only when this is true. Copy it exactly as the loader printed it, and OMIT it when the loader did not print it — never supply a value of your own: an omitted value is reported as a lost basis verdict." },
    fpBasisKnown: { type: "boolean", description: "true when the loader could establish the prior round's fingerprint basis at all; false when it could not (a round recovered from a stopped run whose checkpoints do not attest to one basis, an unreadable record, a record with no revision or a newer one). Copy it exactly as the loader printed it, and omit it when the loader did not print it." },
    priorFpRevisions: { type: "array", items: { type: "integer" }, description: "the raw engine revisions the prior round's fingerprints were minted under (empty when none can be established). The ENGINE decides comparability from these with its own table. Copy it exactly as the loader printed it, and omit it when the loader did not print it." },
    priorFpRevisionsCheck: { type: "string", description: "the same revisions as a comma-separated string, printed by the loader next to priorFpRevisions so the engine can tell the array survived transport. Copy it exactly as printed, and omit it when the loader did not print it." }
  }
}, DETECT_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["baseRef", "files", "spec", "branch", "head", "notes"],
  properties: {
    baseRef: { type: "string", description: "git ref the diff was computed against; empty if none resolved" },
    files: { type: "array", items: { type: "string" }, description: "changed file paths in the diff" },
    spec: { type: "string", description: "verbatim change description — the open PR title+body, else the commit messages on the diff range; truncated to ~4000 chars; empty string if none" },
    branch: { type: "string", description: "current git branch name; empty string if detached HEAD" },
    head: { type: "string", description: "current HEAD short SHA; empty string if not a git repo" },
    notes: { type: "string", description: "one line on what was detected" }
  }
}, SCOUT_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["sizeBucket", "lenses", "isLibrary", "securitySensitive", "intent", "churn", "notes"],
  properties: {
    sizeBucket: { type: "string", enum: ["small", "medium", "large"] },
    lenses: { type: "array", items: { type: "string" }, description: "subset of the profile lens catalog to run" },
    isLibrary: { type: "boolean", description: "true if a published library (→ semver-checks); always false where not applicable" },
    securitySensitive: { type: "boolean" },
    intent: { type: "string", description: "what the change should do, from the brief/args; empty if unknown" },
    churn: { type: "array", items: { type: "string" }, description: "hot/often-changed files to scrutinize; may be empty" },
    notes: { type: "string", description: "one line on what was detected" },
    // realm @nick/craft #102: OPTIONAL by design — and NOT in `required` above on purpose. Its absence
    // (and a missing key within it) is what makes the surface gate fail-open: the gate drops a lens
    // only where the scout AFFIRMATIVELY set the needed surface false. Each key is likewise optional.
    surfaces: {
      type: "object",
      additionalProperties: !1,
      properties: {
        crossBoundarySymbol: { type: "boolean", description: "diff changes the signature/shape of an exported/pub symbol that unchanged code depends on" },
        wireForm: { type: "boolean", description: "diff changes a contract another version reads, calls or deploys against — CRD schema or API version, serde type, HTTP/OpenAPI, protocol, CLI flag/exit code/output format, config key, env var, Helm value, changed default, renamed exported name" },
        invariantType: { type: "boolean", description: "diff changes a type that carries an invariant other code relies on" }
      }
    }
  }
}, GATE_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["status", "provenance", "failedChecks", "carriedChecks", "seedFindings", "notes"],
  properties: {
    status: { type: "string", enum: ["pass", "fail", "unknown"] },
    provenance: { type: "string", description: 'e.g. "build/test/clippy/fmt via CI #123; audit/deny local"' },
    failedChecks: { type: "array", items: { type: "string" } },
    carriedChecks: { type: "array", items: { type: "string" }, description: "red checks that are REAL but not attributable to this diff (pre-existing dependency advisories on a diff that touches no manifest). Reported, never gate-failing." },
    seedFindings: { type: "array", items: FINDING_ITEM },
    notes: { type: "string" }
  }
}, FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["lens", "findings"],
  properties: {
    lens: { type: "string" },
    findings: { type: "array", items: FINDING_ITEM }
  }
}, VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["refuted", "citedLineMatches", "reachable", "premiseSupported", "reason"],
  properties: {
    refuted: { type: "boolean", description: "true if the finding does not hold up" },
    citedLineMatches: { type: "boolean", description: "true if the cited file:line actually contains what the finding claims" },
    reachable: { type: "boolean", description: "true if the path is reachable in production (not test/example-only)" },
    premiseSupported: { type: "boolean", description: "true if the load-bearing premise is either self-contained at the cited line or actually shown by the code at whereChecked; false if it is an off-site claim with no evidence that checks out" },
    reason: { type: "string" }
  }
}, CRITIC_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["missingLenses", "notes"],
  properties: {
    missingLenses: { type: "array", items: { type: "string" }, description: "lenses from the candidate list that should also run; empty if coverage is complete" },
    notes: { type: "string", description: 'one line on anything else likely missed, or "coverage complete"' }
  }
}, CHANGED_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["changed", "reason"],
  properties: { changed: { type: "boolean" }, reason: { type: "string" } }
}, PR_COMMENTS_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["posted", "reason"],
  properties: {
    posted: { type: "integer", description: "how many inline comments were actually created; 0 if none" },
    reason: { type: "string", description: "the PR posted to, or why nothing was posted" }
  }
}, ADJUDICATE_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["status", "currentLine", "note", "invariant", "attack"],
  properties: {
    status: { type: "string", enum: ["resolved", "still-open", "cannot-tell", "regressed"] },
    currentLine: { type: "integer", description: "re-located 1-based line; 0 if not found" },
    note: { type: "string" },
    invariant: { type: "string", description: "one-sentence invariant the finding violated" },
    attack: { type: "string", description: "the successful attack on the fix; empty string if every attack failed" }
  }
}, ATTACK_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["defeated", "attack"],
  properties: {
    defeated: { type: "boolean", description: "true only if a concrete input/state defeats the fix" },
    attack: { type: "string", description: "the concrete input/state and why it slips past the fix; empty if none found" }
  }
}, CRAFT_VERSION = "0.23.1", SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }, DEMOTE = { Critical: "High", High: "Medium", Medium: "Low", Low: "Info", Info: "Info" }, ATTACK_MAX = 500;
function sanitizeAttack(text) {
  const flat = String(text ?? "").replace(/[\r\n]+/g, " ").replace(/[#`*_[\]<>|]/g, "").replace(/ — (?=fix incomplete|REGRESSED after fix|UNVERIFIED|still-open|also reported at|\(\+\d+ (?:more|further) report)/gi, " ").replace(/ \(reopened: /gi, " (reopened ").replace(/\(\+(?=\d+ (?:more|further) report\(s\))/gi, "(").trim();
  return flat.length > ATTACK_MAX ? `${flat.slice(0, ATTACK_MAX)}…` : flat;
}
function baseWhy(why) {
  const s = String(why ?? "").replace(/ \(reopened: [^)]*\)\s*$/, "").replace(/ — still-open \(adjudicator did not run[^)]*\)\s*$/, "").replace(/ — REGRESSED after fix \(no detail[^)]*\)\s*$/, "").replace(/ — UNVERIFIED \(adjudicator could not tell[^)]*\)\s*$/, ""), re = / — (?:fix incomplete(?: \([^)]*\))?|REGRESSED after fix|UNVERIFIED \(adjudicator could not tell\)): /g;
  let last = -1, m;
  for (; m = re.exec(s); ) last = m.index;
  return last === -1 ? s : s.slice(0, last);
}
function isHighSeverity(sev) {
  return ["critical", "high"].includes(String(sev ?? "").trim().toLowerCase());
}
function classifyRedTeam(f, adj, rt) {
  if (!isHighSeverity(f.severity)) return { adj, died: !1, overturned: !1, invalid: !1 };
  if (rt == null) return { adj: { ...adj, note: `${adj.note || ""} [red-team did not run — agent died; resolved on the adjudicator's attack pass alone]`.trim() }, died: !0, overturned: !1, invalid: !1 };
  const atk = sanitizeAttack(rt.attack);
  return rt.defeated && !atk ? { adj: { ...adj, note: `${adj.note || ""} [red-team claimed defeat with no attack — invalid verdict discarded; resolved on the adjudicator's attack pass alone]`.trim() }, died: !1, overturned: !1, invalid: !0 } : rt.defeated ? { adj: { ...adj, status: "still-open", attack: `(red-team) ${atk}` }, died: !1, overturned: !0, invalid: !1 } : { adj, died: !1, overturned: !1, invalid: !1 };
}
function adjudicateOne(f, r) {
  const located = { ...f, line: r?.currentLine || f.line }, attack = sanitizeAttack(r?.attack);
  if (r == null) return { track: "stillOpen", adjudicatorDied: !0, entry: { ...located, why: `${baseWhy(f.why)} — still-open (adjudicator did not run — agent died; kept still-open by default)` } };
  const status = r.status || "still-open";
  return status === "resolved" ? adjudicateResolved(f, located, r, attack) : status === "cannot-tell" ? adjudicateCannotTell(f, located, r) : status === "regressed" ? adjudicateRegressed(f, located, r) : { track: "stillOpen", entry: attack ? { ...located, why: `${baseWhy(f.why)} — fix incomplete: ${attack}` } : located };
}
function adjudicateResolved(f, located, r, attack) {
  return attack ? { track: "stillOpen", demoted: !0, entry: { ...located, why: `${baseWhy(f.why)} — fix incomplete (adjudicator reported attack despite resolved): ${attack}` } } : { track: "resolved", entry: { ...located, disposition: "closed", ...r.note ? { note: sanitizeAttack(r.note) } : {} } };
}
function adjudicateCannotTell(f, located, r) {
  const note = sanitizeAttack(r.note) || sanitizeAttack(r.attack);
  return { track: "stillOpen", cannotTell: !0, entry: { ...located, why: `${baseWhy(f.why)} — UNVERIFIED (adjudicator could not tell): ${note || "no reason returned"}` } };
}
function adjudicateRegressed(f, located, r) {
  const note = sanitizeAttack(r.note);
  return { track: "regressed", entry: { ...located, why: note ? `${baseWhy(f.why)} — REGRESSED after fix: ${note}` : `${baseWhy(f.why)} — REGRESSED after fix (no detail returned by adjudicator)` } };
}
function shouldRedTeam(r) {
  return r?.status === "resolved" && !sanitizeAttack(r.attack);
}
function carriedKey(f) {
  const file = String(f?.file ?? "").trim().toLowerCase(), ruleId = String(f?.ruleId ?? "").trim().toLowerCase();
  return file && ruleId ? `${file}\0${ruleId}` : "";
}
function findCarrier(f, priors, fallbackMatch) {
  const key2 = carriedKey(f);
  return (priors || []).find((p) => {
    const pk = carriedKey(p);
    return key2 && pk ? key2 === pk : typeof fallbackMatch == "function" ? !!fallbackMatch(f, p) : !1;
  }) || null;
}
const ABSORBED_MAX = 3, ABSORB_FILE_MAX = 120, ABSORB_TITLE_MAX = 160;
function clampField(text, max) {
  const s = sanitizeAttack(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function noteAbsorbed(baseText, f) {
  const base = String(baseText ?? ""), mark = " — also reported at ", clause = `${mark}${absorbedSite(f)}`;
  if (base.includes(clause)) return base;
  if (base.split(mark).length - 1 < ABSORBED_MAX) return base + clause;
  const overflow = / — \(\+(\d+) more report\(s\) at this site\)/, m = base.match(overflow);
  return `${m ? base.replace(overflow, "") : base} — (+${m ? Number(m[1]) + 1 : 1} more report(s) at this site)`;
}
function absorbedSite(f) {
  return `${clampField(f?.file, ABSORB_FILE_MAX) || "?"}:${Number(f?.line) || 0}: ${clampField(f?.title, ABSORB_TITLE_MAX) || "untitled"}`;
}
function absorbInto(hostWhy, f) {
  const s = String(hostWhy ?? ""), base = baseWhy(s);
  return noteAbsorbed(base, f) + s.slice(base.length);
}
function splitAbsorbed(why) {
  const overflow = / — \(\+(\d+) more report\(s\) at this site\)/;
  let head2 = baseWhy(why);
  const m = head2.match(overflow), more = m ? Number(m[1]) : 0;
  m && (head2 = head2.replace(overflow, ""));
  const parts = head2.split(" — also reported at ");
  return { base: (
    /** @type {string} */
    parts[0]
  ), sites: parts.slice(1).map((s) => s.trim()).filter(Boolean), more };
}
function withoutAbsorbed(why) {
  const s = String(why ?? "");
  return splitAbsorbed(s).base + s.slice(baseWhy(s).length);
}
function absorbedPromptBlock(why) {
  const { sites, more } = splitAbsorbed(why);
  if (!sites.length && !more) return "";
  const lines = sites.map((s) => `  - ${s}`);
  return more && lines.push(`  - (+${more} further report(s) at this site, not named individually)`), `
ALSO REPORTED AT THIS SITE (further defects later rounds raised at the same file+rule; they are tracked ONLY through this finding and leave the ledger when it does):
${lines.join(`
`)}
They are part of what you are adjudicating: "resolved" requires that every one of them is gone too. If any of them still stands, return "still-open" and cite it in \`attack\`.
`;
}
function partitionAbsorbed(findings, livePriors, retired, fallbackMatch, seed) {
  const isRetired = (h) => retired instanceof Set ? retired.has(h) : !!(retired || []).includes(h), kept = [], updates = new Map(seed || []);
  let absorbed = 0, keptAtRetired = 0;
  for (const f of findings || []) {
    const host = findCarrier(f, livePriors, fallbackMatch);
    if (!host) {
      kept.push(f);
      continue;
    }
    if (isRetired(host)) {
      keptAtRetired++, kept.push(f);
      continue;
    }
    absorbed++, updates.set(host, absorbInto(updates.has(host) ? updates.get(host) : host.why, f));
  }
  return { kept, absorbed, keptAtRetired, updates };
}
function absorbAcross(lists, livePriors, retired, fallbackMatch) {
  const runs = [];
  let updates = /* @__PURE__ */ new Map();
  for (const list of lists || []) {
    const r = partitionAbsorbed(list, livePriors, retired, fallbackMatch, updates);
    updates = r.updates, runs.push(r);
  }
  return {
    runs,
    updates,
    absorbed: runs.reduce((n, r) => n + r.absorbed, 0),
    keptAtRetired: runs.reduce((n, r) => n + r.keptAtRetired, 0)
  };
}
const TRACKED_MARK = " — (this site is already tracked by a still-live prior finding; NOT absorbed into it: nothing checked this report against the code, so it may not hold that prior open)";
function markTrackedUnverified(findings, livePriors, retired, fallbackMatch) {
  const isRetired = (h) => retired instanceof Set ? retired.has(h) : !!(retired || []).includes(h), hosts = (livePriors || []).filter((h) => !isRetired(h)), unverifiedHosts = hosts.filter((h) => String(h?.tier ?? "") === "unverified");
  let marked = 0, collapsed = 0;
  const updates = /* @__PURE__ */ new Map();
  return { kept: (findings || []).map((f) => {
    const host = findCarrier(f, unverifiedHosts, fallbackMatch) || findCarrier(f, hosts, fallbackMatch);
    if (!host) return f;
    const dup = String(host.tier ?? "") === "unverified" ? { ledgerDupOfUnverifiedPrior: !0 } : {};
    dup.ledgerDupOfUnverifiedPrior && (collapsed++, updates.set(host, absorbInto(updates.has(host) ? updates.get(host) : host.why, f)));
    const why = String(f.why ?? "");
    return why.includes(TRACKED_MARK) ? { ...f, ...dup } : (marked++, { ...f, ...dup, why: why + TRACKED_MARK });
  }), marked, collapsed, updates };
}
function flattenField(v) {
  return String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, ATTACK_MAX);
}
function promptFields(f) {
  return {
    title: flattenField(f.title),
    symbol: flattenField(f.symbol) || "?",
    ruleId: flattenField(f.ruleId) || "—",
    file: flattenField(f.file),
    severity: flattenField(f.severity),
    // A locator field like file/symbol: paths and identifiers are load-bearing (the verifier is
    // told to OPEN it), so flatten newlines but keep `_ < > [ ]` intact — see flattenField.
    whereChecked: flattenField(f.whereChecked)
  };
}
function shq(s) {
  return `'${String(s ?? "").replace(/'/g, "'\\''")}'`;
}
function isCommitish(s) {
  const v = String(s ?? "").trim();
  return v ? /^[0-9a-fA-F]{7,40}$/.test(v) ? !0 : /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(v) : !1;
}
const CANON_SEVERITY = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };
function canonicalSeverity(sev) {
  return CANON_SEVERITY[String(sev ?? "").trim().toLowerCase()] || String(sev ?? "").trim();
}
const PRIOR_SUMMARY_MAX_CHARS = 3e3, PRIOR_SUMMARY_TITLE_MAX = 120;
function priorFoundSummary(pool, { maxChars = PRIOR_SUMMARY_MAX_CHARS, titleMax = PRIOR_SUMMARY_TITLE_MAX } = {}) {
  const items = (
    /** @type {PriorFinding[]} */
    Array.isArray(pool) ? pool : []
  );
  if (!items.length) return "none yet";
  const rank = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }, line = (f) => `${String(f?.file ?? "").replace(/[\r\n]+/g, " ").trim() || "?"}:${f?.line || 0} ${String(f?.title ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, titleMax)}`.trimEnd(), ordered = items.map((f, i) => ({ f, i })).sort((a, b) => (rank[canonicalSeverity(a.f?.severity)] ?? 9) - (rank[canonicalSeverity(b.f?.severity)] ?? 9) || a.i - b.i).map(({ f }) => line(f)), kept = [];
  let used = 0;
  for (const l of ordered) {
    if (kept.length && used + l.length + 1 > maxChars) break;
    kept.push(l), used += l.length + 1;
  }
  const omitted = ordered.length - kept.length;
  return omitted > 0 && kept.push(`… and ${omitted} more already-found finding(s), lowest severity first, withheld to keep this prompt small. This list is PARTIAL: anything you re-surface is de-duplicated downstream, so do not spend effort guessing what is missing from it.`), kept.join(`
`);
}
function redTeamInvariant(adj, f) {
  return sanitizeAttack(adj.invariant) || sanitizeAttack(f.why);
}
const AGENT_TRIES = 2, REPO_DIRECTIVE = repoDirective();
function repoDirective() {
  return repoArg ? `WORKING DIRECTORY: this review targets the repository at ${shq(repoArg)} — NOT the directory you start in. Before ANY git / cargo / nix / file command, \`cd\` there (or pass \`git -C\`). Every file path in this review is relative to that root. If that directory does not exist or is not a git repository, say so and stop rather than reviewing whatever repo you happen to be sitting in.

` : "";
}
const DEATH_WINDOW_DISPATCHES = 6, DEATHS_IN_WINDOW_TO_OPEN = 3;
function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}
function makeDeathBreaker(opts = {}) {
  const windowLen = positiveInt(opts.window, DEATH_WINDOW_DISPATCHES), toOpen = Math.min(windowLen, positiveInt(opts.toOpen, Math.min(windowLen, DEATHS_IN_WINDOW_TO_OPEN))), recent = [], observe = (isDeath) => {
    for (recent.push(isDeath); recent.length > windowLen; ) recent.shift();
  }, deaths = () => recent.reduce((n, isDeath) => n + (isDeath ? 1 : 0), 0);
  return {
    deathAllowsRedispatch() {
      return observe(!0), deaths() < toOpen;
    },
    recordLive() {
      observe(!1);
    },
    deaths,
    observed() {
      return recent.length;
    },
    windowLen,
    toOpen
  };
}
function utf8Bytes(text) {
  const out2 = [];
  for (const ch of text) {
    let cp = (
      /** @type {number} */
      ch.codePointAt(0)
    );
    cp >= 55296 && cp <= 57343 && (cp = 65533), cp < 128 ? out2.push(cp) : cp < 2048 ? out2.push(192 | cp >> 6, 128 | cp & 63) : cp < 65536 ? out2.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63) : out2.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
  }
  return out2;
}
function utf8Text(bytes) {
  const st = { out: "", cp: 0, need: 0, seen: 0, lower: 128, upper: 191 };
  let i = 0;
  for (; i < bytes.length; ) i += utf8Feed(
    st,
    /** @type {number} */
    bytes[i]
  );
  return st.need !== 0 && (st.out += "�"), st.out;
}
function utf8Feed(st, b) {
  return st.need === 0 ? (utf8Start(st, b), 1) : b < st.lower || b > st.upper ? (st.cp = st.need = st.seen = 0, st.lower = 128, st.upper = 191, st.out += "�", 0) : (st.lower = 128, st.upper = 191, st.cp = st.cp << 6 | b & 63, st.seen++, st.seen === st.need && (st.out += String.fromCodePoint(st.cp), st.cp = st.need = st.seen = 0), 1);
}
function utf8Start(st, b) {
  if (b <= 127) {
    st.out += String.fromCharCode(b);
    return;
  }
  const lead = utf8Lead(b);
  lead ? Object.assign(st, lead) : st.out += "�";
}
function utf8Lead(b) {
  const range = utf8FirstRange(b);
  return b >= 194 && b <= 223 ? { need: 1, cp: b & 31, ...range } : b >= 224 && b <= 239 ? { need: 2, cp: b & 15, ...range } : b >= 240 && b <= 244 ? { need: 3, cp: b & 7, ...range } : null;
}
function utf8FirstRange(b) {
  return { lower: b === 224 ? 160 : b === 240 ? 144 : 128, upper: b === 237 ? 159 : b === 244 ? 143 : 191 };
}
function decodeGitPath(file) {
  const raw = String(file ?? "");
  if (!(raw.length > 1 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const body = [...raw.slice(1, -1)], bytes = [];
  for (let i = 0; i < body.length; i++) {
    const { out: out2, skip } = gitPathChunk(body, i);
    bytes.push(...out2), i += skip;
  }
  return utf8Text(bytes) || raw;
}
function gitPathChunk(body, i) {
  if (body[i] !== "\\") return { out: utf8Bytes(
    /** @type {string} */
    body[i]
  ), skip: 0 };
  const SIMPLE = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }, c = body[i + 1];
  if (c === void 0) return { out: utf8Bytes("\\"), skip: 0 };
  if (Object.prototype.hasOwnProperty.call(SIMPLE, c)) return { out: [
    /** @type {number} */
    SIMPLE[c]
  ], skip: 1 };
  const octal = body.slice(i + 1, i + 4).join("");
  return /^[0-7]{3}$/.test(octal) ? { out: [parseInt(octal, 8)], skip: 3 } : { out: utf8Bytes("\\"), skip: 0 };
}
const MAX_SHARED_PER_SLICE = 8, SHARED_SUFFIXES = [".lock", ".yml", ".yaml", ".toml", ".json"], GROUP_DEPTH = 2;
function isShared(file) {
  return SHARED_SUFFIXES.some((s) => file.endsWith(s));
}
function groupKey(file, depth = GROUP_DEPTH) {
  const parts = String(file).split("/");
  return parts.length <= depth ? parts.slice(0, -1).join("/") || "." : parts.slice(0, depth).join("/");
}
function splitDeep(group, cap, depth) {
  if (group.files.length <= cap || depth > 8) return [group];
  const byKey = /* @__PURE__ */ new Map();
  for (const f of group.files) {
    const k = groupKey(f, depth), bucket = byKey.get(k);
    bucket ? bucket.push(f) : byKey.set(k, [f]);
  }
  if (byKey.size <= 1) {
    const deeper = splitDeep(group, cap, depth + 1);
    return deeper.length > 1 ? deeper : [group];
  }
  return [...byKey.entries()].flatMap(([key2, files]) => splitDeep({ key: key2, files }, cap, depth + 1));
}
function commonPrefixLength(a, b) {
  const x = String(a).split("/"), y = String(b).split("/");
  let n = 0;
  for (; n < x.length && n < y.length && x[n] === y[n]; ) n++;
  return n;
}
function mergedKey(a, b) {
  const n = commonPrefixLength(a, b);
  return n > 0 ? String(a).split("/").slice(0, n).join("/") : `${a} + ${b}`;
}
function uniqueKey(key2, groups) {
  if (!groups.some((g) => g.key === key2)) return key2;
  let n = 2;
  for (; groups.some((g) => g.key === `${key2} (${n})`); ) n++;
  return `${key2} (${n})`;
}
function sliceDiff(files, { minFiles = 12, maxSlices = 6, maxFilesPerSlice = 0, owns = null } = {}) {
  const { shared, owned } = partitionOwned((Array.isArray(files) ? files : []).map(String).filter(Boolean), owns);
  if (owned.length < minFiles) return [];
  const byKey = groupFilesByKey(owned);
  if (byKey.size <= 1) return [];
  const cap = maxFilesPerSlice > 0 ? maxFilesPerSlice : Math.max(1, Math.ceil(owned.length / maxSlices)), groups = mergeNearestGroups([...byKey.entries()].flatMap(([key2, fs]) => splitDeep({ key: key2, files: fs }, cap, GROUP_DEPTH + 1)).sort(largestGroupFirst), maxSlices, cap);
  return groups.sort(largestGroupFirst), groups.map((g) => ({ key: g.key, files: [...g.files, ...shared] }));
}
function partitionOwned(all, owns) {
  const isOwned = typeof owns == "function" ? owns : (f) => !isShared(f), sharedAll = all.filter(isShared).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)), shared = sharedAll.slice(0, MAX_SHARED_PER_SLICE), evicted = sharedAll.slice(MAX_SHARED_PER_SLICE).filter(isOwned);
  return { shared, owned: all.filter((f) => isOwned(f) && !isShared(f)).concat(evicted) };
}
function groupFilesByKey(owned) {
  const byKey = /* @__PURE__ */ new Map();
  for (const f of owned) {
    const k = groupKey(f), bucket = byKey.get(k);
    bucket ? bucket.push(f) : byKey.set(k, [f]);
  }
  return byKey;
}
function largestGroupFirst(a, b) {
  return b.files.length - a.files.length || a.key.localeCompare(b.key);
}
function mergeNearestGroups(start, maxSlices, cap) {
  let groups = start;
  for (; groups.length > maxSlices; ) {
    const pick = pickMerge(groups, cap), a = (
      /** @type {Group} */
      groups[pick.i]
    ), b = (
      /** @type {Group} */
      groups[pick.j]
    );
    groups = groups.filter((_unused, idx) => idx !== pick.i && idx !== pick.j), groups.push({ key: uniqueKey(mergedKey(a.key, b.key), groups), files: [...a.files, ...b.files] });
  }
  return groups;
}
function pickMerge(groups, cap) {
  let best = null, fallback = null;
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const cand = mergeCandidate(groups, i, j);
      (!fallback || cand.size < fallback.size) && (fallback = cand), cand.size <= cap && closerMerge(cand, best) && (best = cand);
    }
  return (
    /** @type {{ i: number, j: number, shared: number, size: number }} */
    best || fallback
  );
}
function mergeCandidate(groups, i, j) {
  const gi = (
    /** @type {Group} */
    groups[i]
  ), gj = (
    /** @type {Group} */
    groups[j]
  );
  return { i, j, shared: commonPrefixLength(gi.key, gj.key), size: gi.files.length + gj.files.length };
}
function closerMerge(cand, best) {
  return !best || cand.shared > best.shared || cand.shared === best.shared && cand.size < best.size;
}
function sliceableLens(lens) {
  return !WHOLE_DIFF_LENSES.includes(String(lens));
}
const WHOLE_DIFF_LENSES = ["negative-space", "intent", "compat", "invariants", "failure-windows"], LENS_WINDOW_AGENTS = 16;
function pathspecLiteral(file) {
  const f = String(file ?? "");
  return f ? `:(literal)${f}` : "";
}
function deadlineSpan(totalMs, floorMs) {
  const total = Number(totalMs), capped = Number.isFinite(total) && total > 0 ? total : 0;
  return { capped, floor: Math.max(0, Math.min(capped, Number(floorMs) || 0)) };
}
function deadlineArm(schedule, cancel) {
  return schedule && cancel ? (fn, ms) => {
    const t = schedule(fn, ms);
    return () => cancel(t);
  } : (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  };
}
function makeDeadlineBudget(totalMs, { floorMs = 0, schedule, cancel } = {}) {
  const { capped, floor } = deadlineSpan(totalMs, floorMs);
  let expired = capped === 0, belowFloor = capped === 0 || floor >= capped, resolveHit = null;
  const arm = deadlineArm(schedule, cancel), timers = [], hit = capped === 0 ? Promise.resolve(DEADLINE_HIT) : new Promise((resolve) => {
    resolveHit = resolve;
  });
  return capped > 0 && (timers.push(arm(() => {
    expired = !0, belowFloor = !0, resolveHit && resolveHit(DEADLINE_HIT);
  }, capped)), floor > 0 && floor < capped && timers.push(arm(() => {
    belowFloor = !0;
  }, capped - floor))), {
    hit,
    expired: () => expired,
    belowFloor: () => belowFloor,
    total: () => capped,
    dispose: () => {
      for (const disarm of timers) disarm();
    }
  };
}
const DEADLINE_HIT = { craftDeadline: !0 }, DEFAULT_DEADLINE_MS = 18e5, PHASE_DEADLINE_MS = { Scout: 9e5, Gate: 18e5, Lenses: 54e5, Verify: 18e5, Adjudicate: 18e5, Synthesize: 18e5 }, deadlineArg = deadlineArgMs();
function deadlineArgMs() {
  return Number(A.deadlineMs) > 0 ? Number(A.deadlineMs) : 0;
}
const RETRY_FLOOR_MS = 6e4, retryFloorMs = (totalMs) => Math.min(RETRY_FLOOR_MS, Math.floor((Number(totalMs) > 0 ? Number(totalMs) : 0) / 2));
function announceDeadlineOverride() {
  if (deadlineArg) {
    const m = (v) => v >= 6e4 ? `${Math.round(v / 6e4)}min` : `${Math.max(1, Math.round(v / 1e3))}s`, moved = (dir) => Object.entries(PHASE_DEADLINE_MS).filter(([, v]) => dir < 0 ? v > deadlineArg : v < deadlineArg).map(([k, v]) => `${k} ${m(v)}→${m(deadlineArg)}`), shortened = moved(-1), lengthened = moved(1);
    log(`⏱️ deadlineMs=${deadlineArg} replaces the per-phase deadline table for every phase that does not name its own${shortened.length ? ` — SHORTENING ${shortened.join(", ")}. A phase cut below the live distribution will fire its deadline on healthy agents, and a transcript full of deadline fires reads like an API outage.` : ""}${lengthened.length ? ` — LENGTHENING ${lengthened.join(", ")}.` : ""}${deadlineArg < RETRY_FLOOR_MS * 2 ? ` NOTE: for the phases this argument governs, the re-dispatch floor drops with it to ${Math.round(Math.floor(deadlineArg / 2) / 1e3)}s, so a dead agent gets a much shorter second attempt than usual; a dispatch carrying its own deadline keeps its own floor.` : ""}`);
  }
}
announceDeadlineOverride();
function deadlineMsFor(opts) {
  const explicit = Number(opts.deadlineMs);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : deadlineArg || (PHASE_DEADLINE_MS[
    /** @type {string} */
    opts.phase
  ] ?? DEFAULT_DEADLINE_MS);
}
async function ragent(prompt, opts = {}) {
  const { deadlineMs: _deadlineMs, breaker, ...agentOpts } = opts, ms = deadlineMsFor(opts), budget2 = makeDeadlineBudget(ms, { floorMs: retryFloorMs(ms) });
  try {
    return (
      /** @type {T | null} */
      await withBudget(prompt, agentOpts, budget2, breaker, opts)
    );
  } finally {
    budget2.dispose();
  }
}
async function withBudget(prompt, agentOpts, budget2, breaker, opts) {
  for (let attempt = 1; ; attempt++) {
    const o = attempt === 1 ? agentOpts : { ...agentOpts, label: `retry:${agentOpts.label || "agent"}` }, res = await Promise.race([agent(`${REPO_DIRECTIVE}${prompt}`, o), budget2.hit]), spentOut = budget2.belowFloor();
    if (res === DEADLINE_HIT)
      return logDeadlineFire(o, budget2), null;
    if (res != null)
      return breaker && breaker.recordLive(), res;
    if (!redispatchAfterDeath(attempt, spentOut, budget2, breaker, opts)) return null;
  }
}
function logDeadlineFire(o, budget2) {
  const ms = budget2.total(), waited = ms >= 6e4 ? `${Math.round(ms / 6e4)}min budget` : `${Math.max(1, Math.round(ms / 1e3))}s budget`;
  log(`⏱️ agent '${o.label || "?"}' exhausted its ${waited} with no response — abandoning the wait (the deadline is one budget shared by the attempts and a fire spends it, so there is nothing left to re-dispatch into; treated as a dead agent)`);
}
function redispatchAfterDeath(attempt, spentOut, budget2, breaker, opts) {
  return attempt >= AGENT_TRIES ? !1 : spentOut ? (log(`⏱️ agent '${opts.label || "?"}' returned no result with less than the ${Math.round(retryFloorMs(budget2.total()) / 1e3)}s floor left of its ${Math.round(budget2.total() / 1e3)}s deadline budget — NOT re-dispatching (a second attempt would time out before it could answer); treated as a dead agent`), !1) : breaker && !breaker.deathAllowsRedispatch() ? (log(`⛔ agent '${opts.label || "?"}' returned no result — ${breaker.deaths()} of the last ${breaker.observed()} windowed verification dispatches returned nothing, so this one is NOT re-dispatched (the re-dispatch is for a one-off failure, and at this rate it is not one); treated as a dead agent, reported as unverified exactly like every other death`), !1) : (log(`⚠️ agent '${opts.label || "?"}' returned no result (API death or skip) — re-dispatching once`), !0);
}
const SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"];
function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
  for (const f of Array.isArray(findings) ? findings : [])
    f && Object.prototype.hasOwnProperty.call(by, f.severity) && (by[
      /** @type {Severity} */
      f.severity
    ] += 1);
  return by;
}
function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings);
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity };
}
function reviewVerdict(confirmed2) {
  const by = countBySeverity(confirmed2);
  return by.Critical || by.High ? "Block" : by.Medium ? "Warning" : "Approve";
}
function refuteRate(refuted, candidates) {
  return candidates ? Math.round(refuted / candidates * 100) / 100 : 0;
}
function isMaintainability(f) {
  return (f.source || "") === "maintainability" || Array.isArray(f.sources) && /** @type {unknown[]} */
  f.sources.includes("maintainability");
}
function finalVerdict(confirmed2) {
  return strict && confirmed2.some((f) => isMaintainability(f) && (f.severity === "Critical" || f.severity === "High" || f.severity === "Medium")) ? "Block" : reviewVerdict(confirmed2);
}
const telemetryLost = [];
function noteTelemetryLoss(what, why) {
  const line = `${what}${why ? ` — ${why}` : ""}`;
  telemetryLost.push(line), log(`⚠️ telemetry lost: ${line}`);
}
const ragentQuietly = quietly(ragent);
function splitThrew(res) {
  return res && typeof res == "object" && "__threw" in res ? { answer: null, threw: String(res.__threw) } : { answer: (
    /** @type {T | null} */
    res
  ), threw: "" };
}
let reReviewMemoryNote = null;
const reReviewMemorySection = () => reReviewMemoryNote ? `## ⚠️ Re-review memory off
${reReviewMemoryNote}

` : "", reviewerAgentUnavailable = [];
function isAgentTypeMissing(msg, agent2) {
  const m = String(msg ?? "");
  return /not found/i.test(m) && (/agent type/i.test(m) || !!agent2 && m.includes(agent2));
}
function agentUnavailableSection(missing, emptied) {
  const hard = Array.isArray(missing) ? missing : [], soft = (Array.isArray(emptied) ? emptied : []).filter((x) => x && x.count > 0);
  if (!hard.length && !soft.length) return "";
  const quote = (e) => String(e).replace(/\s+/g, " ").trim().slice(0, 160), lines = [
    ...hard.map((x) => `- \`${x.agent}\` is not registered in this session, so ${x.what} went to the generic subagent, without that agent's rubric — this run is weaker than a normal one, not broken.${x.error ? ` (${quote(x.error)})` : ""}`),
    ...soft.map((x) => x.error ? `- \`${x.agent}\` failed with "${quote(x.error)}" on ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent in wording this engine does not recognise, or a missing model or tool).` : `- \`${x.agent}\` returned nothing for ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent on some runtimes, or a transient failure).`)
  ], fix = hard.length ? "Enable the plugin in this project (`/plugin install craft@craft`, project or local scope) and re-run to use it.\n" : "";
  return `## ⚠️ Reviewer agent unavailable
${lines.join(`
`)}
${fix}
`;
}
function agentUnavailableRecord(missing, fallbacks) {
  const agentFallbacks = {};
  for (const x of fallbacks) x.count > 0 && (agentFallbacks[x.agent] = (agentFallbacks[x.agent] || 0) + x.count);
  return { agentUnavailable: [...new Set(missing)].sort(), agentFallbacks };
}
function noteReviewerAgentMissing(profile, error) {
  reviewerAgentUnavailable.some((x) => x.id === profile.id) || reviewerAgentUnavailable.push({ id: profile.id, agent: profile.reviewerAgent, error: String(error || "").slice(0, 160) });
}
const reviewerAgentFallbacks = {}, reviewerAgentNames = {}, reviewerAgentNotFound = {};
function noteReviewerAgentFallback(profile) {
  reviewerAgentFallbacks[profile.id] = (reviewerAgentFallbacks[profile.id] || 0) + 1, reviewerAgentNames[profile.id] = profile.reviewerAgent;
}
function noteReviewerAgentNotFound(profile, error) {
  const was = reviewerAgentNotFound[profile.id];
  reviewerAgentNotFound[profile.id] = { count: (was?.count || 0) + 1, error }, reviewerAgentFallbacks[profile.id] = (reviewerAgentFallbacks[profile.id] || 0) + 1, reviewerAgentNames[profile.id] = profile.reviewerAgent;
}
const reviewerAgentSection = () => agentUnavailableSection(
  reviewerAgentUnavailable.map((x) => ({ agent: x.agent, what: `every ${x.id} lens`, error: x.error })),
  Object.entries(reviewerAgentFallbacks).filter(([id]) => !reviewerAgentUnavailable.some((x) => x.id === id)).flatMap(([id, n]) => {
    const agent2 = reviewerAgentNames[id] || `${id} reviewer agent`, nf = reviewerAgentNotFound[id];
    return [
      { agent: agent2, count: n - (nf?.count || 0), what: "lens dispatch(es)" },
      ...nf ? [{ agent: agent2, count: nf.count, what: "lens dispatch(es)", error: nf.error }] : []
    ];
  })
);
function out(reportText) {
  return `${telemetryLostSection(telemetryLost)}${reReviewMemorySection()}${reviewerAgentSection()}${reportText}${optionalSection()}${surfaceGateSection()}${memorySection(memory)}${priorDecisionsRefusedSection(priorDecisionsIn.refused)}`;
}
const LOGRUN_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["ok"],
  properties: {
    ok: { type: "boolean", description: "true only if the script ran and printed no craft-log-run FAILED line" },
    error: { type: "string", description: "when ok is false, the failing line verbatim; when ok is true AND the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise" }
  }
};
function loggerPrelude(craftRoot, version = "", repo = "") {
  const preamble = `CRAFT_REPO="$(cd ${shq(repo || ".")} 2>/dev/null && pwd -P)" || CRAFT_REPO=""
craft_usable() {   # a line that is exactly '}' at column 0 would end the extracted region early
  case "$1" in /*) ;; *) return 1 ;; esac
  [ -f "$1" ] || return 1
  [ -n "$CRAFT_REPO" ] || return 1   # belt to the braces below; see the note in the comment above
  # A repo of "/" contains everything, so nothing can be outside it. The pattern below cannot say
  # that: "$CRAFT_REPO"/* becomes //* and matches no ordinary path, so every candidate reads as
  # outside and the guard inverts into an allow-all. Degenerate input, but the whole point of this
  # predicate is that it fails closed.
  [ "$CRAFT_REPO" = "/" ] && return 1
  CRAFT_REAL="$1"
  CRAFT_HOPS=0
  while [ -L "$CRAFT_REAL" ]; do
    [ "$CRAFT_HOPS" -lt 16 ] || return 1
    CRAFT_LINK="$(readlink "$CRAFT_REAL")"
    case "$CRAFT_LINK" in
      /*) CRAFT_REAL="$CRAFT_LINK" ;;
      *) CRAFT_REAL="$(dirname "$CRAFT_REAL")/$CRAFT_LINK" ;;
    esac
    CRAFT_HOPS=$((CRAFT_HOPS + 1))
  done
  CRAFT_DIR="$(cd "$(dirname "$CRAFT_REAL")" 2>/dev/null && pwd -P)" || return 1
  [ -n "$CRAFT_DIR" ] || return 1
  CRAFT_REAL="$CRAFT_DIR/$(basename "$CRAFT_REAL")"
  case "$CRAFT_REAL" in
    "$CRAFT_REPO"/*|"$CRAFT_REPO") return 1 ;;
  esac
  return 0
 }
CRAFT_LOGGER=""
`, tryCandidate = (expr) => `if [ -z "\${CRAFT_LOGGER:-}" ]; then
  CRAFT_TRY=${expr}
  craft_usable "$CRAFT_TRY" && CRAFT_LOGGER="$CRAFT_REAL"
fi
`, explicit = craftRoot ? tryCandidate(`${shq(craftRoot)}"/lib/craft-log-run.mjs"`) : "", fromEnv = tryCandidate('"${CLAUDE_PLUGIN_ROOT:-}/lib/craft-log-run.mjs"'), installed = version ? tryCandidate(`"\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/"${shq(version)}"/lib/craft-log-run.mjs"`) : "";
  return `${preamble}${explicit}${fromEnv}${installed}[ -n "\${CRAFT_LOGGER:-}" ] || { echo "craft-log-run FAILED: no usable logger — no absolute craftRoot outside the reviewed repo, no CLAUDE_PLUGIN_ROOT, and no installed copy of "${version ? shq(version) : "'this version'"}" under the plugin cache; refusing to resolve against the reviewed repository"; exit 1; }
`;
}
function payloadVersion(payload) {
  return String((payload && typeof payload == "object" ? (
    /** @type {{ craftVersion?: unknown }} */
    payload.craftVersion
  ) : void 0) ?? "");
}
function engineRevisionFlag(payload) {
  const rev = payload && typeof payload == "object" ? (
    /** @type {{ workflowEngineRevision?: unknown }} */
    payload.workflowEngineRevision
  ) : void 0;
  return Number.isInteger(rev) ? `--engine-revision ${rev} ` : "";
}
function runDirFlags(dir, rejoin) {
  return `${dir ? `--dir ${shq(dir)} ` : ""}${rejoin ? "--rejoin " : ""}\${CLAUDE_CODE_SESSION_ID:+--session "$CLAUDE_CODE_SESSION_ID"} `;
}
function logRunPrompt({ record, craftRoot = "", repo = "", command = "write", dir = "", rejoin = !1 } = {}) {
  const version = payloadVersion(record), flags = runDirFlags(dir, rejoin);
  return `You are the craft observability logger. Persist ONE run record. This is mechanical IO — do not analyze, summarise, reformat or "clean up" any part of it.

Run exactly this:

\`\`\`
${loggerPrelude(craftRoot, version, repo)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-rec.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…RECORD below, byte for byte…
CRAFT_RECORD_EOF
cd ${shq(repo || ".")} && node "$CRAFT_LOGGER" ${command} ${engineRevisionFlag(record)}${flags}--project "$PWD" < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script computes every field (ts, project, commit, dirty, engineRevision, craftCommit, and — reading the working copy with git — branch and head, whose values in the record below are only a fallback for what git cannot resolve), names the file, appends the index line and verifies the readback. You compute NONE of that. In particular: do NOT \`mkdir\` the store, do NOT run \`date\`, \`pwd\` or \`git\` yourself, and do NOT append to index.jsonl by hand.

COPY THE RECORD VERBATIM into the quoted heredoc — it can be hundreds of KB (findings, ledger, dimensions), and re-emitting it from memory silently drops the big arrays. That is exactly how a completed review once persisted \`findings: 111\` with \`dimensions: []\` and no \`verification\`, destroying the per-lens telemetry the whole store exists for.

If the script prints a line starting \`craft-log-run FAILED\`, or the command itself fails (for example the logger path does not exist), return {"ok": false, "error": "<that line, or the shell error, verbatim>"} and stop — do NOT fall back to writing the file by hand. If it succeeded, return {"ok": true} — and if it ALSO printed a line starting \`craft-log-run WARNING\`, return {"ok": true, "error": "<that line verbatim>"}: the record landed, but something about the run directory did not, and the engine has to be able to say so. Best-effort either way: never error the run over this.

RECORD:
${JSON.stringify(record, null, 2)}`;
}
function logRunDispatch(record, { phase: phase2 = "" } = {}) {
  const payloadKB = JSON.stringify(record).length / 1024, big = payloadKB > 24;
  return {
    label: `log-run${big ? ` (${Math.round(payloadKB)}KB)` : ""}`,
    phase: phase2,
    schema: LOGRUN_SCHEMA,
    model: big ? "sonnet" : "haiku",
    effort: "low"
  };
}
function logRunOutcome(res) {
  const r = res && typeof res == "object" ? (
    /** @type {{ ok?: unknown, error?: unknown, __threw?: unknown }} */
    res
  ) : null;
  return r && r.ok === !0 ? { ok: !0, reason: String(r.error || "").trim() } : { ok: !1, reason: String(r && (r.__threw || r.error) || "the logger agent returned no result") };
}
function quietly(call) {
  return async (prompt, opts) => {
    try {
      return await call(prompt, opts);
    } catch (e) {
      return { __threw: String(e && /** @type {{ message?: unknown }} */
      e.message || e) };
    }
  };
}
function checkpointPrompt({ payload, craftRoot = "", repo = "", phase: phase2 = "", dir = "", rejoin = !1 } = {}) {
  const version = payloadVersion(payload), flags = `--phase ${shq(phase2)} ${engineRevisionFlag(payload)}${runDirFlags(dir, rejoin)}`;
  return `You are the craft observability logger writing ONE phase checkpoint. Mechanical IO — do not analyze.

Run exactly this, then return the runDir the script prints:

\`\`\`
${loggerPrelude(craftRoot, version, repo)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-ckpt.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…PAYLOAD below, byte for byte…
CRAFT_RECORD_EOF
cd ${shq(repo || ".")} && node "$CRAFT_LOGGER" checkpoint ${flags}--project "$PWD" < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script owns naming, sequencing and every computed field. Copy PAYLOAD verbatim into the quoted heredoc. Best-effort: if it fails, report the error line and do NOT retry by writing files yourself.

PAYLOAD:
${JSON.stringify(payload, null, 2)}`;
}
function makeRunLogger({ call, phase: phase2, target, noteLoss, prepare = (record) => record }) {
  return async (recordIn) => {
    const record = prepare(recordIn), landed = logRunOutcome(await call(logRunPrompt({ ...target(), record }), logRunDispatch(record, { phase: phase2 })));
    landed.ok ? landed.reason && noteLoss("the run directory (the record itself landed)", landed.reason, !0) : noteLoss("the run record", landed.reason, !1);
  };
}
function telemetryLossNoter(lost, say) {
  return (what, why, landed) => {
    lost.push(`${what} — ${why}`), say(landed ? `⚠️ telemetry: ${why}` : `⚠️ telemetry lost: ${what} — ${why}`);
  };
}
const LEDGER_SHARD_MAX_BYTES = 14336, LEDGER_SHARD_PHASE = "ledger", LEDGER_SHARD_MAX_SHARDS = 20, LEDGER_TOMBSTONE_MAX = 170 - 20;
function payloadBytes(item) {
  const pretty = JSON.stringify(item, null, 2);
  return typeof pretty != "string" ? 2 : pretty.length + pretty.split(`
`).length * 4 + 2;
}
function shardLedger(ledger, { max = LEDGER_SHARD_MAX_BYTES, maxShards = LEDGER_SHARD_MAX_SHARDS } = {}) {
  const items = Array.isArray(ledger) ? ledger : [];
  if (!items.length) return [];
  const groups = packLedgerGroups(items, max, maxShards);
  return groups.map((group, i) => ({
    ledgerShard: {
      index: i + 1,
      of: groups.length,
      total: items.length
    },
    ledgerItems: group
  }));
}
function packLedgerGroups(items, max, maxShards) {
  const groups = [];
  let bytes = 0;
  for (const item of items) {
    const size = payloadBytes(item);
    if (!groups.length || /** @type {unknown[]} */
    groups[groups.length - 1].length && bytes + size > max) {
      if (groups.length >= maxShards) break;
      groups.push([]), bytes = 0;
    }
    groups[groups.length - 1].push(item), bytes += size;
  }
  return groups;
}
function tombstoneRound(t) {
  const m = /round (\d+)/.exec(String(t && t.why || ""));
  if (m) return Number(m[1]);
  const r = Number(t && t.round);
  return Number.isFinite(r) ? r : 0;
}
function pruneTombstones(tombstones2, { max = LEDGER_TOMBSTONE_MAX } = {}) {
  const items = Array.isArray(tombstones2) ? tombstones2 : [], deduped = newestTombstonePerFp(items);
  return deduped.length <= max ? deduped : deduped.map((row) => ({ row, r: tombstoneRound(row) })).sort((a, b) => b.r - a.r).slice(0, max).map((d) => d.row);
}
function newestTombstonePerFp(items) {
  const newestByFp = /* @__PURE__ */ new Map(), noFp = [];
  for (const t of items) {
    if (!t || typeof t != "object") continue;
    if (!t.fp) {
      noFp.push(t);
      continue;
    }
    const prev = newestByFp.get(t.fp);
    (!prev || tombstoneRound(t) >= tombstoneRound(prev)) && newestByFp.set(t.fp, t);
  }
  return [...newestByFp.values(), ...noFp];
}
function tombstoneBudget(liveCount, { ceiling = LEDGER_TOMBSTONE_MAX } = {}) {
  const live = Math.max(0, Number(liveCount) || 0);
  return Math.max(0, ceiling - live);
}
const CHECKPOINT_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["runDir"],
  properties: {
    runDir: { type: "string", description: "the runDir the script printed; empty string if it failed" },
    error: { type: "string", description: "when runDir is empty, the failing line verbatim; when the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise" }
  }
};
let runDir = "", checkpointFailed = !1, rejoinArmed = !1;
async function checkpoint(phase2, payloadIn, group) {
  const payload = { kind: "workflow", name: "review", craftVersion: CRAFT_VERSION, ...payloadIn, workflowEngineRevision: ENGINE_REVISION }, asked = runDir, armRejoin = !runDir && checkpointFailed;
  armRejoin && (rejoinArmed = !0);
  const { answer: res, threw } = splitThrew(await ragentQuietly(
    checkpointPrompt({ payload, craftRoot: craftRootArg, repo: repoArg, phase: phase2, dir: runDir, rejoin: armRejoin }),
    { label: `checkpoint:${phase2}`, phase: group, schema: CHECKPOINT_SCHEMA, model: "haiku", effort: "low" }
  ));
  res?.runDir ? (asked && res.runDir !== asked && noteTelemetryLoss(`phase checkpoint '${phase2}'`, `the logger minted ${res.runDir} instead of the run's own ${asked} — earlier phase slices there will not be folded`), runDir = res.runDir) : (checkpointFailed = !0, noteTelemetryLoss(`phase checkpoint '${phase2}'`, threw || res?.error || "the logger agent returned no runDir"));
}
const logRun = makeRunLogger({
  // ragent underneath `quietly`, so the retry-once behaviour still applies to the record write.
  call: ragentQuietly,
  phase: "Synthesize",
  // `finalize`, not `write`: this is the one engine that checkpoints, so the script folds this run's
  // phase slices into the record it writes. Read at each call — `runDir` and `rejoinArmed` move as
  // the checkpoints run.
  target: () => ({ craftRoot: craftRootArg, repo: repoArg, command: "finalize", dir: runDir, rejoin: rejoinArmed }),
  // Every review record — the early exits too, not only reviewRecord() — says which engine computed its
  // fingerprints: a later round decides their basis by this (realm @nick/craft #111). Last, so no
  // caller's field shadows it.
  prepare: (recordIn) => ({ ...recordIn, workflowEngineRevision: ENGINE_REVISION }),
  // Into the same telemetryLost list the checkpoints and the prior-round read note into, but through
  // the shared note: a record that landed with its run directory refused is logged as landed, never
  // as lost (realm @nick/craft #39). makeRunLogger always hands it a non-empty reason, so the line kept
  // for the report is the one noteTelemetryLoss would keep.
  noteLoss: telemetryLossNoter(telemetryLost, log)
});
function key(f) {
  return `${(f.file || "").toLowerCase()}:${f.line || 0}:${(f.title || "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}
function titleShingle(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).sort().join(" ");
}
function normalizeSymbol(symbol) {
  let s = String(symbol || "").toLowerCase().replace(/\b(?:fn|impl)\s+/g, ""), prev;
  do
    prev = s, s = s.replace(/<[^<>]*>/g, "");
  while (s !== prev);
  return s.trim();
}
function fingerprint(f) {
  const k = f || {}, ruleId = k.ruleId || "", basis = ruleId ? [k.file || "", normalizeSymbol(k.symbol), ruleId].join("\0") : [k.file || "", normalizeSymbol(k.symbol), "", titleShingle(k.title)].join("\0");
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = (h << 5) + h + basis.charCodeAt(i) >>> 0;
  return h.toString(16).padStart(8, "0");
}
function shingleOverlap(a, b) {
  const sa = new Set(titleShingle(a).split(" ").filter(Boolean)), sb = new Set(titleShingle(b).split(" ").filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) sb.has(w) && inter++;
  return inter / Math.max(sa.size, sb.size);
}
function matchesPrior(cur, prior, { threshold = 0.6 } = {}) {
  const field = (n) => [cur?.[n] || "", prior?.[n] || ""], [curFile, priorFile] = field("file");
  if (curFile !== priorFile) return !1;
  const [curRule, priorRule] = field("ruleId");
  if (curRule !== priorRule) return !1;
  const [curSymbol, priorSymbol] = field("symbol");
  return curSymbol && priorSymbol && curSymbol !== priorSymbol ? !1 : shingleOverlap(cur?.title, prior?.title) >= threshold;
}
function rereviewVerdict({ stillOpen = [], regressed = [], neu = [] } = {}) {
  return reviewVerdict([...stillOpen, ...regressed, ...neu]);
}
function reReviewMemory(priorReason2) {
  const reason = priorReason2 || null;
  return { chained: !reason, reason, note: reason === "no-branch" ? "Re-review memory is OFF: this run has no branch to chain review rounds on (usually a detached HEAD). Findings will not carry forward across runs. Check out a branch and re-review on it to enable round-to-round memory." : null };
}
function branchFromAbbrevRef(ref) {
  return ref === "HEAD" ? "" : ref;
}
const ENGINE_REVISION = 4, FP_BASIS_SINCE = [1, 3];
function fpBasisOf(rev) {
  return !Number.isInteger(rev) || /** @type {number} */
  rev < 1 ? null : Math.max(...FP_BASIS_SINCE.filter((b) => b <= /** @type {number} */
  rev));
}
function fpBasisEstablished(priorRev, currentRev = ENGINE_REVISION) {
  return Number.isInteger(priorRev) && /** @type {number} */
  priorRev >= 1 && /** @type {number} */
  priorRev <= currentRev;
}
function sameFpBasis(priorRev, currentRev = ENGINE_REVISION) {
  if (Number.isInteger(priorRev) && /** @type {number} */
  priorRev > currentRev) return !1;
  const prior = fpBasisOf(priorRev);
  return prior !== null && prior === fpBasisOf(currentRev);
}
function basisVerdictFromRevisions(revs, currentRev = ENGINE_REVISION) {
  const list = Array.isArray(revs) ? revs : [];
  return !list.length || !list.every((r) => fpBasisEstablished(r, currentRev)) ? { sameFpBasis: !1, fpBasisKnown: !1 } : new Set(list.map(fpBasisOf)).size !== 1 ? { sameFpBasis: !1, fpBasisKnown: !1 } : { sameFpBasis: fpBasisOf(list[0]) === fpBasisOf(currentRev), fpBasisKnown: !0 };
}
function ledgerTruncated(priorRound2) {
  if (!priorRound2) return !1;
  const count = Number(priorRound2.ledgerCount);
  return Number.isFinite(count) ? count !== (Array.isArray(priorRound2.ledger) ? priorRound2.ledger.length : 0) : !1;
}
function ledgerDegraded(priorRound2) {
  if (!priorRound2) return !1;
  if (ledgerTruncated(priorRound2)) return !0;
  const findings = Number(priorRound2.priorFindings || 0), ledgerLen = Array.isArray(priorRound2.ledger) ? priorRound2.ledger.length : 0;
  return findings > 0 && ledgerLen === 0;
}
function shouldFullRescan({ priorRound: priorRound2, thisRound: thisRound2, fullEvery: fullEvery2, degraded, journalSourced }) {
  if (!priorRound2 || degraded || journalSourced) return !0;
  const n = Number(fullEvery2);
  return !Number.isFinite(n) || n < 1 ? !1 : Number(thisRound2) % n === 0;
}
function isToolSource(profile, source) {
  return !(source !== void 0 && profile.lenses.includes(source) || source === "negative-space" || source === "dep-context");
}
phase("Scout");
async function ambiguousPathExit() {
  const msg = `path=${ambiguousPath} is an absolute path and no \`repo\` was given, so it is ambiguous: it could name the REPOSITORY to review (pass it as \`repo\`) or a directory INSIDE the repository to narrow to (pass it relative to the repo root). Nothing ran — re-dispatch with one of those two spellings.`;
  return await logRun({
    schemaVersion: 1,
    runtime: "claude-code",
    craftVersion: CRAFT_VERSION,
    kind: "workflow",
    name: "review",
    nested: !!viaArg,
    via: viaArg || null,
    languages: [],
    verdict: "INCOMPLETE (ambiguous path)",
    findings: summarizeFindings([]),
    dimensions: [],
    verification: null,
    // The CLASS, not this run's path — `notRun` is ranked by exact string (see `scopeNotRun`).
    // The path itself is in the verdict prose below, where nothing ranks it.
    uncoveredFiles: [],
    notRun: ["an absolute `path` with no `repo` — ambiguous scope, nothing ran"],
    outputTokens: budget.spent()
  }), out(["## Verdict", `⚠️ INCOMPLETE — ${msg}`].join(`
`));
}
async function detectDiedExit() {
  return await logRun({
    schemaVersion: 1,
    runtime: "claude-code",
    craftVersion: CRAFT_VERSION,
    kind: "workflow",
    name: "review",
    nested: !!viaArg,
    via: viaArg || null,
    languages: [],
    verdict: "INCOMPLETE (detect died)",
    findings: summarizeFindings([]),
    dimensions: [],
    verification: null,
    notRun: ["base/changed-files detection", ...scopeNotRun],
    outputTokens: budget.spent()
  }), out(["## Verdict", "⚠️ INCOMPLETE — the base-resolution agent died twice (API error); nothing was reviewed. Re-run the review."].join(`
`) + scopeSection());
}
async function detectChanges() {
  if (ambiguousPath) return { exit: await ambiguousPathExit(), detected: null };
  const detected2 = await ragent(
    `You are resolving the review base and the changed files. Use shell + read only — do NOT review.${pathArg ? `

SCOPE: consider ONLY files under ${shq(pathArg)}; pass \`-- ${shq(pathArg)}\` to the git commands below.` : ""}
1. Resolve the diff base. ${baseArg ? `Use \`${baseArg}\`.` : "Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those."}
2. List the changed file paths: \`git diff --name-only <base>...HEAD\`${pathArg ? ` -- ${shq(pathArg)}` : ""} (and include uncommitted changes from \`git status --porcelain\` if the tree is dirty).
3. Capture the VERBATIM change description as \`spec\` — the authors' own written claims/invariants, checked against code later. If the current branch has an OPEN PR, run \`gh pr view --json body,title\` and use its title + body. Otherwise use the commit messages on the diff range: \`git log <base>..HEAD --format=%B\`. Do not summarize or paraphrase — copy the text as-is. Truncate to ~4000 chars. Empty string if there is no PR and no commit body (e.g. only uncommitted changes). If \`gh\` is missing/unauthenticated, fall through to the commit messages.
4. Capture \`branch\` = \`git rev-parse --abbrev-ref HEAD\` (empty string if detached) and \`head\` = \`git rev-parse --short HEAD\` (empty string if not a git repo). These two are a FALLBACK only: the logger reads both off the working copy with git at the moment a record is written, and its values win. Do not work to fill them — an empty string is a fine answer.
Return baseRef (the ref you resolved, empty string if none), files (the changed paths), spec (the verbatim description), branch, and head.`,
    { label: "detect", schema: DETECT_SCHEMA, model: "haiku", effort: "low" }
  );
  return detected2 ? { exit: null, detected: detected2 } : { exit: await detectDiedExit(), detected: null };
}
const detection = await detectChanges();
if (detection.exit !== null) return detection.exit;
const detected = detection.detected;
function detectedChange(detected2) {
  const baseRef2 = detected2.baseRef ?? baseArg, changedFiles2 = (Array.isArray(detected2.files) ? detected2.files : []).map(decodeGitPath), spec2 = (typeof detected2.spec == "string" ? detected2.spec : "").slice(0, 4e3), branch2 = branchFromAbbrevRef((typeof detected2.branch == "string" ? detected2.branch : "").trim()), head2 = (typeof detected2.head == "string" ? detected2.head : "").trim();
  return { baseRef: baseRef2, changedFiles: changedFiles2, spec: spec2, branch: branch2, head: head2 };
}
const { baseRef, changedFiles, spec, branch, head } = detectedChange(detected);
async function recallMemory() {
  if (memory.source !== "none" || !changedFiles.length) return;
  const r = await recallDecisions((p) => ragent(p, { label: "memory-recall", phase: "Scout", schema: MEMORY_RECALL_SCHEMA, effort: "low" }), changedFiles, baseRef || "");
  priorDecisionsIn = parsePriorDecisions(r.decisions), memory = acceptedMemory(r.memory, priorDecisionsIn.decisions.length);
  for (const x of priorDecisionsIn.refused) log(`⚠️ priorDecisions: ${x}`);
}
await recallMemory();
async function loadPriorRound() {
  let priorRound2 = null, priorReason2 = freshArg ? "fresh" : viaArg ? "nested" : null;
  return !freshArg && viaArg && log(`Nested run (via ${viaArg}) — the round chain is the top-level run's: not read, and this run's row is not a candidate round for anyone (its siblings in the fan-out share this project and branch)`), !freshArg && !viaArg && ({ priorRound: priorRound2, priorReason: priorReason2 } = await readPriorRound(priorReason2)), announcePriorRound(priorRound2), { priorRound: priorRound2, priorReason: priorReason2 };
}
async function readPriorRound(priorReason2) {
  let priorReadThrew = "", priorRound2 = await ragentQuietly(
    `You are the craft prior-round loader. This is mechanical IO — you DECIDE nothing: selecting the round, checking ancestry and reading the record are all done by the script.

Run exactly this:

\`\`\`
${loggerPreludeNow()}cd ${shq(repoArg || ".")} && node ${LOGGER_PATH} prior-round --branch ${shq(branch)} \${CLAUDE_CODE_SESSION_ID:+--session "$CLAUDE_CODE_SESSION_ID"} --project "$PWD"
\`\`\`

It prints ONE line of JSON and always exits 0. Return that object VERBATIM — copy the \`ledger\` array byte for byte, do not summarize, re-key, truncate or "clean up" any entry. It prints \`ledgerCount\` alongside \`ledger\` — copy that number EXACTLY as printed; never recount, never adjust it to the array you are returning. Copy \`sameFpBasis\` exactly as printed too — it decides whether this round may compare fingerprints with the last one, and a dropped or flipped value loses the loop's memory. If the printed object has no \`sameFpBasis\`, leave it out; never invent one. The same holds for \`fpBasisKnown\`, \`priorFpRevisions\` (copy that array exactly) and \`priorFpRevisionsCheck\`. If the command prints nothing or cannot run, return {found:false, round:0, head:"", ledger:[], ledgerCount:0, priorFindings:0, journalSourced:false, sameFpBasis:false, fpBasisKnown:false, reason:"loader-did-not-run"}.`,
    { label: "prior-round", schema: PRIOR_ROUND_SCHEMA, model: "haiku", effort: "low", phase: "Scout" }
  ).then((res) => {
    const { answer, threw } = splitThrew(res);
    return priorReadThrew = threw, answer;
  });
  return priorRound2?.found || (priorReason2 = rejectedPriorReason(priorRound2, priorReadThrew), priorRound2 = null), priorRound2 && !isCommitish(priorRound2.head) && (log(`⚠️ prior-round head ${JSON.stringify(priorRound2.head)} is not a safe commit-ish — falling back to the base ref for the fix-range diff`), priorRound2.head = baseRef), { priorRound: priorRound2, priorReason: priorReason2 };
}
function rejectedPriorReason(priorRound2, priorReadThrew) {
  const priorReason2 = priorRound2?.reason || "no-prior-round";
  return priorRound2?.reason && log(`No prior round: ${priorRound2.reason}`), notePriorReadFailure(priorRound2, priorReadThrew), priorReason2;
}
function notePriorReadFailure(priorRound2, priorReadThrew) {
  (!priorRound2 || priorReadThrew || ["loader-did-not-run", "git-unavailable"].some((r) => String(
    /** @type {PriorRound} */
    priorRound2.reason || ""
  ).startsWith(r))) && noteTelemetryLoss("the prior-round ledger", priorReadThrew || priorRound2?.reason || "the loader agent returned no result");
}
function announcePriorRound(priorRound2) {
  priorRound2 && ledgerTruncated(priorRound2) && log(`⚠️ prior-round ledger arrived TRUNCATED: the loader printed ${priorRound2.ledgerCount} entr(ies), ${priorRound2.ledger?.length || 0} survived transport — treating the round as degraded and forcing a full re-scan.`), priorRound2 ? log(`Re-review: prior round ${priorRound2.round} @ ${flattenField(priorRound2.head)} · ${priorRound2.ledger?.length || 0} ledger finding(s)`) : log(freshArg ? "Fresh review (—fresh): prior round ignored" : "First review for this branch (no prior round)");
}
const { priorRound, priorReason } = await loadPriorRound(), reReview = reReviewMemory(priorReason);
function applyReReviewNote() {
  reReview.note && (reReviewMemoryNote = reReview.note, log(`⚠️ ${reReview.note}`));
}
applyReReviewNote();
const thisRound = roundNumber();
function roundNumber() {
  return priorRound ? (priorRound.round || 1) + 1 : 1;
}
const relayedVerdict = relayedVerdictOf();
function relayedVerdictOf() {
  return priorRound && typeof priorRound.sameFpBasis == "boolean" ? { sameFpBasis: priorRound.sameFpBasis, fpBasisKnown: priorRound.fpBasisKnown } : null;
}
const relayedRevisions = relayedRevisionsOf();
function relayedRevisionsOf() {
  return priorRound && Array.isArray(priorRound.priorFpRevisions) ? priorRound.priorFpRevisions : null;
}
const relayedCheck = relayedCheckOf();
function relayedCheckOf() {
  return priorRound && typeof priorRound.priorFpRevisionsCheck == "string" ? priorRound.priorFpRevisionsCheck : null;
}
const priorBasisMismatch = basisMismatchOf();
function basisMismatchOf() {
  return !!priorRound && (relayedRevisions ? (relayedCheck ?? (relayedRevisions.length ? null : "")) !== relayedRevisions.join(",") : relayedCheck !== null);
}
const engineFromRevisions = engineBasisOf();
function engineBasisOf() {
  return !priorBasisMismatch && relayedRevisions ? basisVerdictFromRevisions(relayedRevisions) : null;
}
const basisOverridesLogger = basisOverridesLoggerOf();
function basisOverridesLoggerOf() {
  return !!(engineFromRevisions && relayedVerdict && (engineFromRevisions.sameFpBasis !== relayedVerdict.sameFpBasis || engineFromRevisions.fpBasisKnown !== relayedVerdict.fpBasisKnown));
}
function logBasisRelay() {
  priorBasisMismatch && log(`⚠️ prior-round revisions arrived altered (list ${JSON.stringify(relayedRevisions)}, check ${JSON.stringify(relayedCheck)}) — the fingerprint basis is treated as unknown`), basisOverridesLogger && log(`Re-review: this engine's fingerprint-basis verdict on revisions ${JSON.stringify(relayedRevisions)} (${JSON.stringify(engineFromRevisions)}) overrides the logger's (${JSON.stringify(relayedVerdict)}) — their tables differ`);
}
logBasisRelay();
const priorBasis = priorBasisOf();
function priorBasisOf() {
  return priorRound ? priorBasisMismatch ? { sameFpBasis: !1, fpBasisKnown: !1 } : engineFromRevisions || relayedVerdict : null;
}
const priorFpComparable = fpComparableOf();
function fpComparableOf() {
  return priorBasis ? priorBasis.sameFpBasis === !0 : !1;
}
const priorBasisVerdict = basisVerdictOf();
function basisVerdictOf() {
  return priorBasis ? priorBasis.sameFpBasis === !1 && priorBasis.fpBasisKnown !== !0 ? "unknown" : priorBasis.sameFpBasis : "absent";
}
let tombstonesDroppedForBasis = 0;
const priorLedgerDegraded = ledgerDegraded(priorRound);
function warnLedgerDegraded() {
  priorLedgerDegraded && log(`⚠️ Re-review DEGRADED: prior round ${/** @type {PriorRound} */
  priorRound.round} reported ${/** @type {PriorRound} */
  priorRound.priorFindings} finding(s) but persisted NO ledger — the adjudicate track has nothing to carry or re-verify. Forcing a full base...HEAD re-scan this round; if results still look thin, re-run with {fresh:true}.`);
}
warnLedgerDegraded();
const priorRoundJournalSourced = journalSourcedOf();
function journalSourcedOf() {
  return !!priorRound?.journalSourced;
}
function warnJournalSourced() {
  priorRoundJournalSourced && log(`⚠️ Re-review round reconstructed from what a STOPPED run left behind (its journal, or its surviving phase checkpoints): prior round ${/** @type {PriorRound} */
  priorRound.round}'s head ${flattenField(
    /** @type {PriorRound} */
    priorRound.head
  )} is where that run stopped, not a completed round's head — it may equal this run's HEAD if no fix landed yet. Forcing a full base...HEAD re-scan this round rather than risk an empty head...HEAD diff.`);
}
warnJournalSourced();
const fullRescan = shouldFullRescan({ priorRound, thisRound, fullEvery, degraded: priorLedgerDegraded, journalSourced: priorRoundJournalSourced }), lensBase = lensScope();
function lensScope() {
  const lensBase2 = priorRound && !fullRescan ? priorRound.head : baseRef;
  return priorRound && log(`Re-review round ${thisRound} lens scope: ${fullRescan ? `FULL base...HEAD re-scan (fullEvery=${fullEvery}${priorLedgerDegraded ? ", ledger degraded" : ""}${priorRoundJournalSourced ? ", prior round journal-sourced" : ""}) — earlier misses in untouched code are re-checked` : `incremental delta ${flattenField(priorRound.head)}...HEAD (fix commits only)`}`), lensBase2;
}
const { pinned: pinnedLangs, unknown: unknownLangs } = resolveProfilePin(PROFILES, requestedLangs);
async function unknownPinExit() {
  const msg = unknownPinMessage(PROFILES, unknownLangs);
  return await logRun({
    schemaVersion: 1,
    runtime: "claude-code",
    craftVersion: CRAFT_VERSION,
    kind: "workflow",
    name: "review",
    nested: !!viaArg,
    via: viaArg || null,
    languages: [],
    verdict: "INCOMPLETE (unknown language pin)",
    findings: summarizeFindings([]),
    dimensions: [],
    verification: null,
    notRun: [`nothing ran — ${msg}`, ...scopeNotRun],
    outputTokens: budget.spent()
  }), out(["## Verdict", `⛔ INCOMPLETE — ${msg}. NOTHING WAS REVIEWED; fix the \`languages\` argument and re-run.`].join(`
`) + scopeSection());
}
const detectedActive = Object.values(PROFILES).filter((p) => (!pinnedLangs || pinnedLangs.includes(p.id)) && p.detect(changedFiles)), coverage = resolveCoverage({ profiles: PROFILES, changedFiles, detectedActive, pinnedLangs }), active = coverage.active;
async function coverageExit() {
  return coverage.outcome === "empty" ? emptyDiffExit() : coverage.outcome === "nothing-to-review" ? nothingToReviewExit() : coverage.outcome === "no-profile" ? noProfileExit() : null;
}
async function emptyDiffExit() {
  const emptyMsg = noChangedFilesMessage();
  return await logRun({
    schemaVersion: 1,
    runtime: "claude-code",
    craftVersion: CRAFT_VERSION,
    kind: "workflow",
    name: "review",
    nested: !!viaArg,
    via: viaArg || null,
    languages: [],
    verdict: "INCOMPLETE (empty diff)",
    findings: summarizeFindings([]),
    dimensions: [],
    verification: null,
    uncoveredFiles: [],
    notRun: [emptyMsg, ...scopeNotRun],
    outputTokens: budget.spent()
  }), out([
    "## Verdict",
    `⚠️ INCOMPLETE — ${emptyMsg}`,
    "",
    "## Detected",
    detected?.notes || `0 changed file(s) against ${baseRef || "HEAD"}`
  ].join(`
`) + scopeSection());
}
async function nothingToReviewExit() {
  const okMsg = nothingToReviewMessage(changedFiles.length);
  return await logRun({
    schemaVersion: 1,
    runtime: "claude-code",
    craftVersion: CRAFT_VERSION,
    kind: "workflow",
    name: "review",
    nested: !!viaArg,
    via: viaArg || null,
    languages: [],
    verdict: "Approve (nothing to review)",
    findings: summarizeFindings([]),
    dimensions: [],
    verification: null,
    uncoveredFiles: changedFiles,
    notRun: [...scopeNotRun],
    outputTokens: budget.spent()
  }), out([
    "## Verdict",
    `✅ Approve (NOTHING TO REVIEW) — ${okMsg}`,
    "",
    "## Detected",
    detected?.notes || `${changedFiles.length} changed file(s)`,
    "",
    "## Not reviewed (nothing reviewable in them)",
    ...changedFiles.map((f) => `- ${f}`)
  ].join(`
`) + scopeSection());
}
async function noProfileExit() {
  const msg = noLanguageMessage(PROFILES, changedFiles.length, coverage.material.length);
  return await logRun({
    schemaVersion: 1,
    runtime: "claude-code",
    craftVersion: CRAFT_VERSION,
    kind: "workflow",
    name: "review",
    nested: !!viaArg,
    via: viaArg || null,
    languages: [],
    verdict: "INCOMPLETE (no language profile)",
    findings: summarizeFindings([]),
    dimensions: [],
    verification: null,
    uncoveredFiles: changedFiles,
    notRun: [msg, ...scopeNotRun],
    outputTokens: budget.spent()
  }), out([
    "## Verdict",
    `⚠️ INCOMPLETE — ${msg}`,
    "",
    "## Detected",
    detected?.notes || `${changedFiles.length} changed file(s)`,
    ...changedFiles.length ? ["", "## Not reviewed (no language profile)", ...changedFiles.map((f) => `- ${f}`)] : []
  ].join(`
`) + scopeSection());
}
const languageStop = unknownLangs.length ? await unknownPinExit() : await coverageExit();
if (languageStop !== null) return languageStop;
function logActiveProfiles() {
  log(`Active profiles: ${active.map((p) => p.id).join(", ")}${pinnedLangs ? ` (pinned: ${pinnedLangs.join(",")})` : ""} · base ${baseRef || "HEAD"}`);
}
logActiveProfiles();
const uncoveredFiles = changedFiles.filter((f) => !active.some((p) => p.detect([f]))), uncoveredGap = coverageGapFiles(uncoveredFiles);
function logUncoveredFiles() {
  uncoveredFiles.length && log(`Outside all active profiles (not reviewed): ${uncoveredFiles.join(", ")}${uncoveredGap.length ? ` — ${uncoveredGap.length} unreviewed source file(s)` : " (docs/assets/lockfiles/project config only — not a coverage gap)"}`);
}
logUncoveredFiles();
function scoutPrompt(profile) {
  return `You are scouting a ${profile.lang} diff to plan an elastic review. Use shell + read only — do NOT review yet.${pathArg ? `

SCOPE: review ONLY the crate/dir at \`${flattenField(pathArg)}\`. Pass \`-- ${shq(pathArg)}\` to every \`git diff\` command below.` : ""}

Diff base: ${lensBaseLabel()}. Consider only this profile's files (${profile.diffGlobs.join(" ")}).
1. Inspect \`git diff --stat ${lensBase ? `${shq(lensBase)}...HEAD` : "HEAD"} -- ${profile.diffGlobs.join(" ")}\`. Set sizeBucket:
   small = a few files / < ~80 changed lines; large = many files / > ~400 lines or a public-API-heavy change; medium otherwise.
2. lenses: choose from ${JSON.stringify(profile.lenses)}.
   - small: only the touched categories (minimum 2; always include the dominant category, and include '${profile.safetyLens}' unless the diff clearly touches nothing related to ${profile.securityHints}).
   - medium: the categories plausibly in play.
   - large: all of them, EXCEPT ${JSON.stringify(profile.lenses.filter((l) => CONDITIONAL_LENSES.includes(l)))} — the
     engine adds those itself off a code signal in the diff, so picking one here only pays for an
     agent the signal did not ask for. Do not count them toward your choices.
   ${profile.scoutRules}${strict ? `
   STRICT MODE is on: ALWAYS include 'maintainability' in lenses regardless of size.` : ""}
3. isLibrary: ${profile.usesLibrary ? "true if this is a published library (has `[lib]`/looks publishable) — best effort." : "always false (not applicable to this language)."}
4. securitySensitive: true if the diff touches ${profile.securityHints}.
5. intent: ${intentArg ? `the caller provided: "${intentArg}". Refine it from the diff if needed.` : "infer the change's purpose from the diff and any PR/commit messages; empty string if unclear."}
6. churn: list up to 5 files in the diff that git shows as frequently changed (\`git log --oneline -n 50 -- <file> | wc -l\` is a rough proxy). May be empty.
7. surfaces: classify what the diff TOUCHES so the engine can skip a whole-repo lens whose defect class this diff cannot exhibit. Answer CONSERVATIVELY — if unsure, OMIT the field (or the individual key), or set it true; NEVER guess false. A false you are not sure of silences a lens.
   - crossBoundarySymbol: does the diff change the signature/shape of an exported/\`pub\` symbol that unchanged code depends on?
   - wireForm: does it change a contract that a party running ANOTHER version reads, calls or deploys against — a CRD schema or API version list, a serde type, an HTTP/OpenAPI shape, a protocol, a CLI flag / exit code / output format, a config key, an env var, a Helm value, a default, a renamed exported name?
   - invariantType: does it change a type that carries an invariant other code relies on?`;
}
function negativeSpacePrompt(priorSummary, profile, plan) {
  const intent = plan?.intent ?? intentArg;
  return `You are the **negative-space** review lens for a ${profile.lang} change. Unlike the other lenses, your job is NOT to review the changed lines — it is to find the bug the diff ENABLES in code it did NOT touch. ${profile.navSkill ? `Load the ${profile.navSkill} skill for whole-repo search; use` : "Use"} Grep/Glob across the ENTIRE tree, not just the diff.

Diff base: ${lensBaseLabel()}.
${intent ? `INTENT (what the change should do): ${intent}` : ""}
${plan?.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — an invariant the author claims here may be broken by the UNCHANGED code you inventory below):
"""
${plan.spec}
"""` : ""}

METHOD — follow in order:
1. Inventory the NEW surface the diff introduces. Read the FULL diff: \`git diff ${lensDiffRange()}\`. List every new: ${profile.lang === "Nix" ? "flake output / module option / package attr / overlay / renamed binding" : "enum variant / status value / DB column / table / migration / public fn / route / struct field"}. ALSO list any UNCHANGED definition the diff now references or relies on for the first time.
2. For EACH item, Grep the UNCHANGED tree for existing code that reads, references, ${profile.lang === "Nix" ? "imports, or overrides" : "lists, updates, deletes, cascades, serializes, orders, or authorizes"} that shape. Ask: does this pre-existing path violate an invariant the change assumes?
3. Report each concrete violation ANCHORED TO THE UNCHANGED file:line that is actually wrong, not the diff line. That anchor is real — cite it precisely so it can be verified.

Only report a violation you can name a concrete reachable path for. Put the triggering surface in \`blastRadius\`; in \`why\`, state the invariant and the exact old path that breaks it. Do NOT restate findings already in the ALREADY-FOUND set below — look for what they MISSED.

ALREADY-FOUND (from other lenses / earlier rounds — do not repeat):
${priorSummary}

Return {lens: "negative-space", findings: [...]} using the shared finding schema. Set \`ruleId\` to the matching ${profile.rubricSkill} rules.md ID or "" if none fits. Observability: the workflow records this run — do NOT write your own record.`;
}
function lensBaseLabel() {
  return lensBase ? `\`${flattenField(lensBase)}\`` : "uncommitted changes / most recent commit";
}
function lensDiffRange() {
  return lensBase ? `--merge-base ${shq(lensBase)}` : "HEAD";
}
function lensPathspec(slice, profile) {
  return slice ? slice.files.map(pathspecLiteral).filter(Boolean).map(shq).join(" ") : profile.diffGlobs.join(" ");
}
function strictMaintainabilityLine(lens) {
  return strict && lens === "maintainability" ? `
STRICT MODE: apply the maintainability bar as a *presumption of block* — each maintainability issue is a blocker unless the author clearly justified it in the diff or brief. Be harsh, but stay grounded — every finding still needs a concrete cited file:line and survives refutation; do not invent issues.
` : "";
}
function sliceBlock(slice) {
  return slice ? `YOUR SLICE: \`${slice.key}\` — ${slice.files.length} changed file(s) of a larger diff. Sibling lenses hold the rest, and overlapping findings are de-duplicated downstream.
This bounds WHAT YOU JUDGE, never what you may READ: trace definitions, uses and consumers anywhere in the repository, and pin every off-site premise in \`whereChecked\` exactly as usual. A defect whose evidence sits outside your slice is still yours to report if it is CAUSED by a line in your slice — say so in \`why\`. A defect located in another slice is not yours; do not report it.
EFFICIENCY: pull your slice's diff ONCE, in one command. Do not re-run broad searches over the whole tree — every turn re-reads everything already in your context, so a wide grep is paid for again on each turn that follows it.` : "";
}
function reReviewBlock() {
  return priorRound ? fullRescan ? `RE-REVIEW (full re-scan): review the WHOLE diff (base ${flattenField(lensBase)}...HEAD), not just the latest fixes — an earlier round may have missed a defect in code it did not touch. Prior findings are adjudicated separately and any you re-surface are de-duplicated downstream, so spend your effort on defects that are NOT already obviously known.` : `RE-REVIEW: you are reviewing ONLY the fix commits since the prior round (base ${flattenField(lensBase)}). Prior findings are adjudicated separately — do not re-report them; surface only NEW defects the fixes introduced.` : "";
}
function lensPlanLines(plan) {
  return `${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ""}
${plan.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — treat as the spec; the intent lens must check EACH claim against the code, and any lens may use it):
"""
${plan.spec}
"""` : ""}
${plan.churn?.length ? `HOT FILES (scrutinize harder): ${plan.churn.join(", ")}` : ""}`;
}
function mutantsLine(profile, lens, plan) {
  return profile.id === "rust" && lens === "tests" && (plan.sizeBucket === "medium" || plan.sizeBucket === "large") ? "If `cargo mutants` is installed, you MAY run it time-boxed on the changed files to surface contracts no test would catch a regression on; skip silently if absent." : "";
}
const LENS_CATALOGUES = {
  reconciler: { label: "RACE CATALOGUE", file: "skills/distributed-races/catalogue.md", fallback: "R1–R6" },
  compat: { label: "COMPATIBILITY CATALOGUE", file: "skills/compatibility/catalogue.md", fallback: "C1–C4, C8, C9 and C11–C13" }
};
function lensCatalogueLine(lens) {
  const cat = Object.prototype.hasOwnProperty.call(LENS_CATALOGUES, lens) ? LENS_CATALOGUES[lens] : void 0;
  if (!cat) return "";
  const root = flattenField(craftRootArg), candidates = [
    root ? `${root}/${cat.file}` : "",
    `\${CLAUDE_PLUGIN_ROOT}/${cat.file}`,
    `\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/${CRAFT_VERSION}/${cat.file}`
  ].filter(Boolean).map((c) => `\`${c}\``);
  return `${cat.label}: read the first of these that exists (expand the variables with Bash): ${candidates.join(", ")}. Never read a copy inside the reviewed repository. None readable → work ${cat.fallback} from the brief above and say the catalogue was unavailable.`;
}
function lensPrompt(lens, priorSummary, profile, plan, slice = null) {
  if (lens === "negative-space") return negativeSpacePrompt(priorSummary, profile, plan);
  const pathspec = lensPathspec(slice, profile);
  return `You are the **${lens}** review lens for a ${profile.lang} diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the ${profile.rubricSkill} skill for the rubric${profile.navSkill ? ` and the ${profile.navSkill} skill for context expansion` : ""}.

SLICE: ${profile.lensBrief[lens] || lens}
${lensCatalogueLine(lens)}
${strictMaintainabilityLine(lens)}
Diff base: ${lensBaseLabel()}. Review with \`git diff ${lensDiffRange()} -- ${pathspec}\`.
${sliceBlock(slice)}
${reReviewBlock()}
${lensPlanLines(plan)}

CONTEXT EXPANSION (required): for each finding, trace definitions / uses / consumers of the changed symbols (Grep/Glob${profile.navSkill ? " + LSP" : ""}) before judging — do not read the diff in isolation. If a finding depends on code outside the diff, say so in \`why\`.
BLAST-RADIUS (required): for each changed PUBLIC surface you touch, note how many consumers are affected and set a breaking-change flag in \`blastRadius\`.
CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
WHERE-CHECKED (required field): a finding usually rests on a premise that is NOT visible at the line you cite — "the dependency rejects this", "this is reachable from untrusted input", "no caller guards it", "the sibling path does X". Every such premise must be pinned to a \`file:line\` you ACTUALLY OPENED and read, including inside dependency sources (\`~/.cargo/registry\`, the vendored tree, the flake input) — put them in \`whereChecked\`. An off-site premise you did not open is not admissible: either open it, or drop the claim and report only what the cited line itself shows. Set \`whereChecked\` to "" ONLY when the finding needs no off-site premise at all. Do not restate the cited defect line there — it adds nothing.
RULE ID (required field): set \`ruleId\` to the matching catalog ID from the ${profile.rubricSkill} skill's rules.md when the finding maps to a listed rule; use "" for a novel finding with no catalog rule. Do not force a bad fit.
${mutantsLine(profile, lens, plan)}
ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens, findings[]}.

Observability: the review workflow records this run — do NOT write your own record.`;
}
function verifyPrompt(f, idx, isTool, gateProvenance, profile) {
  const pf = promptFields(f), src = sanitizeAttack(f.source), why = sanitizeAttack(f.why), exclusionCatalog = exclusionCatalogText(profile), head2 = verifyHead(isTool, idx, src), at = `${pf.file || "?"}:${f.line || 0}`;
  return `${head2}

FINDING: [${pf.severity}] ${pf.title}
  at ${at}
  why: ${why}
  source: ${src}${f.ruleId ? ` · rule ${pf.ruleId}` : ""}
  off-site evidence claimed: ${f.whereChecked ? pf.whereChecked : "(none — the finding claims to be self-contained at the cited line)"}

MECHANICAL CHECK FIRST: if a tool can decide this finding (a clippy lint, statix/deadnix rule, semgrep rule, cargo-audit advisory — infer from source/ruleId/title), RUN it scoped to the cited file; its output overrides your judgement in BOTH directions: tool still reports it → refuted=false; tool demonstrably no longer reports it → refuted=true (quote the output in reason).${gateProvenance ? ` The gate invoked the tools as: "${flattenField(gateProvenance)}" — if a tool is not on PATH, reproduce the gate's invocation (e.g. \`nix run nixpkgs#<tool> --\`) before declaring it unrunnable.` : ""}${isTool ? " If you STILL cannot run the tool, set refuted=false — an unverifiable tool finding stays alive." : " If no tool applies, judge it yourself."}

REFUTATION RULE: refuted=true means the finding's TECHNICAL CLAIM is false — the cited code does not contain the claimed defect, or the deciding tool demonstrably no longer reports it. Context is NOT refutation: that the code is test/fixture/example-only, looks intentional, is unlikely to be built or run, or has low impact NEVER justifies refuted=true. Record that context in reachable=false and reason instead — severity is calibrated downstream.

${exclusionCatalog}Open the cited file and check:
1. citedLineMatches: does ${at} actually contain what the finding claims? (If the citation is wrong/hallucinated → citedLineMatches=false.)
2. reachable: is this code reachable in production, or is it test/example/fixture-only code? (Test-only → reachable=false. This does NOT refute the finding — it only calibrates severity downstream.) REACHABILITY IS ABOUT THE ROUTE, not just the destination: if the claim is "reachable from untrusted input", check that the ROUTE runs from the real entry point — the parser, the handler, the deserializer, the public API — on attacker-supplied data. Reaching the state by CONSTRUCTING the object directly (a builder, \`new\`, a test fixture, an internal constructor) bypasses exactly the validation the question is about, and proves nothing about untrusted-input reachability. That trap catches careful reviewers, so check it explicitly rather than assuming the route was the obvious one.
3. refuted: is the technical claim itself false? (${isTool ? "Tool-decided as above." : "Mechanical check first, then your judgement; when uncertain about the claim, refuted=true."})
4. premiseSupported: identify the finding's LOAD-BEARING premise — the one claim that, if false, makes the finding evaporate. If it lives outside the cited line (the dependency behaves this way, this is reachable from untrusted input, no caller guards it, the sibling does X), OPEN the \`whereChecked\` location and check it actually shows that. premiseSupported=false when the premise is off-site and \`whereChecked\` is empty, points somewhere that does not show it, or merely restates the cited line. premiseSupported=true when the finding is genuinely self-contained at the cited line, or the off-site evidence checks out. Do NOT set refuted=true just because a premise is uncited — unsupported is not disproven; that is what this field is for, and it demotes the finding downstream instead of killing it.

Return {refuted, citedLineMatches, reachable, premiseSupported, reason}.`;
}
function exclusionCatalogText(profile) {
  return profile?.fpRules ? `
EXCLUSION CATALOG: your rejection is itself a claim and carries the same burden of proof as the finding. Load the ${profile.rubricSkill} skill's ${profile.fpRules} and, when one of its precedents fires, name the ID in \`reason\` (e.g. "refuted per FP-006: proven-Some unwrap"). Run the TRACE each rule demands — "looks guarded" does not fire the invariant-protected rule; following the invariant to its source and showing it dominates the sink on every path does. Two of them (FP-002 operator-controlled input, FP-005 operator-only panic surface) are severity DOWNGRADES, not refutations: the claim still holds, only the attacker's access is missing — say so in \`reason\` and leave refuted=false. The file also lists the KEEP-* non-reasons, dismissals that sound decisive and have repeatedly killed real defects (soundness in a public API no current caller reaches, a logic bug in safe Rust, a panic unwinding through an unsafe region). If nothing in the catalog fits, judge on the merits — never force a bad fit to justify a drop.
` : "";
}
function verifyHead(isTool, idx, src) {
  return isTool ? `You are verifier #${idx + 1} for a TOOL-REPORTED code review finding (source: ${src}). Deterministic tool output outranks your judgement — you may refute it ONLY by re-running the tool, never on reasoning alone.` : `You are skeptic #${idx + 1} trying to REFUTE a code review finding. Default to refuted=true when uncertain whether the technical claim holds — only let real findings through.`;
}
const DEDUP_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: { type: "array", items: { type: "integer" } },
      description: "each inner array = indices of findings that describe the SAME underlying defect; singletons omitted; empty if all distinct"
    }
  }
}, ROLLUP_MAX = 3;
function rollupPool(pool, profile) {
  const ids = profile.rollupRuleIds || [];
  if (!ids.length) return pool;
  const { groups, out: out2 } = rollupGroups(pool, ids);
  for (const [, g] of groups) out2.push(...rolledUp(g, profile));
  return out2;
}
function rollupGroups(pool, ids) {
  const groups = /* @__PURE__ */ new Map(), out2 = [];
  for (const f of pool) {
    const id = f.ruleId || "";
    if (!ids.includes(id)) {
      out2.push(f);
      continue;
    }
    const k = `${f.source || ""}::${id}`;
    let g = groups.get(k);
    g || (g = [], groups.set(k, g)), g.push(f);
  }
  return { groups, out: out2 };
}
function sevRankOf(f) {
  return SEV_RANK[f.severity ?? ""] ?? 9;
}
function rolledUp(g, profile) {
  const sorted = g.slice().sort((a, b) => sevRankOf(a) - sevRankOf(b));
  if (sorted.length <= ROLLUP_MAX) return sorted;
  const keep = sorted.slice(0, ROLLUP_MAX), folded = sorted.slice(ROLLUP_MAX), rep = (
    /** @type {Finding} */
    folded[0]
  ), where = folded.slice(0, 6).map((f) => `${f.file || "?"}:${f.line || 0}`).join(", "), rolled = [...keep, {
    ...rep,
    title: `${rep.title} — and ${folded.length - 1} more of the same (${rep.ruleId})`,
    why: `${rep.why} Repeated ${folded.length} more times across the diff (${where}${folded.length > 6 ? ", …" : ""}); rolled into one finding because per-occurrence reporting of this rule buries the rest of the review. Fix the pattern, not the instance.`
  }];
  return log(`[${profile.id}] Roll-up: ${g.length}× ${rep.ruleId} from '${rep.source}' → ${keep.length} individual + 1 grouped`), rolled;
}
const SAME_SPOT_OVERLAP = 0.6;
function sameSpotGroups(pool) {
  const bySpot = /* @__PURE__ */ new Map();
  pool.forEach((f, i) => {
    if (!f || !f.file) return;
    const k = `${String(f.file).toLowerCase()}:${f.line || 0}`, at = bySpot.get(k);
    at ? at.push(i) : bySpot.set(k, [i]);
  });
  const groups = [];
  for (const [, idxs] of bySpot)
    idxs.length < 2 || groups.push(...spotGroups(pool, idxs));
  return groups;
}
function spotGroups(pool, idxs) {
  const groups = [], taken = /* @__PURE__ */ new Set();
  for (const i of idxs) {
    if (taken.has(i)) continue;
    const g = [i, ...sameTitleAt(pool, idxs, i, taken)];
    g.length > 1 && (taken.add(i), groups.push(g));
  }
  return groups;
}
function sameTitleAt(pool, idxs, i, taken) {
  const g = [];
  for (const j of idxs)
    j === i || taken.has(j) || shingleOverlap(
      /** @type {Finding} */
      pool[i].title,
      /** @type {Finding} */
      pool[j].title
    ) >= SAME_SPOT_OVERLAP && (g.push(j), taken.add(j));
  return g;
}
async function dedupModelGroups(profile, listing) {
  let res = null;
  try {
    res = await ragent(
      `You are deduplicating code-review findings BEFORE verification. Different lenses word the same defect differently. Group ONLY findings that describe the SAME underlying defect — same root cause, where one edit fixes all of them (e.g. one redundant loop reported by both a performance and an idioms lens). Same file+line alone is NOT enough: two distinct defects can share a line. When in doubt, do NOT group.

FINDINGS:
${listing}

Return {groups: [[i, j, ...], ...]} — index groups of same-defect findings; omit singletons; {groups: []} if all are distinct.`,
      { label: `dedup:${profile.id}`, phase: "Verify", schema: DEDUP_SCHEMA, model: "haiku", effort: "low" }
    );
  } catch (e) {
    log(`[${profile.id}] dedup pass failed (${String(e && /** @type {{ message?: unknown }} */
    e.message || e).slice(0, 80)}) — verifying the raw pool`);
  }
  return res;
}
function mergedGroup(members, isToolSrc) {
  const base = (
    /** @type {Finding} */
    members.slice().sort((a, b) => (
      /** @type {number} */
      /** @type {unknown} */
      isToolSrc(b) - /** @type {number} */
      /** @type {unknown} */
      isToolSrc(a) || (SEV_RANK[a.severity ?? ""] ?? 9) - (SEV_RANK[b.severity ?? ""] ?? 9)
    ))[0]
  ), others = members.filter((m) => m !== base), sources = [...new Set(members.map((m) => m.source).filter(Boolean))], whereChecked = [...new Set(members.map((m) => m.whereChecked).filter(Boolean))].join("; ");
  return { ...base, sources, whereChecked, why: `${base.why} (same defect also reported by: ${others.map((m) => m.source).join(", ")})` };
}
async function dedupPool(pool, profile) {
  if (pool.length < 2) return pool;
  const isToolSrc = (f) => isToolSource(profile, f.source), listing = pool.map((f, i) => `${i}. ${f.file || "?"}:${f.line || 0} [${f.severity}] (${f.source}) ${f.title} — ${String(f.why || "").slice(0, 160)}`).join(`
`), res = await dedupModelGroups(profile, listing), detGroups = sameSpotGroups(pool), groups = detGroups.concat(
    (res?.groups ?? []).filter((g) => Array.isArray(g) && g.length > 1 && g.every((i) => Number.isInteger(i) && i >= 0 && i < pool.length))
  ), merged = [], inGroup = /* @__PURE__ */ new Set();
  for (const g of groups)
    if (!g.some((i) => inGroup.has(i))) {
      for (const i of g) inGroup.add(i);
      merged.push(mergedGroup(g.map((i) => (
        /** @type {Finding} */
        pool[i]
      )), isToolSrc));
    }
  if (!merged.length) return pool;
  const out2 = pool.filter((_f, i) => !inGroup.has(i)).concat(merged), detFolded = detGroups.reduce((n, g) => n + g.length - 1, 0);
  return log(`[${profile.id}] Dedup before verify: ${pool.length} → ${out2.length} (${pool.length - out2.length} cross-lens duplicate(s) merged — ${detFolded} of them same-spot, caught deterministically)`), out2;
}
const CULL_MODEL = "sonnet", VERIFY_WINDOW_AGENTS = 24;
function verifyWeight(f, plan) {
  return f.severity === "Critical" || f.severity === "High" ? 1 + Math.max(1, Number(plan?.verifyVotes) || 1) : 1;
}
async function weightedWindow(entries, maxWeight, runOne) {
  const cap = Math.max(1, Number(maxWeight) || 1), out2 = (
    /** @type {(T | null)[]} */
    new Array(entries.length).fill(null)
  );
  let next = 0, inflight = 0;
  return await /** @type {Promise<void>} */
  new Promise((resolve) => {
    const pump = () => {
      for (; next < entries.length; ) {
        const w = Math.max(1, Number(
          /** @type {{weight?: unknown}} */
          entries[next].weight
        ) || 1);
        if (inflight > 0 && inflight + w > cap) break;
        const i = next++;
        inflight += w, Promise.resolve().then(() => runOne(
          /** @type {{run: R}} */
          entries[i].run,
          i
        )).then((v) => {
          out2[i] = v ?? null;
        }, () => {
          out2[i] = null;
        }).then(() => {
          inflight -= w, pump();
        });
      }
      next >= entries.length && inflight === 0 && resolve();
    };
    pump();
  }), out2;
}
const CRITICAL_TIER_RULES = /* @__PURE__ */ new Set(["SAF-001", "SAF-002", "SAF-003", "SAF-004", "SAF-005", "SAF-006", "SAF-008", "ERR-001", "ERR-002"]), BATCH_SIZE = 6;
function verifyTier(f) {
  return f.severity === "Critical" || f.severity === "High" ? "individual" : f.severity === "Medium" ? "batch" : CRITICAL_TIER_RULES.has(f.ruleId || "") ? "individual" : "skip";
}
const BLOCKING_SEVERITIES = ["Critical", "High"];
function securesBlock(f) {
  return !!f && f.tier === "confirmed" && BLOCKING_SEVERITIES.includes(f.severity);
}
function makeVerdictFloor() {
  let by = null;
  return {
    record(f) {
      return by !== null || !securesBlock(f) ? !1 : (by = /** @type {JudgedFinding} */
      f, !0);
    },
    secured() {
      return by !== null;
    },
    securedBy() {
      return by;
    }
  };
}
function verdictNeutralNow(f, floor) {
  return !!f && f.severity === "Medium" && !!floor && floor.secured();
}
function floorSkipReason(floor) {
  const by = floor && floor.securedBy();
  return `no verifier was spent on it — the verdict was already fixed at Block by the confirmed ${by ? `${by.severity} "${by.title || "?"}" at ${by.file || "?"}:${by.line || 0}` : "a confirmed blocking finding"}, and no judgement on a Medium can move Block either way, so nothing here has been checked against the code`;
}
const NOT_VERIFIED = (f, why) => ({ ...f, tier: "unverified", why: `${f.why} (NOT VERIFIED: ${why})` });
function batchDeath(res) {
  if (!res) return "returned nothing at all — a dead agent, an exhausted retry, or an expired deadline";
  const verdicts = (
    /** @type {{ verdicts?: unknown }} */
    res.verdicts
  );
  return Array.isArray(verdicts) ? (
    /** @type {unknown[]} */
    verdicts.length ? null : "answered with an EMPTY verdict list — it judged nothing"
  ) : "answered OFF-SCHEMA — its answer carried no verdict list at all";
}
const VOTE_AXES = ["refuted", "citedLineMatches", "reachable", "premiseSupported"];
function isVerdictShaped(v) {
  return !!v && typeof v == "object" && VOTE_AXES.every((k) => typeof /** @type {Record<string, unknown>} */
  v[k] == "boolean");
}
function votesAgree(a, b) {
  return !isVerdictShaped(a) || !isVerdictShaped(b) ? !1 : VOTE_AXES.every((k) => a[k] === b[k]);
}
function decideTier(f, live, v) {
  if (!v.length)
    return NOT_VERIFIED(f, live.length ? "the verifier ANSWERED OFF-SCHEMA — its verdict carried none of the judgements this tier is decided on, so nothing was checked against the code" : "every verifier vote for this finding died before returning a verdict — nothing was checked against the code");
  const { tier, premiseOk, reach } = votePanel(v);
  return tier === "confirmed" && !premiseOk ? premiseDemoted(f) : tier === "confirmed" && !reach ? reachDemoted(f, tier) : { ...f, tier };
}
function votePanel(v) {
  const half = v.length / 2, lineOk = v.filter((x) => x.citedLineMatches).length >= Math.ceil(half), reach = v.filter((x) => x.reachable).length >= Math.ceil(half), premiseOk = v.filter((x) => x.premiseSupported).length >= Math.ceil(half), refutes = v.filter((x) => x.refuted).length;
  let tier;
  return lineOk ? refutes > half ? tier = "refuted" : refutes === 0 ? tier = "confirmed" : tier = "suspected" : tier = "refuted", { tier, premiseOk, reach };
}
function premiseDemoted(f) {
  return { ...f, tier: "suspected", why: `${f.why} (demoted to Suspected: the load-bearing premise is off-site and no verifier could pin it to real code${f.whereChecked ? ` — claimed at ${f.whereChecked}` : ", and whereChecked was empty"})` };
}
function reachDemoted(f, tier) {
  const demoted = DEMOTE[f.severity ?? ""] || f.severity;
  return { ...f, tier, ...demoted === void 0 ? {} : { severity: demoted }, why: `${f.why} (severity demoted ${f.severity}→${demoted}: not on a production-reachable path)` };
}
function tierFromVotes(f, votes) {
  const live = votes.filter(Boolean), v = live.filter(isVerdictShaped), judged = decideTier(f, live, v), discarded = live.length - v.length;
  if (!discarded) return judged;
  if (judged.tier === "unverified") return { ...judged, votesDiscarded: discarded };
  const share = v.length * 2 < live.length ? "a minority of" : v.length * 2 === live.length ? "exactly half of" : "most of";
  return {
    ...judged,
    votesDiscarded: discarded,
    why: `${judged.why} (PANEL THINNED: ${discarded} of ${live.length} returned votes answered off-schema and were discarded before the arithmetic — this ${judged.tier} stands on ${v.length} of ${live.length} returned votes, ${share} the panel that answered)`
  };
}
const THINNED_CLAUSE = / \(PANEL THINNED: [^)]*\)/g, BATCH_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: !1,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      description: "one entry per finding in the batch, keyed by its index — every index must appear",
      items: {
        type: "object",
        additionalProperties: !1,
        required: ["index", "refuted", "citedLineMatches", "reachable", "premiseSupported", "reason"],
        properties: {
          index: { type: "integer" },
          refuted: { type: "boolean" },
          citedLineMatches: { type: "boolean" },
          reachable: { type: "boolean" },
          premiseSupported: { type: "boolean" },
          reason: { type: "string" }
        }
      }
    }
  }
};
function batchVerifyPrompt(group, profile) {
  const pfs = group.map((f, i) => {
    const pf = promptFields(f);
    return `--- FINDING ${i} ---
[${pf.severity}] ${pf.title}
  at ${pf.file || "?"}:${f.line || 0}
  why: ${sanitizeAttack(f.why)}
  source: ${sanitizeAttack(f.source)}${f.ruleId ? ` · rule ${pf.ruleId}` : ""}
  off-site evidence claimed: ${f.whereChecked ? pf.whereChecked : "(none — claims to be self-contained at the cited line)"}`;
  }).join(`
`);
  return `You are a skeptic verifying ${group.length} INDEPENDENT ${profile.lang} review findings in one pass. They are batched only to save cost — judge each ENTIRELY on its own evidence. Never let one finding's verdict influence another's, and never assume a batch "should" contain some proportion of real ones.

Open the cited file for EACH finding and judge it exactly as you would alone. Default to refuted=true when uncertain whether a technical claim holds.

REFUTATION RULE: refuted=true means the TECHNICAL CLAIM is false — the cited code does not contain the claimed defect. Context is NOT refutation: test/fixture-only, looks intentional, low impact — none of those justify refuted=true. Record that in reachable=false and reason.

Per finding, decide:
- citedLineMatches: does the cited file:line actually contain what the finding claims?
- reachable: production-reachable, or test/example/fixture-only? Reachability is about the ROUTE — a state reached by CONSTRUCTING the object directly (builder, \`new\`, a fixture) bypasses the validation the question is about and proves nothing about untrusted-input reachability.
- refuted: is the technical claim itself false?
- premiseSupported: name the one claim that, if false, makes the finding evaporate. If it lives outside the cited line, OPEN the claimed off-site evidence and check it shows that. false when the premise is off-site and the evidence is empty, wrong, or merely restates the cited line. Unsupported is NOT disproven — do not raise refuted for it.

${pfs}

Return {verdicts: [...]} with ONE entry per finding, each carrying its \`index\` (0..${group.length - 1}). Every index must appear — omitting one silently deletes a finding from the review.`;
}
async function verifyPool(items, plan, profile, gateProvenance) {
  const breaker = makeDeathBreaker(), route = { individual: [], batch: [], skip: [] };
  for (const f of items) route[verifyTier(f)].push(f);
  const floor = makeVerdictFloor(), unverified2 = route.skip.map((f) => ({
    ...f,
    tier: "unverified",
    why: `${f.why} (NOT VERIFIED: no verifier was spent on it — ${f.severity} cannot change the verdict either way, so nothing here has been checked against the code)`
  })), byFile = /* @__PURE__ */ new Map();
  for (const f of route.batch) {
    const k = f.file || "?", at = byFile.get(k);
    at ? at.push(f) : byFile.set(k, [f]);
  }
  const groups = [];
  for (const [, fs] of byFile) for (let i = 0; i < fs.length; i += BATCH_SIZE) groups.push(fs.slice(i, i + BATCH_SIZE));
  const deadGroup = (group, why) => {
    const what = `the batch verifier for ${/** @type {Finding} */
    group[0].file || "?"} ${why}`;
    return log(`⚠️ [${profile.id}] ${what} — its ${group.length} finding(s) were NOT checked against the code; reported as unverified and excluded from the verification counters`), group.map((f) => NOT_VERIFIED(f, `${what}, so nothing checked this finding against the code`));
  }, floorSkippedGroup = (group) => (log(`💰 [${profile.id}] the batch verifier for ${/** @type {Finding} */
  group[0].file || "?"} was NOT dispatched — ${floorSkipReason(floor)}; its ${group.length} finding(s) are reported as unverified and excluded from the verification counters`), group.map((f) => ({ ...NOT_VERIFIED(f, floorSkipReason(floor)), verifySkipped: !0 }))), batchThunks = groups.map((group) => () => (
    // Asked HERE, inside the thunk, not when the thunk list is built: the window dispatches lazily
    // and the individual panel goes first, so by the time a batch's turn comes the floor may have
    // been raised by a Critical that has actually come back confirmed. Asked at build time it would
    // always answer no, and the whole population would be bought.
    verdictNeutralNow(group[0], floor) ? Promise.resolve(floorSkippedGroup(group)) : ragent(batchVerifyPrompt(group, profile), { label: `verify-batch:${/** @type {Finding} */
    group[0].file || "?"}(${group.length})`, phase: "Verify", breaker, schema: BATCH_VERDICT_SCHEMA, model: CULL_MODEL }).then((res) => {
      const death = batchDeath(res);
      return death ? deadGroup(group, death) : group.map((f, i) => {
        const v = (res?.verdicts ?? []).find((x) => x && x.index === i);
        return v ? tierFromVotes(f, [v]) : { ...f, tier: "suspected", why: `${f.why} (batch verifier returned no verdict for this finding)` };
      });
    }).catch((err) => (log(`⚠️ [${profile.id}] batch verifier threw: ${String(err && /** @type {{ message?: unknown }} */
    err.message || err).slice(0, 160)}`), deadGroup(group, "died before returning any verdict")))
  ));
  (route.skip.length || groups.length) && log(`[${profile.id}] Verify routing: ${route.individual.length} individual · ${route.batch.length} batched into ${groups.length} agent(s) · ${route.skip.length} NOT VERIFIED (Low/Info cannot move the verdict; reported as unverified, excluded from the verification counters)`);
  const individualThunks = route.individual.map((f) => () => {
    const isTool = isToolSource(profile, f.source), isHigh = f.severity === "Critical" || f.severity === "High", n1 = isHigh ? Math.max(1, plan.verifyVotes) : 1, cull = (i) => () => ragent(verifyPrompt(f, i, isTool, gateProvenance, profile), { label: `verify:${f.file || "?"}:${f.line || 0}#c${i + 1}`, phase: "Verify", breaker, schema: VERDICT_SCHEMA, model: CULL_MODEL });
    if (!isHigh) return parallel([cull(0)]).then((vs) => tierFromVotes(f, vs));
    const auth = () => ragent(verifyPrompt(f, n1, isTool, gateProvenance, profile), { label: `verify:${f.file || "?"}:${f.line || 0}#auth`, phase: "Verify", breaker, schema: VERDICT_SCHEMA, model: plan.lensModel });
    return parallel([cull(0), auth]).then(async (vs) => {
      const opening = vs.filter(Boolean);
      if (opening.length === 2 && votesAgree(opening[0], opening[1])) return tierFromVotes(f, opening);
      const rest = await parallel(Array.from({ length: Math.max(0, n1 - 1) }, (_unused, i) => cull(i + 1)));
      return tierFromVotes(f, opening.concat(rest.filter(Boolean)));
    });
  }), withFloor = (run) => () => Promise.resolve(
    /** @type {() => Promise<Finding>} */
    run()
  ).then((r) => (floor.record(r) && log(`💰 [${profile.id}] the verdict is now fixed at Block by a confirmed ${r.severity} (${r.file || "?"}:${r.line || 0}) — Medium batches not yet dispatched can no longer move it and will not be bought`), r)), entries = route.individual.map((f, i) => ({ run: withFloor(individualThunks[i]), weight: verifyWeight(f, plan) })).concat(batchThunks.map((run) => ({ run, weight: 1 }))), totalWeight = entries.reduce((n, e) => n + e.weight, 0);
  totalWeight > VERIFY_WINDOW_AGENTS && log(`[${profile.id}] Verify dispatched through a sliding window of ≤${VERIFY_WINDOW_AGENTS} agents (${totalWeight} worst-case agents queued) — a deeper queue makes the per-agent deadline fire on waiting rather than on hanging; the window refills as each verifier settles, so nothing waits on a batch's slowest member`);
  const settledVerdicts = await weightedWindow(entries, VERIFY_WINDOW_AGENTS, (run) => parallel([run]).then((rs) => rs[0])), judged = settledVerdicts.slice(0, route.individual.length).map((r, i) => (
    /** @type {Finding | null | undefined} */
    r || NOT_VERIFIED(
      /** @type {Finding} */
      route.individual[i],
      "the verifier panel for this finding was lost before it settled — nothing was checked against the code"
    )
  )), batched = settledVerdicts.slice(route.individual.length).flatMap((r, i) => r || deadGroup(
    /** @type {Finding[]} */
    groups[i],
    "was lost before it settled (its dispatch never produced a result)"
  )), settled = judged.concat(batched), vp = settled.filter((f) => f.tier !== "unverified"), deaths = settled.filter((f) => f.tier === "unverified"), refuted = vp.filter((f) => f.tier === "refuted");
  return {
    confirmed: vp.filter((f) => f.tier === "confirmed"),
    suspected: vp.filter((f) => f.tier === "suspected"),
    // Kept OUT of `vp` on purpose, from both of its sources: the Low/Info nothing was spent on, and
    // the groups whose batch verifier died.
    unverified: unverified2.concat(deaths),
    // DERIVED from the tier, not pushed by whichever branch remembered to. Grouped by file and
    // ranked-friendly: one stable string per (profile, file), no error text, no run-specific path.
    // THE ONE THINNING THAT LEAVES NO TRACE. A refuted finding is deleted from the run — out of
    // every tier and out of the report — so when its panel was thinned, the partial evidence it was
    // deleted on is visible nowhere: no finding to carry the clause, no mark, and a verdict that
    // reads clean. `notRun` is the existing mechanism for "this ran badly; re-run it", and it drives
    // the INCOMPLETE marker. DERIVED from the tier plus the flag tierFromVotes sets, like the
    // deaths above, and grouped by (profile, file) so the exact-string ranking in
    // lib/analyze-runs.mjs sees a repeat rather than a run-unique row.
    notRun: [.../* @__PURE__ */ new Set([
      // THREE failures, kept apart by the same discipline that keeps error text out of the strings.
      // This list is ranked by exact string across runs, so collapsing any two makes one repeat
      // masquerade as another and sends the repair to the wrong place. A death is fragility a re-run
      // can fix; an off-schema panel ANSWERED and must not be called a death; a thinned refutation
      // deleted a finding on partial evidence. The deliberate floor skip is NOT here — see
      // `savedByFloor` below for why it cannot be.
      // Split on the flags tierFromVotes and floorSkippedGroup set, not on the wording of any `why`.
      ...deaths.filter((f) => !f.verifySkipped && !((f.votesDiscarded ?? 0) > 0)).map((f) => `${profile.id} verification of ${f.file || "?"} — the verifier(s) died before returning a verdict, so those finding(s) were never checked against the code`),
      ...deaths.filter((f) => !f.verifySkipped && (f.votesDiscarded ?? 0) > 0).map((f) => `${profile.id} verification of ${f.file || "?"} — every returned vote answered OFF-SCHEMA and was discarded before the arithmetic, so those finding(s) were never checked against the code`),
      ...refuted.filter((f) => (f.votesDiscarded || 0) > 0).map((f) => `${profile.id} verification of ${f.file || "?"} — a finding was REFUTED and deleted from the run by a THINNED PANEL (at least one returned vote answered off-schema and was discarded), so the deletion rests on partial evidence`)
    ])],
    // OUT of `notRun` on purpose, and this is the same call that was already made once for
    // `uncoveredFiles`. `notRun` means "this ran badly; re-run it": it drives the INCOMPLETE marker
    // on the verdict line, and lib/analyze-runs.mjs ranks it by exact string to surface repeated
    // FRAGILITY. A floor skip is the opposite of fragility — it is a deliberate, reproducible
    // saving that a re-run will simply make again. Left inside, it would do two kinds of damage,
    // both of them silent: every Block run carrying a batched Medium (the ordinary case) would
    // render as "⚠️ INCOMPLETE — coverage was partial … findings may be undercounted", which is a
    // false statement about coverage and, through rust-audit's leading-⚠️ rule, can pull a whole
    // audit down to Warning; and this string would become the most frequent row in the fragility
    // ranking, sinking the genuine repeats the ranking exists to surface. The findings themselves
    // are not hidden by this: they stay in the `unverified` tier, out of the refutation
    // denominator, and each carries its own `why` into the report's Unverified section.
    // Read across runs by lib/analyze-runs.mjs, which ranks it separately from the failures.
    savedByFloor: [...new Set(deaths.filter((f) => f.verifySkipped).map((f) => `${profile.id} verification of ${f.file || "?"} — deliberately not dispatched: the verdict was already fixed at Block, and no judgement on a Medium can move it, so those finding(s) were never checked against the code`))],
    dropped: refuted.length,
    refuted
  };
}
const RIGOR_BY_SIZE = {
  small: { maxRounds: 1, verifyVotes: 1 },
  medium: { maxRounds: 2, verifyVotes: 1 },
  large: { maxRounds: 3, verifyVotes: 3 }
}, LENS_MODEL = "opus";
function admittedLens(l) {
  return !OPTIONAL_LENSES.includes(l) || optionalRequested.includes(l);
}
function blanketLenses(profile) {
  return profile.lenses.filter((l) => !CONDITIONAL_LENSES.includes(l) && admittedLens(l));
}
function rigorSize(scout) {
  return (
    /** @type {keyof typeof RIGOR_BY_SIZE} */
    Object.hasOwn(RIGOR_BY_SIZE, scout?.sizeBucket ?? "") ? scout?.sizeBucket : "medium"
  );
}
function scoutPickedLenses(profile, scout) {
  return scout?.lenses?.length ? scout.lenses.filter((l) => profile.lenses.includes(l) && admittedLens(l)) : blanketLenses(profile);
}
function initialPlan(profile, scout, size) {
  return {
    sizeBucket: size,
    lenses: scoutPickedLenses(profile, scout),
    maxRounds: RIGOR_BY_SIZE[size].maxRounds,
    verifyVotes: RIGOR_BY_SIZE[size].verifyVotes,
    lensModel: LENS_MODEL,
    isLibrary: profile.usesLibrary ? scout?.isLibrary ?? !1 : !1,
    securitySensitive: scout?.securitySensitive ?? !0,
    intent: scout?.intent ?? intentArg,
    spec,
    churn: scout?.churn ?? []
  };
}
function addMissingLens(plan, l) {
  plan.lenses.includes(l) || plan.lenses.push(l);
}
function addOfferedLens(profile, plan, l) {
  profile.lenses.includes(l) && addMissingLens(plan, l);
}
function addRequiredLenses(profile, scout, plan) {
  for (const l of profile.alwaysLenses || []) addOfferedLens(profile, plan, l);
  Array.isArray(scout?.lenses) && scout.lenses.includes("reconciler") && addOfferedLens(profile, plan, "failure-windows"), strict && addOfferedLens(profile, plan, "maintainability");
}
function addRigorFloors(profile, plan) {
  plan.securitySensitive && applySecurityFloor(profile, plan), (plan.securitySensitive || plan.sizeBucket === "large") && addMissingLens(plan, "negative-space"), plan.sizeBucket === "large" && addOfferedLens(profile, plan, "compat"), changedFiles.some(isContractOrSchemaPath) && addOfferedLens(profile, plan, "compat");
  for (const l of optionalRequested) addOfferedLens(profile, plan, l);
}
function applySecurityFloor(profile, plan) {
  for (const l of blanketLenses(profile)) addMissingLens(plan, l);
  plan.verifyVotes = Math.max(plan.verifyVotes, 3), plan.maxRounds = Math.max(plan.maxRounds, 2);
}
function applySurfaceGate(scout, plan) {
  const surfaces = { ...scout?.surfaces || {} };
  changedFiles.some(isContractOrSchemaPath) && (surfaces.crossBoundarySymbol = !0, surfaces.wireForm = !0);
  const surfaceDropped = [];
  return plan.lenses = plan.lenses.filter((lens) => {
    const need = SURFACE_GATED_LENSES[lens];
    return need && surfaces[need] === !1 ? (surfaceDropped.push(lens), !1) : !0;
  }), surfaceDropped;
}
function planFromScout(profile, scout) {
  const plan = initialPlan(profile, scout, rigorSize(scout));
  plan.lenses.length || (plan.lenses = blanketLenses(profile)), addRequiredLenses(profile, scout, plan), addRigorFloors(profile, plan);
  const surfaceDropped = applySurfaceGate(scout, plan);
  return { plan, surfaceDropped };
}
function logScoutPlan(profile, scout, plan) {
  log(`[${profile.id}] ${scout ? scout.notes || "scout: classified" : "⚠️ scout did not return — conservative fallback plan"} · ${plan.sizeBucket}${plan.securitySensitive ? " · SECURITY floor (all lenses, 3-vote)" : ""}${plan.lenses.includes("negative-space") ? " · +negative-space" : ""}`);
}
function noteLensDispatched(lens) {
  OPTIONAL_LENSES.includes(lens) && optionalDispatched.add(lens), SURFACE_GATED_LENSES[lens] && surfaceGateDispatched.add(lens);
}
async function runPreflight(profile) {
  const preflight = await ragent(
    preflightPrompt(profile, { baseRef }),
    // 5min, not the phase default. Three numbers set it, and the deadline must clear ALL of them:
    //  · the prompt declares a 3min ceiling, and a deadline at twice that makes the budget advisory —
    //    nothing then stops a pass that ignores the ceiling. 5min stays under 2x and keeps it real.
    //  · the measured cost of an earlier version of this pass was 207s, ALREADY past three minutes.
    //  · the clock starts at DISPATCH, not at execution, so it covers queue wait PLUS the run.
    // A deadline between those last two (210000 did exactly this) times out work that would have
    // landed. Losing preflight is survivable — the gate re-establishes everything itself, the slow
    // way — so the bound is set above the measured cost rather than tight against it.
    // THE COST ARGUMENT THAT USED TO STAND HERE IS NO LONGER TRUE, and the constant survives it.
    // It read: a miss costs TWO dispatches, because `ragent` abandoned the wait and re-dispatched
    // with a fresh deadline, so a hung pass burned up to 10min. The deadline is now ONE budget
    // shared by the attempts, and a deadline fire spends it by definition — so a miss costs one
    // dispatch and at most these 5 minutes, and the second attempt exists only for the fast death
    // that leaves budget behind. 300000 is therefore now a straightforwardly bounded 5min ceiling,
    // not a 10min one accepted as a trade.
    { label: `preflight:${profile.id}`, schema: PREFLIGHT_SCHEMA, phase: "Gate", model: "haiku", effort: "low", deadlineMs: 3e5 }
  ), probeViolations = auditPreflightProbes(preflight);
  return probeViolations.length && log(`⚠️ [${profile.id}] PREFLIGHT PROBE BUDGET BREACHED (${probeViolations.length}): ${probeViolations.join(" · ")}`), preflight ? log(preflightLine(profile, preflight)) : log(`⚠️ [${profile.id}] Preflight unavailable (failed or passed its deadline) — the gate establishes the environment itself, and its provenance says so.`), { preflight, probeViolations };
}
function preflightLine(profile, preflight) {
  return `[${profile.id}] Preflight: runner ${preflight.runner ? `\`${preflight.runner.trim()}\`` : "(none)"} · ${preflight.blockers?.length ? `${preflight.blockers.length} compile blocker(s)` : "no compile blockers"} · CI covers ${preflight.ciCovers?.length ? preflight.ciCovers.join(", ") : "nothing"}${preflight.missingTools?.length ? ` · missing: ${preflight.missingTools.join(", ")}` : ""}${preflightIsPartial(preflight) ? " · ⚠️ PARTIAL — see notes" : ""}`;
}
function gateFields(gate) {
  return {
    gateStatus: gate?.status ?? "unknown",
    gateProvenance: gate?.provenance ?? "gate not established",
    failedChecks: gate?.failedChecks ?? [],
    // Red, real, and NOT this diff's doing. Kept out of failedChecks so it cannot stop the review, and
    // out of notes so it cannot be quietly lost: it prints on every verdict, including a green one.
    carriedChecks: gate?.carriedChecks ?? []
  };
}
function gateSeedFindings(gate) {
  return (gate?.seedFindings ?? []).map((f) => ({ ...f, source: f.source || "tool" }));
}
function logGate(profile, gateStatus, gateProvenance, failedChecks, carriedChecks) {
  log(`[${profile.id}] Gate: ${gateStatus} — ${gateProvenance}${failedChecks.length ? ` · failed: ${failedChecks.join(", ")}` : ""}${carriedChecks.length ? ` · ${carriedChecks.length} pre-existing (carried, not blocking)` : ""}`);
}
function toolProvenanceFor(gateProvenance, preflight) {
  return [
    gateProvenance,
    preflight?.runner ? `run every tool as \`${flattenField(preflight.runner).trim()} <cmd>\` — bare invocations die in missing system libraries` : "",
    preflight?.blockers?.length ? `CANNOT compile here: ${preflight.blockers.map(flattenField).join("; ")} — a tool needing a build is unrunnable, say so rather than reporting its error as evidence` : ""
  ].filter(Boolean).join(" · ");
}
function preflightCheckpoint(preflight, probeViolations) {
  return preflight ? { status: preflightIsPartial(preflight) ? "partial" : "ok", runner: preflight.runner, blockers: preflight.blockers, missingTools: preflight.missingTools, ciCovers: preflight.ciCovers, notes: preflight.notes, probeViolations } : { status: "unavailable" };
}
async function reviewProfile(profile) {
  const scout = await ragent(scoutPrompt(profile), { label: `scout:${profile.id}`, schema: SCOUT_SCHEMA, model: "haiku", effort: "low", phase: "Scout" }), scoutNotRun = !scout ? [`${profile.id} scout classification — the plan is the conservative fallback (all lenses, 3-vote, 2 rounds), not a scouted one`] : [], { plan, surfaceDropped } = planFromScout(profile, scout), optionalScope = profile.lenses.filter((l) => OPTIONAL_LENSES.includes(l));
  logScoutPlan(profile, scout, plan);
  const lensFailures = /* @__PURE__ */ new Map();
  let reviewerAgentMissing = !1;
  const dispatchKey = (lens, slice) => slice ? `${lens} :: ${slice.key}` : lens;
  async function runLens(lens, prompt, phaseName, labelSuffix, slice = null) {
    const res = await dispatchLens(lens, prompt, phaseName, labelSuffix, slice);
    return res != null && !Array.isArray(
      /** @type {{ findings?: unknown }} */
      res.findings
    ) ? (lensFailures.set(dispatchKey(lens, slice), "answered off-schema (no findings array)"), log(`⚠️ [${profile.id}] lens ${dispatchKey(lens, slice)} answered off-schema (no findings array) — counted as not returned`), null) : res;
  }
  const answeredFindings = (r) => r != null && Array.isArray(
    /** @type {{ findings?: unknown }} */
    r.findings
  );
  async function dispatchLens(lens, prompt, phaseName, labelSuffix, slice = null) {
    noteLensDispatched(lens);
    const opts = { label: `lens:${profile.id}:${lens}${labelSuffix}`, phase: phaseName, schema: FINDINGS_SCHEMA, model: plan.lensModel }, runGeneric = async () => {
      try {
        return await ragent(prompt, opts);
      } catch (e) {
        return lensFailures.set(dispatchKey(lens, slice), String(e && /** @type {{ message?: unknown }} */
        e.message || e).slice(0, 160)), null;
      }
    };
    if (reviewerAgentMissing) return runGeneric();
    try {
      const res = await ragent(prompt, { ...opts, agentType: profile.reviewerAgent });
      if (res != null) return res;
      const fallback = await runGeneric();
      return answeredFindings(fallback) && noteReviewerAgentFallback(profile), fallback;
    } catch (e) {
      return reviewerAgentThrew(e, lens, slice, runGeneric);
    }
  }
  async function reviewerAgentThrew(e, lens, slice, runGeneric) {
    const msg = String(e && /** @type {{ message?: unknown }} */
    e.message || e);
    if (!isAgentTypeMissing(msg, profile.reviewerAgent)) {
      if (lensFailures.set(dispatchKey(lens, slice), msg.slice(0, 160)), !/not found/i.test(msg)) return null;
      const fallback = await runGeneric();
      return answeredFindings(fallback) && (lensFailures.delete(dispatchKey(lens, slice)), noteReviewerAgentNotFound(profile, msg.slice(0, 160))), fallback;
    }
    return reviewerAgentMissing = !0, noteReviewerAgentMissing(profile, msg), log(`⚠️ [${profile.id}] agent type '${profile.reviewerAgent}' not registered here — routing remaining lenses to the generic subagent`), await runGeneric();
  }
  const { preflight, probeViolations } = await runPreflight(profile), gate = await ragent(
    profile.gate({ baseRef, isLibrary: plan.isLibrary, securitySensitive: plan.securitySensitive, preflight }),
    { label: `gate:${profile.id}`, schema: GATE_SCHEMA, phase: "Gate", effort: "medium" }
  ), { gateStatus, gateProvenance, failedChecks, carriedChecks } = gateFields(gate), seedFindings = gateSeedFindings(gate);
  logGate(profile, gateStatus, gateProvenance, failedChecks, carriedChecks);
  const toolProvenance = toolProvenanceFor(gateProvenance, preflight);
  if (await checkpoint(`${profile.id}-plan`, {
    language: profile.id,
    branch,
    head,
    baseRef,
    round: thisRound,
    scout: { size: plan.sizeBucket, lenses: plan.lenses, maxRounds: plan.maxRounds, verifyVotes: plan.verifyVotes, securitySensitive: plan.securitySensitive },
    gate: { status: gateStatus, provenance: gateProvenance, failedChecks, carriedChecks, seeds: seedFindings.length },
    // `status` so a reader of the record can tell a preflight that ran and found nothing from one
    // that never answered — a bare `null` collapsed both into the same, more permissive, reading.
    preflight: preflightCheckpoint(preflight, probeViolations)
  }, "Gate"), gateStatus === "fail")
    return { profile, plan, surfaceDropped, optionalScope, ranLenses: (
      /** @type {string[]} */
      []
    ), lensRounds: [], gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], unverified: [], dropped: 0, notRun: [...scoutNotRun], criticNotes: "", probeViolations };
  await probeReviewerAgent();
  async function probeReviewerAgent() {
    if (profile.reviewerAgent && !reviewerAgentMissing)
      try {
        await agent("Reply with the single word: OK.", { label: `probe:${profile.id}`, phase: "Gate", model: "haiku", effort: "low", agentType: profile.reviewerAgent });
      } catch (e) {
        const msg = String(e && /** @type {{ message?: unknown }} */
        e.message || e);
        isAgentTypeMissing(msg, profile.reviewerAgent) && (reviewerAgentMissing = !0, noteReviewerAgentMissing(profile, msg), log(`[${profile.id}] reviewer agent '${profile.reviewerAgent}' not registered — all lenses will use the generic subagent`));
      }
  }
  phase("Lenses");
  const seen = /* @__PURE__ */ new Set(), pool = [];
  for (const f of seedFindings) {
    const k = key(f);
    seen.has(k) || (seen.add(k), pool.push(f));
  }
  const notRun2 = [...scoutNotRun], expectedDispatches = /* @__PURE__ */ new Set(), returnedDispatches = /* @__PURE__ */ new Set(), lensRounds = [];
  let criticFollowupLenses = [];
  const diffSlices = sliceDiff(changedFiles, { owns: (f) => profile.detect([f]) });
  diffSlices.length && log(`[${profile.id}] diff sliced into ${diffSlices.length} scope(s) for the code-intrinsic lenses: ${diffSlices.map((g) => `${g.key} (${g.files.length})`).join(" · ")}. Whole-diff lenses (${WHOLE_DIFF_LENSES.join(", ")}) still see everything.`);
  const lensSlicesFor = (lens) => diffSlices.length && sliceableLens(lens) ? diffSlices : [null];
  async function lensRound(round) {
    const priorSummary = priorFoundSummary(pool), dispatches = plan.lenses.flatMap((lens) => lensSlicesFor(lens).map((slice) => ({ lens, slice })));
    for (const d of dispatches) expectedDispatches.add(dispatchKey(d.lens, d.slice));
    const results2 = (await weightedWindow(
      dispatches.map((d) => ({ weight: 1, run: () => runLens(d.lens, lensPrompt(d.lens, priorSummary, profile, plan, d.slice), "Lenses", ` r${round}${d.slice ? ` ${d.slice.key}` : ""}`, d.slice) })),
      LENS_WINDOW_AGENTS,
      (run, i) => run().then((r) => r ? { ...r, __key: dispatchKey(
        /** @type {(typeof dispatches)[number]} */
        dispatches[i].lens,
        /** @type {(typeof dispatches)[number]} */
        dispatches[i].slice
      ), __lens: (
        /** @type {(typeof dispatches)[number]} */
        dispatches[i].lens
      ) } : null)
    )).filter((r) => r != null);
    for (const r of results2) returnedDispatches.add(r.__key);
    const fresh = [];
    for (const r of results2)
      for (const f0 of r.findings || []) {
        const f = { ...f0, source: r.__lens }, k = key(f);
        seen.has(k) || (seen.add(k), fresh.push(f));
      }
    return pool.push(...fresh), lensRounds.push({ round, agents: dispatches.length, returned: results2.length, newFindings: fresh.length }), log(`[${profile.id}] Lenses round ${round}: +${fresh.length} new (pool ${pool.length})`), !fresh.length;
  }
  let dry = !1;
  for (let round = 1; round <= plan.maxRounds && !dry; round++) dry = await lensRound(round);
  const lensesWithHoles = () => plan.lenses.filter((l) => [...expectedDispatches].some((k) => (k === l || k.startsWith(`${l} :: `)) && !returnedDispatches.has(k)));
  function absorbResurrected(r) {
    const lens = r.__lens;
    for (const k of expectedDispatches) (k === lens || k.startsWith(`${lens} :: `)) && returnedDispatches.add(k);
    for (const f0 of r.findings || []) {
      const f = { ...f0, source: lens }, k = key(f);
      seen.has(k) || (seen.add(k), pool.push(f));
    }
  }
  async function resurrectionSweep() {
    let missing = lensesWithHoles();
    for (let sweep = 1; sweep <= 2 && missing.length; sweep++) {
      log(`[${profile.id}] Resurrection sweep ${sweep}: retrying ${missing.length} lens(es) that never returned (${missing.join(", ")})`);
      const priorSummary = priorFoundSummary(pool), attempts = missing.map((lens) => ({ lens })), results2 = (await parallel(attempts.map(
        (a) => () => runLens(a.lens, lensPrompt(a.lens, priorSummary, profile, plan), "Lenses", ` resurrect${sweep}`).then((r) => r ? { ...r, __lens: a.lens } : null)
      ))).filter((r) => r != null);
      for (const r of results2) absorbResurrected(r);
      missing = lensesWithHoles();
    }
  }
  await resurrectionSweep();
  function reportDroppedLenses() {
    const droppedLenses2 = [...expectedDispatches].filter((k) => !returnedDispatches.has(k));
    if (droppedLenses2.length) {
      const reasonFor = (k) => lensFailures.get(k) || lensFailures.get(k.split(" :: ")[0] ?? k) || "returned no result (skipped or died without an error)", reasons = droppedLenses2.map((k) => `${k}: ${reasonFor(k)}`).join(" · ");
      notRun2.push(`${profile.id} lenses that never returned — ${reasons}`), log(`⚠️ [${profile.id}] ${droppedLenses2.length} lens dispatch(es) never returned (${reasons}). Review marked INCOMPLETE.`);
    }
    return droppedLenses2;
  }
  const droppedLenses = reportDroppedLenses(), ranLenses = plan.lenses.filter((l) => [...expectedDispatches].every((k) => k !== l && !k.startsWith(`${l} :: `) || returnedDispatches.has(k)));
  if (await checkpoint(`${profile.id}-lenses`, {
    language: profile.id,
    branch,
    head,
    baseRef,
    round: thisRound,
    ranLenses,
    droppedLenses,
    lensRounds,
    candidates: summarizeFindings(pool),
    candidatesBySource: pool.reduce(
      (m, f) => ({ ...m, [f.source || "unknown"]: (m[f.source || "unknown"] || 0) + 1 }),
      /** @type {Record<string, number>} */
      {}
    ),
    notRun: notRun2
  }, "Lenses"), !pool.length)
    return { profile, plan, surfaceDropped, optionalScope, ranLenses, lensRounds, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], unverified: [], dropped: 0, notRun: notRun2, criticNotes: "", probeViolations };
  phase("Verify");
  const deduped = await dedupPool(rollupPool(pool, profile), profile);
  let { confirmed: confirmed2, suspected: suspected2, unverified: unverified2, dropped: dropped2, refuted, notRun: verifyNotRun, savedByFloor: savedByFloor2 } = await verifyPool(deduped, plan, profile, toolProvenance);
  notRun2.push(...verifyNotRun), log(`[${profile.id}] Verify: ${confirmed2.length} confirmed · ${suspected2.length} suspected · ${dropped2} refuted · ${unverified2.length} not verified`), await checkpoint(`${profile.id}-verify`, {
    language: profile.id,
    branch,
    head,
    baseRef,
    round: thisRound,
    verdict: finalVerdict(confirmed2),
    findings: summarizeFindings(confirmed2),
    // `candidates` counts what verification EXAMINED, so the unverified tier is reported beside it
    // rather than inside it.
    verification: { candidates: deduped.length - unverified2.length, confirmed: confirmed2.length, suspected: suspected2.length, refuted: dropped2, unverified: unverified2.length }
  }, "Verify"), phase("Synthesize");
  async function completenessCritic() {
    const criticInScope = plan.sizeBucket === "large" || plan.securitySensitive;
    criticInScope && (!budget.total || budget.remaining() > 9e4) ? await runCritic() : criticInScope && (notRun2.push(`${profile.id} completeness-critic`), log(`Budget low (~${Math.round(budget.remaining() / 1e3)}k left) — SKIPPED [${profile.id}] completeness critic. Review marked INCOMPLETE.`));
  }
  async function runCritic() {
    const candidates = profile.lenses.filter((l) => !plan.lenses.includes(l)), critic = await ragent(
      `You are a completeness critic for a ${profile.lang} review of the diff (base ${flattenField(baseRef) || "HEAD"}).
Lenses already run: ${plan.lenses.join(", ")}. Confirmed: ${confirmed2.length}, Suspected: ${suspected2.length}.
Name any review lens that was NOT run but SHOULD be, given what the diff touches — choose ONLY from: ${JSON.stringify(candidates)}.
Also note in one line anything else likely missed (a changed file no finding touched, a claim left unverified). If coverage is complete, return missingLenses: [] and notes: "coverage complete".`,
      { label: `critic:${profile.id}`, phase: "Synthesize", schema: CRITIC_SCHEMA, effort: "low" }
    );
    criticNotes2 = critic?.notes ?? "";
    const named = (critic?.missingLenses ?? []).filter((l) => candidates.includes(l)), followups = refuseCriticNames(named);
    followups.length && (!budget.total || budget.remaining() > 6e4) ? await criticFollowups(followups) : followups.length && (notRun2.push(`${profile.id} critic follow-up lenses (${followups.join("/")})`), log(`Budget low (~${Math.round(budget.remaining() / 1e3)}k left) — SKIPPED [${profile.id}] critic follow-up lenses. Review marked INCOMPLETE.`));
  }
  function refuseCriticNames(named) {
    for (const l of named) admittedLens(l) || optionalNamedByCritic.add(l);
    const refusedOptional = named.filter((l) => !admittedLens(l));
    refusedOptional.length && log(`[${profile.id}] Completeness critic named optional lens(es) ${refusedOptional.join(", ")} — NOT dispatched (the optional pass is bought by an explicit \`optional=\` request); reported as uncovered.`);
    for (const l of named) surfaceDropped.includes(l) && surfaceGateNamedByCritic.add(l);
    const refusedSurface = named.filter((l) => surfaceDropped.includes(l));
    return refusedSurface.length && log(`[${profile.id}] Completeness critic named surface-gated lens(es) ${refusedSurface.join(", ")} — NOT dispatched (the diff does not touch the surface their defect class needs); reported as uncovered.`), named.filter((l) => admittedLens(l) && !surfaceDropped.includes(l));
  }
  async function criticFollowups(followups) {
    log(`[${profile.id}] Completeness critic → follow-up lenses: ${followups.join(", ")}`), criticFollowupLenses = [...followups];
    const priorSummary = `Earlier lenses already produced ${pool.length} findings — do NOT repeat them; surface only what your lens would add.`, settledExtra = await parallel(followups.map(
      (lens) => () => runLens(lens, lensPrompt(lens, priorSummary, profile, plan), "Synthesize", " (critic)")
    )), deadFollowups = followups.filter((_l, i) => !settledExtra[i]);
    deadFollowups.length && (notRun2.push(...deadFollowups.map((l) => `${profile.id} critic follow-up lens ${l} — dispatched and returned no findings (died, or answered off-schema)`)), log(`⚠️ [${profile.id}] critic follow-up lens(es) ${deadFollowups.join("/")} died before returning findings — recorded as not run; the review is INCOMPLETE`));
    const fresh = settledExtra.filter((r) => r != null).flatMap((r) => r.findings || []).filter((f) => {
      const k = key(f);
      return seen.has(k) ? !1 : (seen.add(k), !0);
    });
    if (fresh.length) {
      const v = await verifyPool(await dedupPool(fresh, profile), plan, profile, toolProvenance);
      notRun2.push(...v.notRun || []), savedByFloor2 = savedByFloor2.concat(v.savedByFloor || []), confirmed2 = confirmed2.concat(v.confirmed), suspected2 = suspected2.concat(v.suspected), unverified2 = unverified2.concat(v.unverified), dropped2 += v.dropped, refuted = refuted.concat(v.refuted), log(`[${profile.id}] Critic follow-up: +${v.confirmed.length} confirmed · +${v.suspected.length} suspected · ${v.dropped} refuted · +${v.unverified.length} not verified`);
    }
  }
  let criticNotes2 = "";
  return await completenessCritic(), { profile, plan, surfaceDropped, optionalScope, ranLenses, lensRounds, criticFollowupLenses, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: confirmed2, suspected: suspected2, unverified: unverified2, dropped: dropped2, refuted, notRun: notRun2, savedByFloor: savedByFloor2, criticNotes: criticNotes2, probeViolations };
}
async function reviewActiveProfiles() {
  for (const p of active) results.push(await reviewProfile(p));
}
await reviewActiveProfiles();
const gateFailed = (
  /** @type {Result[]} */
  failedProfiles(results)
), runGate = gateRecord(results), mergedProvenance = runGate.provenance, mergedGateStatus = runGate.status;
function carriedSection() {
  const all = results.flatMap((r) => (r.carriedChecks || []).map((c) => `- [${r.profile.id}] ${c}`));
  return all.length ? `
## Pre-existing — reported, not blocking
These are real and RED, but this diff did not cause them and no edit to the changed files clears them:
${all.join(`
`)}
` : "";
}
const carriedLine = (() => {
  const all = results.flatMap((r) => (r.carriedChecks || []).map((c) => `[${r.profile.id}] ${c}`));
  return all.length ? ` Then a \`## Pre-existing — reported, not blocking\` section listing these VERBATIM, one per line — they are RED and real but this diff did not cause them, so they must appear in the report while changing NOTHING about the verdict: ${JSON.stringify(all)}.` : "";
})();
function digest(text) {
  return [...String(text ?? "")].reduce((h, c) => h * 31 + c.charCodeAt(0) >>> 0, 7).toString(16);
}
function reviewRecord(extra) {
  return {
    schemaVersion: 1,
    runtime: "claude-code",
    craftVersion: CRAFT_VERSION,
    kind: "workflow",
    name: "review",
    nested: !!viaArg,
    via: viaArg || null,
    branch,
    head,
    languages: active.map((p) => p.id),
    uncoveredFiles,
    lensRounds: results.flatMap((r) => (r.lensRounds || []).map((x) => ({ language: r.profile.id, ...x }))),
    scout: results.map((r) => ({ language: r.profile.id, size: r.plan.sizeBucket, lenses: r.plan.lenses, model: r.plan.lensModel, maxRounds: r.plan.maxRounds, verifyVotes: r.plan.verifyVotes, securitySensitive: !!r.plan.securitySensitive, isLibrary: !!r.plan.isLibrary })),
    gate: runGate,
    // The optional pass, on the record: `skipped` is the field that keeps a cheap run from reading
    // later — in analyze-runs, in a comparison between two runs — as a full one.
    optionalPass: { requested: optionalRequested, ...optionalTally(), namedByCritic: [...optionalNamedByCritic] },
    // realm @nick/craft #102: surfaceGate recorded for later analyze-runs measurement. Mirrors
    // optionalPass so a cheap surface-gated run does not read later as one that never planned those
    // whole-repo lenses: `dropped` is the load-bearing field, `namedByCritic` the lenses the
    // completeness critic flagged that the gate deliberately kept dropped. Built by surfaceGateRecord
    // from the per-profile `surfaceDropped`: only profiles past their mechanical gate count (a red
    // profile's drops were never in play), and a lens dropped in one profile but dispatched in
    // another (a mixed-diff run) is not counted as saved — the same set surfaceGateSection() prints.
    // Run-level across profiles (same scope as optionalPass), sorted and unique. `dispatched` is read
    // directly off `surfaceGateDispatched` — the same dispatch-point Set the saving subtracts, and the one source that survives the
    // gateFailed early-exit — so analyze-runs can compute a share (saved / (saved + dispatched))
    // without trusting the per-profile `dimensions` snapshot, which does not.
    surfaceGate: surfaceGateRecord(results, { dispatched: surfaceGateDispatched, namedByCritic: surfaceGateNamedByCritic }),
    // Every breach of the preflight probe budget, per language. Recorded on EVERY run, clean or
    // not: the point of the audit is that the next drift back into CI archaeology shows up in the
    // record of the run that did it, not in a re-measurement months later.
    preflightProbeViolations: results.flatMap((r) => (r.probeViolations || []).map((v) => `[${r.profile.id}] ${v}`)),
    // realm @nick/craft #104: did re-review memory engage this run, and if not, why. `chained` is false
    // with reason 'no-branch' on a detached HEAD — the silent round-1 degradation this field makes
    // legible in the record (the operator-facing half is reReviewMemorySection() in the report).
    reReview: { chained: reReview.chained, reason: reReview.reason, basisVerdict: priorBasisVerdict, basisMismatch: priorBasisMismatch, basisOverridesLogger, fpComparable: priorFpComparable, tombstonesDropped: tombstonesDroppedForBasis, ledgerDegraded: priorLedgerDegraded, journalSourced: priorRoundJournalSourced, priorRound: priorRound?.round ?? null, priorHead: priorRound?.head ?? null },
    // What the lenses were run over and how, so a later comparison of two rounds can tell a memory
    // effect from a scope or configuration effect (lib/round-pairs.mjs, realm @nick/craft #97): a
    // `delta` round on an unchanged head reviews an empty diff.
    lensScope: fullRescan ? "full" : "delta",
    strict,
    fullEvery,
    // One name and one shape with rust-audit, keyed by agent type (lib/agent-fallback.mjs, realm @nick/craft #151).
    ...agentUnavailableRecord(
      reviewerAgentUnavailable.map((x) => x.agent),
      Object.entries(reviewerAgentFallbacks).map(([id, count]) => ({ agent: reviewerAgentNames[id] || id, count }))
    ),
    // Against which base and path the diff was taken, which lenses the critic added on top of the plan,
    // and a digest of the caller's intent text (it feeds the intent lens) — all of which change what a
    // round costs without being memory (lib/round-pairs.mjs, realm @nick/craft #97).
    base: baseRef || "",
    path: pathArg || "",
    criticFollowups: results.flatMap((r) => (r.criticFollowupLenses || []).map((l) => `${r.profile.id}:${l}`)).sort(),
    intentDigest: digest(intentArg),
    // The author's description that reaches every lens (PR title/body or commit messages), and the
    // changed-file set the diff was taken over — both fetched each round, both change what a round does.
    specDigest: digest(spec),
    filesDigest: digest([...changedFiles].sort().join(`
`)),
    outputTokens: budget.spent(),
    ...extra
  };
}
async function gateFailedExit() {
  return await logRun(reviewRecord({ verdict: "Block", round: thisRound, findings: summarizeFindings([]), dimensions: [], verification: null, notRun: [...scopeNotRun], failedChecks: gateFailed.flatMap((r) => (r.failedChecks || []).map((c) => `[${r.profile.id}] ${c}`)) })), out([
    "## Verdict",
    `⛔ Block — mechanical gate is red (${gateFailed.map((r) => r.profile.id).join(", ")}).`,
    "",
    "## Gate",
    mergedProvenance,
    `
Failed checks:
${gateFailed.flatMap((r) => (r.failedChecks || []).map((c) => `- [${r.profile.id}] ${c}`)).join(`
`)}`,
    carriedSection(),
    scopeSection(),
    "",
    "Fix the gate before a semantic review is worthwhile."
  ].join(`
`));
}
if (gateFailed.length) return await gateFailedExit();
let confirmed = results.flatMap((r) => r.confirmed), suspected = results.flatMap((r) => r.suspected), unverified = results.flatMap((r) => r.unverified || []);
const adjudicated = { resolved: [], stillOpen: [], regressed: [], carried: [], retired: [] }, priorTombstones = [];
function carryUnverifiedPriors(priorUnverified, priorRound2) {
  priorUnverified.length && (log(`${priorUnverified.length} prior finding(s) carry the unverified tier — never checked against the code, so nothing to adjudicate: carried forward as unverified rather than promoted to still-open`), unverified = unverified.concat(priorUnverified.map((f) => ({
    ...f,
    fix: f.fix || "verify it first — nothing has checked this claim against the code",
    blastRadius: f.blastRadius || "",
    tier: "unverified",
    // Flagged so the tracking pass below can use these as HOSTS. They are not in `livePriors` —
    // they were never adjudicated — so without the flag a fresh unverified re-discovery of the
    // same site is neither marked nor collapsed, and the site gains a ledger row every round.
    carriedUnverified: !0,
    why: `${baseWhy(f.why)} (STILL NOT VERIFIED: carried from round ${priorRound2.round}, where no verifier judged it; nothing has checked it against the code since)`
  }))));
}
async function adjudicatePriors() {
  if (priorRound?.ledger?.length) {
    phase("Adjudicate");
    const priorLedgerAll = priorRound.ledger.map((f) => ({ ...f, severity: canonicalSeverity(f.severity) }));
    priorTombstones.push(...priorLedgerAll.filter((f) => f.disposition === "closed"));
    const priorLive = priorLedgerAll.filter((f) => f.disposition !== "closed"), priorUnverified = priorLive.filter((f) => String(f.tier || "") === "unverified");
    carryUnverifiedPriors(priorUnverified, priorRound);
    const priorLedger = priorLive.filter((f) => String(f.tier || "") !== "unverified"), settled = priorLedger.filter((f) => f.disposition === "rejected" || f.disposition === "justified"), toCheck = priorLedger.filter((f) => !(f.disposition === "rejected" || f.disposition === "justified")), carriedResults = (await parallel(settled.map((f) => () => {
      const pf = promptFields(f);
      return ragent(
        `A prior review finding was dismissed by the author (disposition: ${f.disposition}). Decide only whether the CODE AROUND IT CHANGED since commit ${flattenField(priorRound.head)}. Shell + read only.
FINDING: [${pf.severity}] ${pf.title} — at ${pf.file}:${f.line} (symbol ${pf.symbol}), rule ${pf.ruleId}.
Run \`git diff ${priorRound.head ? `${shq(priorRound.head)}...HEAD` : "HEAD"} -- ${shq(f.file)}\` and judge whether the enclosing symbol/region was touched. Return {changed: <bool>, reason}.`,
        { label: `carry:${f.file}:${f.line}`, phase: "Adjudicate", schema: CHANGED_SCHEMA, model: CULL_MODEL }
      ).then((r) => ({ f, changed: r == null ? null : !!r.changed }));
    }))).filter((x) => x != null);
    let carryDied = 0;
    const applyCarry = (c) => {
      const { f, changed } = c;
      changed === null ? (carryDied++, log(`⚠️ carry-check for ${f.file}:${f.line} died — kept as carried by default`), adjudicated.carried.push(f)) : changed ? adjudicated.stillOpen.push({ ...f, why: `${baseWhy(f.why)} (reopened: dismissed as ${f.disposition}, but the code around it changed — re-verify the justification)` }) : adjudicated.retired.push(f);
    };
    for (const c of carriedResults) applyCarry(c);
    const adjudModel = results[0]?.plan?.lensModel || "opus";
    let overturned = 0, redTeamDied = 0, invalidRedTeam = 0, adjudicatorDied = 0, cannotTellCount = 0;
    const redTeam = async (f, adj) => {
      if (!isHighSeverity(f.severity)) return adj;
      const pf = promptFields(f), rt = await ragent(
        `A code-review finding was raised on an earlier revision of this repo and the author has since pushed fix commits. Attack the fix. Shell + read only; do NOT hunt for unrelated bugs.
FINDING: [${pf.severity}] ${pf.title}
  originally at ${pf.file}:${f.line} (enclosing symbol ${pf.symbol}), rule ${pf.ruleId}
  why it mattered: ${sanitizeAttack(withoutAbsorbed(f.why))}${absorbedPromptBlock(f.why)}
INVARIANT it violated: ${redTeamInvariant(adj, f)}
METHOD: re-locate the symbol (grep it — the line has likely moved), read the current code, and try to CONSTRUCT a concrete input/state that violates the invariant even with the current code in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check every candidate against the actual code paths before claiming it works.
Return {defeated, attack} — defeated=true ONLY with a concrete attack that survives your own check against the code.`,
        { label: `redteam:${f.file}:${f.line}`, phase: "Adjudicate", schema: ATTACK_SCHEMA, model: adjudModel }
      ), { adj: out2, died, overturned: ov, invalid } = classifyRedTeam(f, adj, rt);
      return died && (redTeamDied++, log(`⚠️ red-team for ${f.file}:${f.line} died — "resolved" stands on the adjudicator's own attack pass only`)), invalid && (invalidRedTeam++, log(`⚠️ red-team for ${f.file}:${f.line} claimed defeat with NO attack — invalid verdict discarded, keeping resolved`)), ov && overturned++, out2;
    }, checkResults = (await parallel(toCheck.map((f) => () => {
      const pf = promptFields(f);
      return ragent(
        `You are adjudicating whether a prior review finding is still present after a fix attempt. Load the ${/** @type {Profile} */
        active[0].rubricSkill} skill for the rubric. Shell + read only; do NOT hunt for new bugs.
FINDING: [${pf.severity}] ${pf.title}
  originally at ${pf.file}:${f.line} (enclosing symbol ${pf.symbol}), rule ${pf.ruleId}
  why it mattered: ${sanitizeAttack(withoutAbsorbed(f.why))}${absorbedPromptBlock(f.why)}
METHOD:
  1. State in ONE sentence the INVARIANT this finding violated — the property that must hold, not the literal repro (derive it from the why/title).
  2. Re-locate the symbol (grep it — the line has likely moved) and read the fix.
  3. Construct AT LEAST TWO concrete attacks: inputs/states that would violate the invariant while the current fix is in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check each against the actual code.
  4. Decide:
  - "resolved": every attack fails — the fix closes the CLASS, not just the described instance.
  - "still-open": the defect is still present OR one of your attacks succeeds (cite the current file:line; put the attack in \`attack\`).
  - "cannot-tell": you could NOT determine the answer — the file is gone or renamed, the symbol no longer exists, or you could not read enough of the code to judge. Say why in \`note\`. Use this rather than "resolved" whenever you are guessing: "resolved" means you checked and every attack failed, never "I could not find it".
  - "regressed": the site was changed but now has a DIFFERENT defect of the same kind (cite it).
Return {status, currentLine, note, invariant, attack}.`,
        { label: `adjudicate:${f.file}:${f.line}`, phase: "Adjudicate", schema: ADJUDICATE_SCHEMA, model: adjudModel }
      ).then(async (r) => ({ f, r: r && shouldRedTeam(r) ? await redTeam(f, r) : r }));
    }))).filter((x) => x != null), tallyAdjudication = (c) => {
      const { f, r } = c, { track, entry, demoted, cannotTell, adjudicatorDied: adjDied } = adjudicateOne(f, r);
      demoted && log(`⚠️ adjudicator for ${f.file}:${f.line} returned resolved WITH an attack — demoting to still-open`), cannotTell && (cannotTellCount++, log(`⚠️ adjudicator for ${f.file}:${f.line} could not tell — kept still-open, marked UNVERIFIED in the report`)), adjDied && (adjudicatorDied++, log(`⚠️ adjudicator for ${f.file}:${f.line} died — no verdict returned; kept still-open by default`)), adjudicated[track].push(entry);
    };
    for (const c of checkResults) tallyAdjudication(c);
    log(`Adjudicate: ${adjudicated.resolved.length} resolved · ${adjudicated.stillOpen.length} still-open · ${adjudicated.regressed.length} regressed · ${adjudicated.carried.length} carried · ${adjudicated.retired.length} carried→retired (code unchanged; leaves the ledger) · ${overturned} overturned by red-team · ${redTeamDied} red-team died · ${invalidRedTeam} invalid red-team · ${adjudicatorDied} adjudicator died · ${cannotTellCount} could not tell · ${carryDied} carry died`);
  }
}
await adjudicatePriors();
function absorbIntoLivePriors(livePriors, retired) {
  const { runs, updates, absorbed, keptAtRetired } = absorbAcross([confirmed, suspected], livePriors, retired, matchesPrior);
  for (const [host, why] of updates) host.why = why;
  confirmed = /** @type {(typeof runs)[number]} */
  runs[0].kept, suspected = /** @type {(typeof runs)[number]} */
  runs[1].kept, absorbed && log(`Re-review: absorbed ${absorbed} new finding(s) into a still-live prior at the same file+rule — recorded on the prior's why (and delivered to next round's adjudicator as its own prompt lines) so they outlive it, not listed twice`), keptAtRetired && log(`Re-review: ${keptAtRetired} new finding(s) matched a prior that RETIRED this round — kept as findings rather than absorbed into a host that does not reach the next ledger`);
}
function trackUnverifiedAtPriors(trackingHosts, retired, carriedUnverified) {
  const tracked = markTrackedUnverified(unverified.filter((f) => !f.carriedUnverified), trackingHosts, retired, matchesPrior);
  unverified = tracked.kept.concat(carriedUnverified);
  for (const [host, why] of tracked.updates) host.why = why;
  tracked.marked && log(`Re-review: ${tracked.marked} unverified finding(s) sit at a site a still-live prior already tracks — noted on each, NOT absorbed into the prior: nothing checked them, so they may not hold it open`), tracked.collapsed && log(`Re-review: ${tracked.collapsed} unverified finding(s) sit at a site an equally UNVERIFIED prior already holds in the ledger — shown in this round's report but not persisted as a second ledger row, so an unchecked site does not gain a row per round`);
}
function unknownBasisWhy() {
  return priorBasisMismatch ? "the revisions the loader printed did not survive transport intact (the list no longer matches its own check string) — a transport or version-skew loss" : Array.isArray(priorRound?.priorFpRevisions) || typeof priorRound?.fpBasisKnown == "boolean" ? "it was recovered from a stopped run whose checkpoints do not attest to one basis, its record could not be read, or it was written by an engine this one cannot place (no engine revision, or a newer one: a downgrade, or two installs sharing one store)" : "the loader's answer did not say whether the basis was known (a relay that dropped the field, or a logger older than it) — a transport or version-skew loss";
}
function dropTombstonesForBasis() {
  if (tombstonesDroppedForBasis = priorTombstones.length, priorBasisVerdict === "absent") {
    const note = `The prior round's answer carried no fingerprint-basis verdict (sameFpBasis), so its ${priorTombstones.length} resolved/dismissed finding(s) were not compared against this round and are no longer remembered. This is a transport or version-skew loss, not a fingerprint-basis change.`;
    reReviewMemoryNote = reReviewMemoryNote ? `${reReviewMemoryNote}
${note}` : note, log(`⚠️ ${note}`);
  } else if (priorBasisVerdict === "unknown") {
    const note = `The fingerprint basis of the prior round could not be established — ${unknownBasisWhy()} — so its ${priorTombstones.length} resolved/dismissed finding(s) were not compared against this round and are no longer remembered.`;
    reReviewMemoryNote = reReviewMemoryNote ? `${reReviewMemoryNote}
${note}` : note, log(`⚠️ ${note}`);
  } else
    log("Re-review: the prior round was fingerprinted under a different, known basis — so the recidivism check is skipped and its " + priorTombstones.length + " carried tombstone(s) are dropped; the memory rebuilds from this round on (expected once, right after an upgrade that changed the basis)");
}
function flagReturningDefects() {
  const tombstoneByFp = /* @__PURE__ */ new Map();
  for (const t of priorTombstones) t.ruleId && tombstoneByFp.set(t.fp || fingerprint(t), t);
  let regressions = 0, reraised = 0;
  const flagRegression = (f) => {
    if (!f.ruleId) return;
    const hit = tombstoneByFp.get(fingerprint(f));
    if (!hit) return;
    const why = String(hit.why || ""), m = /round (\d+)/.exec(why), r = m ? m[1] : (
      /** @type {{ round?: unknown }} */
      hit.round || "?"
    );
    /^dismissed /.test(why) ? (f.why = `${f.why} NOTE: a defect the author dismissed in round ${r} has been re-raised.`, reraised++) : (f.why = `${f.why} REGRESSION: this exact defect was resolved in round ${r} and has reappeared.`, regressions++);
  };
  confirmed.forEach(flagRegression), suspected.forEach(flagRegression), unverified.filter((f) => !f.carriedUnverified).forEach(flagRegression), regressions && log(`Re-review: ${regressions} fresh finding(s) match a defect RESOLVED in an earlier round — annotated as REGRESSION in the report; the verdict still counts each by its severity`), reraised && log(`Re-review: ${reraised} fresh finding(s) match a defect the author DISMISSED in an earlier round — annotated as re-raised, not a regression; the verdict still counts each by its severity`);
}
function reconcileWithPriors() {
  if (priorRound) {
    const livePriors = [...adjudicated.stillOpen, ...adjudicated.regressed, ...adjudicated.carried, ...adjudicated.retired], retired = new Set(adjudicated.retired), carriedUnverified = unverified.filter((f) => f.carriedUnverified);
    livePriors.length && absorbIntoLivePriors(livePriors, retired);
    const trackingHosts = [...livePriors, ...carriedUnverified];
    trackingHosts.length && trackUnverifiedAtPriors(trackingHosts, retired, carriedUnverified), priorTombstones.length && !priorFpComparable ? dropTombstonesForBasis() : priorTombstones.length && flagReturningDefects();
  }
}
reconcileWithPriors();
const dropped = results.reduce((n, r) => n + r.dropped, 0), thinned = results.flatMap((r) => [...r.confirmed, ...r.suspected, ...r.refuted || [], ...r.unverified || []]).filter((f) => (f.votesDiscarded || 0) > 0).length, notRun = [...scopeNotRun, ...results.flatMap((r) => r.notRun)], savedByFloor = results.flatMap((r) => r.savedByFloor || []), coverageNotes = uncoveredGap.length ? [uncoveredNotRunNote(uncoveredGap)] : [], incompleteNotes = [...notRun, ...coverageNotes], criticNotes = results.map((r) => r.criticNotes).filter((n) => n && n.trim() && n.trim() !== "coverage complete").map((n) => n.trim()).join(" · "), hasAdjudicated = hasAdjudicatedTracks();
function hasAdjudicatedTracks() {
  return !!(adjudicated.stillOpen.length || adjudicated.regressed.length || adjudicated.resolved.length || adjudicated.carried.length || adjudicated.retired.length);
}
function nothingSurvived() {
  return !confirmed.length && !suspected.length && !unverified.length && !hasAdjudicated && !priorTombstones.length && !priorRejected.length;
}
async function noFindingsExit() {
  const earlySuffix = verdictSuffix({ notRun, coverageNotes });
  await logRun(reviewRecord({ verdict: `Approve${earlySuffix}`, round: thisRound, findings: summarizeFindings([]), dimensions: [], verification: { candidates: dropped, confirmed: 0, refuteRate: refuteRate(dropped, dropped) }, notRun }));
  const verdictLine = earlySuffix ? `⚠️ Approve${earlySuffix} — gate ${mergedGateStatus}; no findings survived, but ${incompleteNotes.join("; ")} — this verdict covers ONLY what ran. Files listed as matching no language profile are outside this engine (${supportedLangLabel(PROFILES)}) and re-running will not review them — review them by hand or with a tool that speaks their language${notRun.length ? "; anything else in the list is a failure to fix and re-run" : ""}.` : `✅ Approve — gate ${mergedGateStatus}; no findings across ${active.map((p) => p.id).join("+")}.`;
  return out([
    "## Verdict",
    verdictLine,
    "",
    "## Gate",
    mergedProvenance,
    carriedSection(),
    ...uncoveredFiles.length ? ["", "## Not reviewed (no language profile)", ...uncoveredFiles.map((f) => `- ${f}`)] : []
  ].join(`
`) + scopeSection());
}
let priorRejected = [], priorRejectedLive = 0;
async function setAsidePriorDecisions() {
  const live = adjudicated.stillOpen.length + adjudicated.regressed.length, r = await applyPriorDecisions({ confirmed, suspected, unverified, stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed }, priorDecisionsIn.decisions, (toCheck) => ragent(
    REPO_DIRECTIVE + scopeCheckPrompt(toCheck),
    { label: "decision-scope", phase: "Synthesize", schema: SCOPE_CHECK_SCHEMA, model: CULL_MODEL }
  ));
  confirmed = r.tiers.confirmed || [], suspected = r.tiers.suspected || [], unverified = r.tiers.unverified || [], adjudicated.stillOpen = r.tiers.stillOpen || [], adjudicated.regressed = r.tiers.regressed || [], priorRejectedLive = live - adjudicated.stillOpen.length - adjudicated.regressed.length, priorRejected = r.setAside.map((f) => /^(confirmed|suspected|unverified)$/.test(f.priorTier) ? f : { ...f, priorTier: "confirmed" });
  for (const n of r.notes) log(`priorDecisions: ${n}`);
  priorDecisionsIn.refused.push(...r.refused);
}
if (await setAsidePriorDecisions(), nothingSurvived()) return await noFindingsExit();
const UNVERIFIED_PREAMBLE = "These were not verified: no verifier was spent on them because a Low/Info finding cannot change the verdict, or because the verdict was already fixed at Block by a confirmed Critical/High and a Medium cannot move it, or the verifier that should have judged them died before returning a verdict, or every vote the panel DID return answered off-schema and carried none of the judgements the tier is decided on — each entry says which in its own `why`. Nothing below has been checked against the code — treat each as a lead, not a finding.";
phase("Synthesize");
const isRereview = !!priorRound, rereviewData = rereviewDataOf();
function rereviewDataOf() {
  return isRereview ? {
    resolved: adjudicated.resolved,
    stillOpen: adjudicated.stillOpen,
    // `retired` is NOT folded into `carried`: they answer different questions for the reader. A
    // carried prior is re-checked next round; a retired one leaves the ledger, and on a full rescan
    // its re-discovery is kept as a New Confirmed finding — so folding them made the report say a
    // defect was "carried forward unchanged" while listing the same defect under New.
    regressed: adjudicated.regressed,
    carried: adjudicated.carried,
    retired: adjudicated.retired,
    neu: confirmed
  } : null;
}
const incompleteClause = incompleteClauseOf();
function incompleteClauseOf() {
  return incompleteNotes.length ? ` Append " · ⚠️ ${notRun.length ? "INCOMPLETE — part of this review did not run" : "PARTIAL COVERAGE — a coverage hole a re-run will not fix"}: ${incompleteNotes.join("; ")}; findings may be undercounted." to the verdict line.` : "";
}
let synthesisUnusable = !1;
async function synthesize() {
  return ragent(
    `You are consolidating a code review (languages: ${active.map((p) => p.id).join(", ")}) into ONE markdown report. Do NOT invent findings — only use what is given.

VERDICT RULE: the verdict is driven ONLY by Confirmed findings.
- ⛔ Block if any Confirmed Critical or High.
- ⚠️ Warning if Confirmed Medium only.
- ✅ Approve if no Confirmed Critical/High/Medium.
Suspected findings NEVER change the verdict — they are surfaced for the author. UNVERIFIED findings were never checked at all — EITHER no verifier was spent (a Low/Info cannot move the verdict) OR the verifier that should have judged them died before returning one OR every vote it did return was off-schema and unreadable, so a Critical or High can carry this tier. They change nothing and must never be presented as confirmed, as checked, or as cheap.${strict ? '\nSTRICT MODE: the maintainability bar is a presumption of block — if ANY Confirmed finding has source "maintainability" (or lists "maintainability" among its merged `sources`) at Medium or above, the verdict is ⛔ Block (state in the verdict line that strict maintainability mode escalated it).' : ""}

CALIBRATE severities across the Confirmed set so the same kind of issue is not Critical in one place and Medium in another; adjust outliers and say so in one line if you do. For any resource-exhaustion / algorithmic-complexity finding (SAF-009), severity must be MEASURED, not inherited from "same class as X" — a shared mechanism implies nothing about shared magnitude. Demand attack cost against a REAL-DATA baseline (not just the PoC's own numbers) and attacker-bytes-per-victim-CPU-second; where the finding carries no such measurement, say so and rate it conservatively rather than borrowing a neighbour's label.

DEDUPLICATE across lenses: findings that describe the same underlying defect (same file, same/overlapping lines, fixes that collapse into one edit) MUST be merged into ONE entry — keep the highest severity and the clearest why, credit the other lens in one clause. Never list per-lens duplicates as separate findings.

${isRereview ? `This is a RE-REVIEW (round ${thisRound}). Produce, in order:
1. \`## Verdict\` — driven ONLY by Still-open + Regressed + New Confirmed findings (Block on any Critical/High; Warning on Medium; else Approve). Resolved and Carried NEVER change the verdict.${incompleteClause}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.${carriedLine}
3. \`## ✅ Resolved\` — prior findings the fixes closed (one line each); omit if empty.
4. \`## 🔴 Still open\` — prior findings still present; \`severity · file:line · [ruleId] · what · why\`; omit if empty.
5. \`## ⚠️ Regressed\` — new defects the fixes introduced at a prior site; omit if empty.
6. \`## 🆕 New\` — Confirmed findings from the delta lenses (same format); omit if empty.
6b. \`## Unverified (not checked)\` — the UNVERIFIED JSON below, same format, and OPEN the section with exactly this sentence: "${UNVERIFIED_PREAMBLE}" Never merge these into New, Still open or Carried, never call them confirmed, and do not re-rank or upgrade their severity. They change nothing about the verdict. Omit the section if empty.
7. \`## 🔽 Carried\` — dismissed priors (rejected/justified) that are re-checked again next round, collapsed to a count + one-line list; omit if empty.
7b. \`## 🏁 Retired\` — dismissals whose code has not moved since the author ruled on them: they leave the ledger and are NOT re-checked again. Collapse to a count + one-line list; omit if empty. If a defect here also appears under \`## 🆕 New\`, say so on its line — the dismissal stopped being tracked and the site was raised afresh; that is expected, not a contradiction.${uncoveredFiles.length ? `
8. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ""}${criticNotes ? `
9. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ""}
RE-REVIEW DATA (JSON): ${JSON.stringify(rereviewData, null, 2)}` : `Produce, in order:
1. \`## Verdict\` — one line (emoji + reason).${incompleteClause}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.${carriedLine}
3. \`## Confirmed\` — findings by severity (Critical first), each as \`severity · file:line · [ruleId] · what · why · fix\` and a blast-radius note when present. Include the \`ruleId\` in brackets when the finding has a non-empty one; omit the brackets otherwise. When a finding carries a non-empty \`whereChecked\`, append \`· Premise checked at: <value>\` — that is the off-site evidence the author needs in order to re-check the claim, not decoration.
4. \`## Suspected (needs confirmation)\` — findings a verifier DID examine and could not confirm; same format; omit the section if empty.
5. \`## Unverified (not checked)\` — same format, and OPEN the section with exactly this sentence: "${UNVERIFIED_PREAMBLE}" Never merge these into Confirmed or Suspected, never call them confirmed, and do not re-rank or upgrade their severity. Omit the section if empty.
6. \`## Fix first\` — the few highest-leverage Confirmed items.
${uncoveredFiles.length ? `7. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ""}
${criticNotes ? `8. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ""}`}

CONFIRMED (JSON): ${JSON.stringify(confirmed, null, 2)}

SUSPECTED (JSON): ${JSON.stringify(suspected, null, 2)}

UNVERIFIED — NOT CHECKED (JSON): ${JSON.stringify(unverified, null, 2)}`,
    { label: "synthesis", phase: "Synthesize", effort: "medium" }
    // Without a schema the answer is the agent's final text; anything else is no report at all — but a
    // LIVE agent that answered with a non-string, or with blank text, did not die, and the fallback must
    // not say it did: every non-null answer that reaches the fallback is an unusable one.
  ).then((text) => {
    if (typeof text == "string" && text.trim()) return text;
    if (text != null) {
      synthesisUnusable = !0;
      const what = typeof text == "string" ? "blank text" : Array.isArray(text) ? "an array" : `a value of type ${typeof text}`;
      log(`⚠️ synthesis agent answered with ${what}, not report text — discarded; using the mechanical fallback report`);
    }
    return null;
  });
}
const report = await synthesize();
async function postPrComments() {
  if (postComments && confirmed.length) {
    const posted = await ragent(
      `Post these Confirmed code-review findings as inline comments on the current branch's PR using \`gh\`. If gh is missing/unauthenticated or there is no PR, post nothing and say so in \`reason\` — never fail.
For each finding with a real file:line, add a review comment anchored to that file:line whose body is the finding's \`body\` VERBATIM — its first line and its last line (an HTML comment) are how a later session ties a reply to the finding. Findings:
${JSON.stringify(confirmed.map((f) => ({ file: f.file, line: f.line, body: findingCommentBody(f) })), null, 2)}
Return {posted: <how many comments you actually created>, reason: <one line: the PR you posted to, or why nothing was posted>}.`,
      { label: "pr-comments", phase: "Synthesize", effort: "low", schema: PR_COMMENTS_SCHEMA }
    );
    posted == null ? log(`⚠️ PR comments: the poster agent returned nothing — ${confirmed.length} Confirmed finding(s) may or may not have been posted; check the PR`) : Number(posted.posted) > 0 ? log(`PR comments: posted ${Number(posted.posted)} of ${confirmed.length} Confirmed finding(s) — ${posted.reason || "no detail"}`) : log(`⚠️ PR comments: nothing was posted (${confirmed.length} Confirmed finding(s) requested) — ${posted.reason || "no reason given"}`);
  }
}
await postPrComments();
const allReviewFindings = confirmed.concat(suspected, unverified), totalVerified = confirmed.length + suspected.length + dropped + priorRejected.filter((f) => f.priorTier !== "unverified").length - priorRejectedLive;
function decideRecordVerdict() {
  let recordVerdict2 = isRereview ? rereviewVerdict({ stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed, neu: confirmed }) : finalVerdict(confirmed);
  return isRereview && strict && [...adjudicated.stillOpen, ...adjudicated.regressed, ...confirmed].some((f) => isMaintainability(f) && (f.severity === "Critical" || f.severity === "High" || f.severity === "Medium")) && (recordVerdict2 = "Block"), recordVerdict2;
}
const recordVerdict = decideRecordVerdict(), floorPremiseHeld = !savedByFloor.length || recordVerdict === "Block";
function reportRevokedPremise() {
  floorPremiseHeld || (notRun.push(...savedByFloor.map((n) => `${n} — AND THE PREMISE DID NOT HOLD: the run ended at ${recordVerdict}, not Block, so the saving rested on a confirmed finding that did not reach the verdict; re-run to check them`)), log(`⚠️ ${savedByFloor.length} verification(s) were skipped because the verdict was already Block, but the run ended at ${recordVerdict} — the skipped findings are reported as a coverage hole, not as a saving`));
}
reportRevokedPremise();
const toLedgerEntry = (f, disposition, tier) => ({
  ...ledgerLocation(f),
  severity: f.severity,
  tier: tier || f.tier || "suspected",
  disposition: disposition || f.disposition || "open",
  source: f.source || "",
  ruleId: f.ruleId || "",
  title: f.title || "",
  why: String(f.why || "").split(TRACKED_MARK).join("").replace(THINNED_CLAUSE, ""),
  ...ledgerSources(f),
  ...ledgerWhyRef(f)
});
function ledgerLocation(f) {
  return { fp: f.fp || fingerprint(f), file: f.file || "", line: f.line || 0, symbol: f.symbol || "" };
}
function ledgerSources(f) {
  return Array.isArray(f.sources) ? { sources: (
    /** @type {unknown[]} */
    f.sources
  ) } : {};
}
function ledgerWhyRef(f) {
  return f.whyRef && typeof f.whyRef.record == "string" && typeof f.whyRef.fp == "string" ? { whyRef: { record: f.whyRef.record, fp: f.whyRef.fp } } : {};
}
const toTombstone = (f, origin = "resolved") => {
  const { whyRef: _whyRef, ...entry } = toLedgerEntry(f, "closed", f.tier);
  return { ...entry, fp: fingerprint(f), why: `${origin} in round ${thisRound}` };
}, liveLedgerCount = confirmed.length + suspected.length + unverified.filter((f) => !f.ledgerDupOfUnverifiedPrior).length + adjudicated.stillOpen.length + adjudicated.regressed.length + adjudicated.carried.length + priorRejected.length, tombstones = assembleTombstones();
function assembleTombstones() {
  return pruneTombstones([
    ...adjudicated.resolved.map((f) => toTombstone(f, "resolved")),
    ...adjudicated.retired.map((f) => toTombstone(f, "dismissed")),
    // Carried tombstones from an incomparable fingerprint basis are dropped, not carried forward under a
    // stale basis: a clean baseline after a basis change (or a reported loss when the basis verdict did
    // not arrive). This round's own tombstones are minted under the current basis (toTombstone recomputes
    // `fp`, so even a prior loaded under an old basis gets a current-basis hash) and kept regardless.
    ...priorFpComparable ? priorTombstones : []
  ], { max: tombstoneBudget(liveLedgerCount) });
}
const reviewLedger = assembleLedger();
function assembleLedger() {
  return isRereview ? [
    ...confirmed.map((f) => toLedgerEntry(f, "open", "confirmed")),
    ...suspected.map((f) => toLedgerEntry(f, "open", "suspected")),
    // An unverified finding whose carrier is ITSELF an unverified prior writes no second row: see
    // `ledgerDupOfUnverifiedPrior` in lib/review-adjudicate.mjs for why that host and no other.
    ...unverified.filter((f) => !f.ledgerDupOfUnverifiedPrior).map((f) => toLedgerEntry(f, "open", "unverified")),
    ...adjudicated.stillOpen.map((f) => toLedgerEntry(f, "open")),
    ...adjudicated.regressed.map((f) => toLedgerEntry(f, "open")),
    // `adjudicated.resolved`/`adjudicated.retired` no longer leave the ledger silently: each becomes a
    // lightweight TOMBSTONE (`disposition:'closed'`) so a later round can tell the defect's RETURN
    // from a genuine novelty. It is not a live finding — the carve-out on load keeps it out of the
    // adjudicator — and it costs one bare row, not a re-adjudicated one. The set (this round's plus
    // the earlier ones carried forward) is deduped and capped above; each row keeps its own origin+
    // round marker, which is the round the REGRESSION / re-raised note reports.
    ...tombstones,
    ...adjudicated.carried.map((f) => toLedgerEntry(f, f.disposition)),
    ...priorRejected.map((f) => toLedgerEntry(f, "rejected", f.priorTier))
  ] : allReviewFindings.map((f) => toLedgerEntry(f, "open", f.tier || "suspected")).concat(priorRejected.map((f) => toLedgerEntry(f, "rejected", f.priorTier)));
}
async function persistLedgerShards() {
  for (const shard of shardLedger(reviewLedger))
    await checkpoint(`${LEDGER_SHARD_PHASE}-${String(shard.ledgerShard.index).padStart(2, "0")}`, { branch, head, ...shard }, "Synthesize");
}
await persistLedgerShards(), await logRun(reviewRecord({
  verdict: recordVerdict + verdictSuffix({ notRun, coverageNotes, floorPremiseHeld }),
  savedByFloor,
  // Recorded as its own field, not inferred from the two lists: "the saving was legitimate" and
  // "the saving turned into a hole" are the question any later count of this economy has to ask
  // first, and deriving it from string shapes would break the moment a string is reworded.
  savedByFloorPremiseHeld: floorPremiseHeld,
  round: thisRound,
  findings: summarizeFindings(allReviewFindings),
  ledger: reviewLedger,
  dimensions: results.flatMap((r) => r.plan.lenses.map((l) => {
    const s = summarizeFindings(r.confirmed.filter((f) => (f.source || "") === l)), confirmedCount = r.confirmed.filter((f) => (f.source || "") === l).length, suspectedCount = r.suspected.filter((f) => (f.source || "") === l).length, unverifiedCount = (r.unverified || []).filter((f) => (f.source || "") === l).length, refutedCount = (r.refuted || []).filter((f) => (f.source || "") === l).length, ran = r.ranLenses ? r.ranLenses.includes(l) : !0;
    return { dimension: `${r.profile.id}:${l}`, ran, verdict: "", findingCount: s.total, bySeverity: s.bySeverity, confirmedCount, suspectedCount, refutedCount, unverifiedCount };
  })),
  verification: { candidates: totalVerified, confirmed: confirmed.length, refuteRate: refuteRate(dropped, totalVerified), unverified: unverified.length, thinned },
  notRun
}));
function fallbackReport() {
  const cause = synthesisUnusable ? "synthesis agent returned no usable report" : "synthesis agent died twice", emoji = { Block: "⛔ Block", Warning: "⚠️ Warning", Approve: "✅ Approve" }[isRereview ? recordVerdict : finalVerdict(confirmed)], fmt = (f) => `- ${f.severity} · \`${f.file || "?"}:${f.line || 0}\`${f.ruleId ? ` · [${f.ruleId}]` : ""} · ${f.title} · ${f.why} · Fix: ${f.fix}${f.whereChecked ? ` · Premise checked at: ${f.whereChecked}` : ""}`, bySev = (a) => a.slice().sort((x, y) => (SEV_RANK[x.severity ?? ""] ?? 9) - (SEV_RANK[y.severity ?? ""] ?? 9));
  return [
    "## Verdict",
    // `notRun` LIVE, not the `incompleteNotes` snapshot taken before the verdict existed: the
    // revoked-premise path pushes into `notRun` afterwards, and a fallback rendered from the stale
    // snapshot would print a clean verdict over findings the same run has just declared unchecked.
    `${emoji} — ${cause}; mechanical fallback report (findings listed unmerged).${fallbackIncompleteClause()}`,
    "",
    "## Gate",
    mergedProvenance,
    carriedSection(),
    ...fallbackRereviewTracks(bySev, fmt),
    "",
    `## ${isRereview ? "🆕 New" : "Confirmed"}`,
    ...confirmed.length ? bySev(confirmed).map(fmt) : ["- none"],
    ...suspected.length ? ["", "## Suspected (needs confirmation)", ...bySev(suspected).map(fmt)] : [],
    ...unverified.length ? ["", "## Unverified (not checked)", UNVERIFIED_PREAMBLE, ...bySev(unverified).map(fmt)] : [],
    ...uncoveredFiles.length ? ["", "## Not reviewed (no language profile)", ...uncoveredFiles.map((f) => `- ${f}`)] : []
  ].join(`
`);
}
function fallbackIncompleteClause() {
  return [...notRun, ...coverageNotes].length ? ` · ⚠️ ${notRun.length ? "INCOMPLETE — part of this review did not run" : "PARTIAL COVERAGE — a coverage hole a re-run will not fix"}: ${[...notRun, ...coverageNotes].join("; ")}.` : "";
}
function fallbackRereviewTracks(bySev, fmt) {
  return [
    ...isRereview && adjudicated.stillOpen.length ? ["", "## 🔴 Still open", ...bySev(adjudicated.stillOpen).map(fmt)] : [],
    ...isRereview && adjudicated.regressed.length ? ["", "## ⚠️ Regressed", ...bySev(adjudicated.regressed).map(fmt)] : []
  ];
}
function markVerdictIncomplete(text) {
  if (floorPremiseHeld) return text;
  const lines = String(text).split(`
`), head2 = lines.findIndex((l) => /^#+\s*Verdict\b/i.test(l.trim()));
  if (head2 < 0) return text;
  const at = lines.findIndex((l, i) => i > head2 && l.trim());
  return at < 0 || /INCOMPLETE/.test(
    /** @type {string} */
    lines[at]
  ) ? text : (lines[at] = `${lines[at]} · ⚠️ INCOMPLETE — ${savedByFloor.length} verification(s) were skipped because the verdict stood at Block, and the run did not end at Block; those findings are unverified for a reason that did not apply.`, lines.join(`
`));
}
function floorPremiseSection() {
  return floorPremiseHeld ? "" : `

## ⚠️ INCOMPLETE — a verification saving whose premise did not hold
${savedByFloor.length} batch verification(s) were deliberately not dispatched because the verdict stood at Block when their turn came, and no judgement on a Medium can move a Block. The run ended at ${recordVerdict}. The saving therefore rested on a confirmed finding that did not reach the final verdict, and those findings are UNVERIFIED for no good reason — treat this section as a coverage hole and re-run. They are listed under Unverified above.
` + savedByFloor.map((n) => `- ${n}`).join(`
`);
}
return out(markVerdictIncomplete(report || fallbackReport()) + floorPremiseSection() + priorRejectedSection(priorRejected) + scopeSection());
