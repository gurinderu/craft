// Which name a launch reaches the harness under (realm @nick/craft, node #83). The installed plugin
// registers its engines and agents only under the plugin prefix — `craft:review`, `craft:rust-reviewer` —
// and the Workflow tool resolves a name by exact match over that list, so a launch by the bare name is
// refused. Two readers: an engine's launch sites, found by structure in the parsed script (any `workflow(…)`
// call, any call handed `workflow` to launch through, whatever it is named, and any agent-type property),
// and the prose in skills and agents that names the workflow or agent a model should launch (prose-launch-names.mjs).
import fs from 'node:fs'
import path from 'node:path'

/** @typedef {typeof import('../integrations/opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../integrations/opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode @typedef {import('../integrations/opencode/plugin/node_modules/typescript/lib/typescript.js').Expression} TsExpr @typedef {import('../integrations/opencode/plugin/node_modules/typescript/lib/typescript.js').CallExpression} TsCall */
/** @typedef {import('../integrations/opencode/plugin/node_modules/typescript/lib/typescript.js').PropertyAssignment} TsProp @typedef {import('../integrations/opencode/plugin/node_modules/typescript/lib/typescript.js').ShorthandPropertyAssignment} TsShorthand */
/** @typedef {{ plugin: string, workflows: ReadonlySet<string>, agents: ReadonlySet<string> }} Known */
/** @typedef {Known & { consts: Map<string, (string | null)[]> }} Named  what may be launched, and the script's own literal bindings */
/** @typedef {{ line: number, kind: 'workflow' | 'launcher' | 'agent', start: number, end: number, text: string, problem: string | null }} Site */
/** @typedef {(kind: Site['kind'], at: TsNode, problem: string | null) => void} Add */

const HEAD = 'async function __wf() {\n'
// The keys that carry an agent type in the engines: `agentType`, the sandbox's option, and a profile's
// `reviewerAgent`. A set, not a `…Agent` pattern, so an unrelated property (`userAgent`) is not read as a
// launch; launch-names.test.mjs holds it equal to the keys the shipped engines actually use.
export const AGENT_KEYS = new Set(['agentType', 'reviewerAgent'])
// The one function an engine wraps a consumer repository's own agent type in.
const CONSUMER_AGENT_MARK = 'consumerAgentType'

/**
 * The plugin's name and the ids it ships, read from the checkout: what a launch may name.
 * @param {string} root @returns {Known}
 */
export function launchKnown(root) {
  const mPath = path.join(root, 'integrations', 'claude-code', '.claude-plugin', 'plugin.json')   // absent: plugin '' — the caller fails on that
  const manifest = fs.existsSync(mPath) ? JSON.parse(fs.readFileSync(mPath, 'utf8')) : {}
  const wfDir = path.join(root, 'integrations', 'claude-code', 'workflows')
  const agentsDir = path.join(root, 'integrations', 'claude-code', 'agents')
  const workflows = fs.readdirSync(wfDir).filter(f => f.endsWith('.js'))
    .map(f => /name:\s*'([a-z][a-z0-9-]*)'/.exec(fs.readFileSync(path.join(wfDir, f), 'utf8'))?.[1])
  const agents = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)) : []
  return {
    plugin: typeof manifest.name === 'string' ? manifest.name : '',
    workflows: new Set(/** @type {string[]} */ (workflows.filter(Boolean))),
    agents: new Set(agents),
  }
}

/**
 * Every launch site in one engine script. `start`/`end` are offsets in `src` of the name expression, so a
 * test can break one site at a time; `line` is 1-based in `src`.
 * @param {TS} ts @param {string} src @param {Known} known @returns {Site[]}
 */
export function engineLaunchSites(ts, src, known) {
  // The sandbox's wrapper, as check-workflows compiles it; `export const meta` loses only its keyword (same
  // length), so offsets past the header are offsets in `src`, and the header line makes wrapped lines 1-based.
  const text = HEAD + src.replace(/^export const meta/m, '       const meta') + '\n}\n'
  const sf = ts.createSourceFile('engine.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  /** @type {Site[]} */
  const sites = []
  /** @type {Add} */
  const add = (kind, at, problem) => {
    const s = at.getStart(sf)
    sites.push({ kind, line: sf.getLineAndCharacterOfPosition(s).line, start: s - HEAD.length, end: at.end - HEAD.length, text: at.getText(sf), problem })
  }
  const named = { ...known, consts: constBindings(ts, sf) }
  /** @param {TsNode} node */
  const visit = node => {
    if (ts.isCallExpression(node)) callSite(ts, node, named, add)
    else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) agentSite(ts, node, named, add)
    if (ts.isIdentifier(node) && node.text === 'workflow' && handedOn(ts, node)) {
      add('workflow', node, '`workflow` handed on by alias or inside an object — the launch it makes cannot be read; call workflow(…) or hand `workflow` to a launcher as a call argument')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}

/**
 * Every launch in the given engines, as gate lines, and how many sites were read. No site at all is a
 * problem itself: a check that found nothing to check has not passed (an aliased `workflow` once hid every launch).
 * @param {TS} ts @param {{ f: string, src: string }[]} engines @param {Known} known
 * @returns {{ seen: number, problems: string[] }}
 */
export function launchProblems(ts, engines, known) {
  /** @type {string[]} */
  const problems = []
  let seen = 0
  for (const { f, src } of engines) {
    for (const s of engineLaunchSites(ts, src, known)) {
      seen++
      if (s.problem !== null) problems.push(`${f}:${s.line} :: ${s.problem}`)
    }
  }
  if (!seen) problems.push('no launch site found in any engine — the launch-name check read nothing, so it cannot pass')
  return { seen, problems }
}

/**
 * `workflow` used as a value other than a call's callee or a call's argument — `const wf = workflow`,
 * `{ workflow }`, `{ run: workflow }` — is a launch this reader cannot follow. Declarations and property
 * names that merely spell the word are not uses.
 * @param {TS} ts @param {TsNode} id @returns {boolean}
 */
function handedOn(ts, id) {
  const p = id.parent
  if (ts.isCallExpression(p)) return false
  if ((ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p)) && p.name === id) return false
  if ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)) && p.name === id) return false
  return true
}

/** @param {TS} ts @param {TsNode} node @returns {TsCall | null} the node when it is a `workflow(…)` call */
const workflowCall = (ts, node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'workflow' ? node : null

/**
 * The name's written-out prefix — a literal, or a template's head — else null.
 * @param {TS} ts @param {TsExpr} e @returns {string | null}
 */
function writtenText(ts, e) {
  if (ts.isStringLiteralLike(e)) return e.text
  if (ts.isTemplateExpression(e)) return e.head.text
  return null
}

/** @param {TS} ts @param {TsExpr} e @param {string} plugin */
const qualified = (ts, e, plugin) => plugin !== '' && (writtenText(ts, e) ?? '').startsWith(`${plugin}:`)

/**
 * A bare launch is allowed only as the fallback: inside the `catch` of a `try` that first launched the qualified name.
 * @param {TS} ts @param {TsNode} node @param {string} plugin @returns {boolean}
 */
function inQualifiedFallback(ts, node, plugin) {
  for (let p = node.parent; p && !ts.isFunctionLike(p); p = p.parent) {
    if (ts.isCatchClause(p) && ts.isTryStatement(p.parent) && launchesQualified(ts, p.parent.tryBlock, plugin)) return true
  }
  return false
}

/** @param {TS} ts @param {TsNode} block @param {string} plugin @returns {boolean} */
function launchesQualified(ts, block, plugin) {
  /** @param {TsNode} n @returns {boolean} */
  const hit = n => {
    const first = workflowCall(ts, n)?.arguments[0]
    return (first !== undefined && qualified(ts, first, plugin)) || (ts.forEachChild(n, hit) ?? false)
  }
  return hit(block)
}

/** @param {TS} ts @param {TsCall} call @param {Known} known @param {Add} add */
function callSite(ts, call, known, add) {
  if (workflowCall(ts, call)) return workflowSite(ts, call, known, add)
  const i = call.arguments.findIndex(a => ts.isIdentifier(a) && a.text === 'workflow')
  if (i < 0) return
  const name = call.arguments[i + 1]
  if (!name) return add('launcher', call, 'a call handed `workflow` names no engine after it — the launch cannot be read')
  if (!ts.isStringLiteralLike(name)) return add('launcher', name, 'a call handed `workflow` names its engine by an expression — write the engine\'s name as a literal')
  add('launcher', name, known.workflows.has(name.text) ? null
    : `a call handed \`workflow\` names '${name.text}', which is no workflow's meta.name — the launcher takes the bare name and qualifies it itself`)
}

/** @param {TS} ts @param {TsCall} call @param {Known} known @param {Add} add */
function workflowSite(ts, call, known, add) {
  const first = call.arguments[0]
  if (!first) return add('workflow', call, 'workflow() called with no name')
  if (qualified(ts, first, known.plugin)) {
    const tail = ts.isStringLiteralLike(first) ? first.text.slice(known.plugin.length + 1) : null
    return add('workflow', first, tail === null || known.workflows.has(tail) ? null : `workflow('${known.plugin}:${tail}') names no workflow this plugin ships`)
  }
  add('workflow', first, inQualifiedFallback(ts, call, known.plugin) ? null
    : `workflow(${first.getText()}) launches without the \`${known.plugin}:\` prefix — the installed plugin registers engines only as ${known.plugin}:<name>`)
}

/** @param {TS} ts @param {TsProp | TsShorthand} prop @param {Named} known @param {Add} add */
function agentSite(ts, prop, known, add) {
  const key = agentKey(ts, prop)
  if (key === null) return
  if (ts.isShorthandPropertyAssignment(prop)) return add('agent', prop, `agent type '${key}' given in shorthand — write the agent's name where it is set`)
  agentValue(ts, key, prop.initializer, known, add)
}

/** @param {TS} ts @param {TsProp | TsShorthand} prop @returns {string | null} the key, when it names an agent type */
function agentKey(ts, prop) {
  const key = prop.name
  return (ts.isIdentifier(key) || ts.isStringLiteral(key)) && AGENT_KEYS.has(key.text) ? key.text : null
}

/** @param {TS} ts @param {string} key @param {TsExpr} v @param {Named} known @param {Add} add */
function agentValue(ts, key, v, known, add) {
  // A read of another agent-type property is that property's own site, checked where it is written.
  if (ts.isPropertyAccessExpression(v) && AGENT_KEYS.has(v.name.text)) return
  // The consumer's own agent, by the name its repository gives it, marked as such at the launch: not
  // this plugin's, so no prefix applies (realm @nick/craft, node #295).
  if (consumerMarked(ts, v)) return
  const text = literalOf(ts, v, known)
  if (text == null) {
    return add('agent', v, ts.isIdentifier(v) ? `agent type '${key}' set by '${v.text}', which is not bound once to a literal — bind it once to '${known.plugin}:<agent>'`
      : `agent type '${key}' set by an expression — write '${known.plugin}:<agent>' as a literal`)
  }
  const name = known.plugin !== '' && text.startsWith(`${known.plugin}:`) ? text.slice(known.plugin.length + 1) : null
  add('agent', v, name !== null && known.agents.has(name) ? null
    : `agent type '${text}' is not '${known.plugin}:<agent>' for an agent this plugin ships — the installed plugin registers agents only under its prefix`)
}

/**
 * The text an agent type names: a literal's own, or the literal a name is bound to once in the engine
 * (lib/service-agent.mjs); null for anything else.
 * @param {TS} ts @param {TsExpr} v @param {Named} known @returns {string | null}
 */
function literalOf(ts, v, known) {
  if (ts.isStringLiteralLike(v)) return v.text
  const bound = ts.isIdentifier(v) ? known.consts.get(v.text) : undefined
  return bound?.length === 1 ? bound[0] ?? null : null
}

/**
 * Each variable name declared in the script with the literal text of every declaration of it: null stands for a
 * declaration whose initializer is no string literal, or a `let`/`var` the script assigns anywhere, so such a name
 * is never read as bound to a literal. A `let`/`var` never assigned still binds: the bundler writes an engine's
 * top-level `const` as `var` (lib/build-engines.mjs), and the shipped script is what is read.
 * @param {TS} ts @param {TsNode} sf @returns {Map<string, (string | null)[]>}
 */
function constBindings(ts, sf) {
  /** @type {Map<string, (string | null)[]>} */
  const out = new Map()
  const assigned = assignedNames(ts, sf)
  /** @param {TsNode} node */
  const find = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer
      const list = out.get(node.name.text) ?? []
      const fixed = (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0 || !assigned.has(node.name.text)
      list.push(fixed && init && ts.isStringLiteralLike(init) ? init.text : null)
      out.set(node.name.text, list)
    }
    ts.forEachChild(node, find)
  }
  find(sf)
  return out
}

/**
 * Every name the script assigns after its declaration: `T = …`, `T += …`, `T++`, `--T`, a destructuring target
 * or a `for (T of …)` head.
 * @param {TS} ts @param {TsNode} sf @returns {Set<string>}
 */
function assignedNames(ts, sf) {
  /** @type {Set<string>} */
  const out = new Set()
  /** @param {TsNode} target */
  const targets = target => {
    if (ts.isIdentifier(target)) out.add(target.text)
    else if (ts.isShorthandPropertyAssignment(target)) out.add(target.name.text)
    else if (ts.isPropertyAssignment(target)) targets(target.initializer)
    // `o.T = …` and `o[k] = …` assign no name; any other shape (a destructuring, its defaults) is read whole.
    else if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) ts.forEachChild(target, targets)
  }
  /** @param {TsNode} node */
  const find = node => {
    const target = assignmentTarget(ts, node)
    if (target) targets(target)
    ts.forEachChild(node, find)
  }
  find(sf)
  return out
}

/**
 * What a node assigns to, if it is an assignment: the left of `=`/`+=`/…, the operand of `++`/`--`, or the head
 * of a `for … of`/`for … in` that declares nothing.
 * @param {TS} ts @param {TsNode} node @returns {TsNode | undefined}
 */
function assignmentTarget(ts, node) {
  const k = ts.SyntaxKind
  if (ts.isBinaryExpression(node)) return node.operatorToken.kind >= k.FirstAssignment && node.operatorToken.kind <= k.LastAssignment ? node.left : undefined
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return [k.PlusPlusToken, k.MinusMinusToken].includes(node.operator) ? node.operand : undefined
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return ts.isVariableDeclarationList(node.initializer) ? undefined : node.initializer
  return undefined
}

/** @param {TS} ts @param {TsExpr} v @returns {boolean} whether `v` is a call of the consumer-agent mark */
function consumerMarked(ts, v) {
  return ts.isCallExpression(v) && ts.isIdentifier(v.expression) && v.expression.text === CONSUMER_AGENT_MARK
}
