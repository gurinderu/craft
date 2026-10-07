// The review engines' own recall of the project's decisions (realm @nick/craft, node #203): a launch
// with no priorDecisions runs ONE read-only agent that invokes the craft:memory skill's recall for the
// diff's paths. It relies on a Workflow agent having the Skill tool and the session's MCP tools as
// deferred tools reachable through ToolSearch, and on the observed path rule of the harness's project
// memory (realm @nick/craft, node #201). What it returns goes through parsePriorDecisions unchanged;
// the report names where the decisions came from and how many were accepted.
// Inlined into workflows/review.js, workflows/adversarial-review.js and workflows/rust-audit.js.

// The most changed paths one recall prompt lists; the rest are counted, and the count is reported.
export const RECALL_PATHS_MAX = 60

export const RECORD_TEXT_FIELDS = ['id', 'kind', 'title', 'body', 'scope', 'status', 'date', 'author', 'commit']

// The record shape of skills/memory/SKILL.md, verbatim.
export const MEMORY_RECALL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['backend', 'why', 'decisions'],
  properties: {
    backend: { type: 'string', description: 'the memory backend recall used, or none' },
    why: { type: 'string', description: 'one line: the rule that chose the backend, or why there is none, or that recall found nothing' },
    decisions: {
      type: 'array', description: 'the matching active decision records, verbatim',
      items: { type: 'object', properties: { ...Object.fromEntries(RECORD_TEXT_FIELDS.map(k => [k, { type: 'string' }])), links: { type: 'array', items: { type: 'string' } } } },
    },
    stale: {
      type: 'array', description: 'matching active decisions that no longer hold against the code, left out of decisions and NOT superseded',
      items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } } },
    },
  },
}

/**
 * The recall agent's prompt: the skill first, its backend order when the skill is unavailable.
 * @param {string[]} paths the diff's changed paths; none → the agent lists them from the base
 * @param {string} base @returns {string}
 */
export function memoryRecallPrompt(paths, base) {
  const listed = paths.slice(0, RECALL_PATHS_MAX)
  const cut = paths.length - listed.length
  const scope = listed.length
    ? `these changed paths of the diff:\n${listed.map(p => `- ${p}`).join('\n')}${cut ? `\n(${cut} more path(s) cut at the bound of ${RECALL_PATHS_MAX} — not recalled for)` : ''}`
    : `the paths of \`git diff --name-only ${base || '$(git merge-base origin/main HEAD)'}...HEAD\``
  return `Recall the remembered decisions of this project for a code review. READ ONLY: write, record, edit or create nothing anywhere (no memory record, no file, no MCP create call).
Scope: ${scope}
1. Invoke the craft:memory skill with the Skill tool and run its recall for those paths: kind decision, status active only, no topic.
2. If that skill is unavailable, follow its backend order yourself; the first that applies wins: (a) an explicit setting, env CRAFT_MEMORY, else a line \`craft-memory: <value>\` in AGENTS.md or CLAUDE.md at the repo root (mcp | harness | repo | none; a pinned backend that is unavailable means none); (b) a connected memory or knowledge-graph MCP server found by capability: load the deferred tools of the session with ToolSearch and take a server whose tools offer both a search over stored items and a create of a new item, judged by what the tools do, never by a server or tool name; use only its search; (c) the project memory files of the harness: Claude Code keeps them in \`~/.claude/projects/<slug>/memory/\` with \`MEMORY.md\` as the index, where <slug> is your own working directory (\`pwd\`, after any cd this review requires) with every character that is not an ASCII letter or digit replaced by \`-\` (observed: \`/home/ubuntu/projects/my/craft\` → \`-home-ubuntu-projects-my-craft\`; \`/.claude/\` → \`--claude-\`) — an observed convention (realm @nick/craft, node #201); list \`~/.claude/projects/\` and take the directory whose name equals that slug; read MEMORY.md, then only the matching files; none equals it: say \`none — harness memory directory for <cwd> not found under ~/.claude/projects/\` and never guess a near match; (d) \`.craft/memory/decision/\` in the repo. None applies: backend none.
3. A record matches a path when its scope equals the path, is a directory containing it, names its component, or is \`.\`.
4. A stale matching decision — one that no longer holds against the code as it is now (its reason is gone): supersede nothing — leave it out of decisions and list it in stale as {id, why}; superseding stays with craft:addressing-findings.
Return {backend, why, decisions, stale}: backend names the store used (or none); why is one line naming the rule that chose it, or why there is none, or that recall found nothing; decisions are the matching active decision records verbatim in the record shape id, kind, title, body, scope, status, date, author, commit, links (nothing rewritten or summarised; [] when none); stale is [] when none.`
}

/** @typedef {{ source: 'passed' | 'recalled' | 'none', count: number, why: string }} MemorySource */
/** @param {unknown} v @returns {string} */
export const recallText = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/** The stale decisions the agent left out, as one line's tail. @param {unknown} list @returns {string} */
export function staleTail(list) {
  const named = (Array.isArray(list) ? list : []).flatMap(x => {
    const r = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' ? x : {})
    const id = recallText(r['id'])
    return id ? [`${id} (${recallText(r['why']) || 'no reason given'})`] : []
  })
  return named.length ? `; stale, left out: ${named.join(', ')}` : ''
}

/**
 * What the recall agent returned, read: the decisions to hand to parsePriorDecisions (a list, possibly
 * empty) and the source to report. A dead or off-shape answer applies nothing and is named.
 * @param {unknown} raw @param {number} cut paths past RECALL_PATHS_MAX @returns {{ decisions: unknown[], memory: MemorySource }}
 */
export function readMemoryRecall(raw, cut) {
  const r = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
  const tail = cut > 0 ? `; ${cut} changed path(s) past the bound of ${RECALL_PATHS_MAX} were not recalled for` : ''
  const list = r['decisions']
  if (!Array.isArray(list)) return { decisions: [], memory: { source: 'none', count: 0, why: `the recall agent died or returned no decision list, so no project memory was applied — findings are raised normally${tail}` } }
  const backend = recallText(r['backend']) || 'an unnamed backend'
  const why = recallText(r['why']) || 'no reason given'
  const stale = staleTail(r['stale'])
  if (!list.length) return { decisions: [], memory: { source: 'none', count: 0, why: `${why} (backend ${backend})${stale}${tail}` } }
  return { decisions: list, memory: { source: 'recalled', count: list.length, why: `${backend} (${why})${stale}${tail}` } }
}

/**
 * The source before any recall: passed by the launcher (any value, an empty list included), or not yet recalled.
 * @param {unknown} raw the priorDecisions argument @param {number} [count] the decisions accepted; the list length by default
 * @returns {MemorySource}
 */
export function initialMemory(raw, count = Array.isArray(raw) ? raw.length : 0) {
  return raw == null || raw === ''
    ? { source: 'none', count: 0, why: 'not recalled — the run ended before its recall step' }
    : { source: 'passed', count, why: 'passed by the launcher' }
}

/**
 * A recalled source once parsePriorDecisions read its list: the count is the records it accepted; the
 * refused are named in their own section. @param {MemorySource} m @param {number} accepted @returns {MemorySource}
 */
export function acceptedMemory(m, accepted) {
  return m.source === 'recalled' ? { ...m, count: accepted } : m
}

/** @param {MemorySource} m @returns {string} */
export function memoryLine(m) {
  if (m.source === 'passed') return `memory: passed by the launcher (${m.count})`
  return m.source === 'recalled' ? `memory: recalled ${m.count} decision(s) from ${m.why}` : `memory: none — ${m.why}`
}

/** The report section naming the source. @param {MemorySource} m @returns {string} */
export function memorySection(m) {
  return `\n\n## Memory\n- ${memoryLine(m)}\n`
}

/**
 * Runs the one recall agent through `ask` (the engine's agent call, schema MEMORY_RECALL_SCHEMA). A
 * refused dispatch (the budget wall) is named and applies nothing: the run meets the same wall on its
 * next dispatch, as it would have without a recall.
 * @param {(prompt: string) => Promise<unknown>} ask @param {string[]} paths @param {string} base
 * @returns {Promise<{ decisions: unknown[], memory: MemorySource }>}
 */
export async function recallDecisions(ask, paths, base) {
  let raw
  try {
    raw = await ask(memoryRecallPrompt(paths, base))
  } catch (e) {
    const msg = recallText(e instanceof Error ? e.message : String(e))
    return { decisions: [], memory: { source: 'none', count: 0, why: `the recall agent did not run (${msg}) — no project memory applied; findings are raised normally` } }
  }
  return readMemoryRecall(raw, Math.max(0, paths.length - RECALL_PATHS_MAX))
}
