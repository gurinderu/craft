// The path touches of one Bash command line as lib/crate-boundary.mjs reads an agent's transcript: which
// files a reader, a searcher, a listing or a `git show <rev>:<path>` names, read from the words alone (no
// expansion, no execution). A flag's value is never a path, and a command fed by a pipe reads its stdin.
import path from 'node:path'

/** @typedef {{ tool: string, kind: string, path: string }} Touch */

const READERS = new Set(['cat', 'sed', 'head', 'tail', 'less', 'more', 'nl', 'bat', 'awk', 'view'])
const SEARCHERS = new Set(['grep', 'egrep', 'rg', 'ag'])
const LISTERS = new Set(['ls', 'find', 'tree', 'fd'])
// The searchers' and readers' first operand is a pattern or a script, not a path.
const FIRST_OPERAND_IS_PROGRAM = new Set(['grep', 'egrep', 'rg', 'ag', 'sed', 'awk'])
const CONTEXT_FLAG = /^-(?:[ABC]\d*|-(?:context|after-context|before-context)(?:=.*)?)$/

// One shell token: a single- or double-quoted word, an operator that ends a command, or a bare word.
const TOKEN = /'([^']*)'|"([^"]*)"|([;&|()\n])|([^\s;&|()'"]+)/g

/** The simple commands of one command line, quotes stripped (no expansion), each with whether a pipe feeds it. @param {string} cmd */
export function pipedSegments(cmd) {
  /** @type {Array<{ words: string[], piped: boolean }>} */
  const segs = [{ words: [], piped: false }]
  for (const m of String(cmd).matchAll(TOKEN)) {
    const last = /** @type {{ words: string[], piped: boolean }} */ (segs[segs.length - 1])
    if (m[3]) { if (last.words.length) segs.push({ words: [], piped: m[3] === '|' }) } else last.words.push(m[1] ?? m[2] ?? m[4] ?? '')
  }
  return segs.filter(seg => seg.words.length)
}

// The flags that take the next word as their value, per command: a flag means different things to different
// commands (`-n` is a count to head and tail, a bare switch to sed and grep), so one set for all reads a value
// as a path or a path as a value.
const SEARCH_VALUE_FLAGS = ['-A', '-B', '-C', '-m', '-e', '-f', '-g', '-t', '-T', '-d', '-D', '--glob', '--type', '--include', '--exclude', '--max-count', '--context', '--after-context', '--before-context']
const HEAD_VALUE_FLAGS = ['-n', '-c', '--lines', '--bytes']
/** @type {Record<string, Set<string>>} */
const VALUE_FLAGS = {
  grep: new Set(SEARCH_VALUE_FLAGS), egrep: new Set(SEARCH_VALUE_FLAGS), rg: new Set(SEARCH_VALUE_FLAGS), ag: new Set(SEARCH_VALUE_FLAGS),
  head: new Set(HEAD_VALUE_FLAGS), tail: new Set([...HEAD_VALUE_FLAGS, '-s', '--sleep-interval', '--pid']),
  sed: new Set(['-e', '-f', '-l', '--expression', '--file']), awk: new Set(['-f', '-v', '-F']),
  nl: new Set(['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w']), bat: new Set(['-r', '-l', '-H', '--line-range', '--language', '--highlight-line']),
  find: new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-newer', '-size', '-regex', '-mtime', '-perm', '-user']),
  tree: new Set(['-L', '-P', '-I']), fd: new Set(['-e', '-t', '-d', '-E', '--extension', '--type', '--max-depth', '--exclude']),
  ls: new Set(['-I', '--ignore']),
}

/** A command's operands: its words that are neither flags nor a flag's value. @param {string} cmd @param {string[]} args */
function operandsOf(cmd, args) {
  const takesValue = VALUE_FLAGS[cmd] || new Set()
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < args.length; i++) {
    const x = /** @type {string} */ (args[i])
    if (takesValue.has(x)) i++
    else if (!x.startsWith('-') && !(cmd === 'tail' && /^\+\d+$/.test(x))) out.push(x)
  }
  return out
}

// A simple command's words with assignments and wrappers dropped, git's global `-C <dir>`/`-c <k=v>` dropped,
// `git grep` read as grep and `git show`/`git cat-file` as the one command `git show`/`git cat-file`.
/** @param {string[]} words */
function commandWords(words) {
  let w = words.filter(x => !/^\w+=/.test(x))
  if (WRAPPERS.has(w[0] || '')) w = w.slice(1)
  return w[0] === 'git' ? gitWords(w) : w
}
const WRAPPERS = new Set(['rtk', 'command', 'xargs'])

/** A git command line with its global `-C`/`-c` options dropped and the subcommands read here renamed. @param {string[]} w */
function gitWords(w) {
  let i = 1
  while (w[i] === '-C' || w[i] === '-c') i += 2
  const sub = w[i] || ''
  if (sub === 'grep') return ['grep', ...w.slice(i + 1)]
  return sub === 'show' || sub === 'cat-file' ? [`git ${sub}`, ...w.slice(i + 1)] : w
}

// The blob paths a `git show`/`git cat-file` reads: each `<rev>:<path>` operand (`:<path>` the index). Git reads
// `<path>` from the repository root, and `./<path>` or `../<path>` from where the command stands.
/** @param {string[]} args @param {string} base @param {string} repo @returns {string[]} */
function blobPaths(args, base, repo) {
  const dash = args.indexOf('--')
  return (dash >= 0 ? args.slice(0, dash) : args).filter(x => !x.startsWith('-')).flatMap(x => {
    const m = /^[^:]*:(.+)$/.exec(x)
    if (!m) return []
    const p = String(m[1])
    return [/^\.\.?\//.test(p) ? path.resolve(base, p) : path.resolve(repo, p)]
  })
}

/** What a command does to the paths it names: read, search, body-search, list, or '' for anything else. @param {string} cmd @param {string[]} w */
function touchKind(cmd, w) {
  if (READERS.has(cmd)) return 'read'
  if (SEARCHERS.has(cmd)) return w.some(x => CONTEXT_FLAG.test(x)) ? 'body-search' : 'search'
  return LISTERS.has(cmd) ? 'list' : ''
}

/** The paths a command names; a search or listing that names none runs where it stands. @param {string} cmd @param {string[]} w @param {string} kind */
function namedPaths(cmd, w, kind) {
  const operands = operandsOf(cmd, w.slice(1))
  const paths = FIRST_OPERAND_IS_PROGRAM.has(cmd) && !w.includes('-e') ? operands.slice(1) : operands
  return paths.length || kind === 'read' ? paths : ['.']
}

/**
 * The path touches of one Bash command: `kind` read, search, body-search or list; `cd` moves the base. A
 * command downstream of a pipe reads its stdin: the paths it names are what it reads, and none means none.
 * @param {string} command @param {string} cwd @param {string} [repo]  the repository root a `<rev>:<path>` is read from
 * @returns {{ touches: Touch[], cwd: string }}
 */
export function bashTouches(command, cwd, repo = cwd) {
  /** @type {Touch[]} */
  const touches = []
  let base = cwd
  for (const { words, piped } of pipedSegments(command)) {
    const w = commandWords(words)
    const cmd = w[0]?.startsWith('git ') ? w[0] : path.basename(w[0] || '')
    if (cmd === 'cd' && w[1]) base = path.resolve(base, w[1])
    else touches.push(...commandTouches(cmd, w, { base, repo, fromStdin: piped && words[0] !== 'xargs' }))
  }
  return { touches, cwd: base }
}

/**
 * One simple command's touches. `fromStdin`: a pipe feeds it (`xargs` hands its stdin over as operands, so
 * what it runs reads files even when piped) — then it reads only the paths it names.
 * @param {string} cmd @param {string[]} w @param {{ base: string, repo: string, fromStdin: boolean }} at @returns {Touch[]}
 */
function commandTouches(cmd, w, { base, repo, fromStdin }) {
  if (cmd === 'git show' || cmd === 'git cat-file') return blobPaths(w.slice(1), base, repo).map(p => ({ tool: `Bash:${cmd}`, kind: 'read', path: p }))
  const kind = touchKind(cmd, w)
  if (!kind || (fromStdin && !operandsNamed(cmd, w))) return []
  return namedPaths(cmd, w, kind).map(p => ({ tool: `Bash:${cmd}`, kind, path: path.resolve(base, p) }))
}

/** Whether a command names any path of its own (a search's first operand is its pattern). @param {string} cmd @param {string[]} w */
function operandsNamed(cmd, w) {
  const operands = operandsOf(cmd, w.slice(1))
  return (FIRST_OPERAND_IS_PROGRAM.has(cmd) && !w.includes('-e') ? operands.slice(1) : operands).length > 0
}
