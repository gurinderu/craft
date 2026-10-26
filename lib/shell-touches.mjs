// The path touches of one Bash command line as lib/crate-boundary.mjs reads an agent's transcript: which
// files a reader, a searcher, a listing or a `git show <rev>:<path>` names, read from the words alone (no
// expansion, no execution). A flag's value is never a path, and a command fed by a pipe reads its stdin —
// except under `xargs`, which hands what the pipe carries over as operands: then it reads the paths the
// command upstream names, or, when nothing upstream names them, an `unattributed` read of the whole line.
import path from 'node:path'
import { SEARCHERS, LISTERS, ownPaths, namedPaths, touchKind } from './shell-operands.mjs'

/** @typedef {{ tool: string, kind: string, path: string, command?: string }} Touch */

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

// A simple command's words with assignments and wrappers dropped, git's global `-C <dir>`/`-c <k=v>` dropped,
// `git grep` read as grep and `git show`/`git cat-file`/`git ls-files` as the one command of that name.
/** @param {string[]} words */
function commandWords(words) {
  let w = words.filter(x => !/^\w+=/.test(x))
  if (WRAPPERS.has(w[0] || '')) w = w.slice(1)
  return w[0] === 'git' ? gitWords(w) : w
}
const WRAPPERS = new Set(['rtk', 'command'])

// The command `xargs` runs, its options dropped and the `-I` placeholder taken out of its operands.
const XARGS_VALUE_FLAGS = new Set(['-n', '-P', '-d', '-L', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'])
/** @param {string[]} w */
function xargsWords(w) {
  let i = 1
  let replace = ''
  for (let x = w[i] || ''; x.startsWith('-'); x = w[i] || '') {
    if (x.startsWith('-I')) replace = x.length > 2 ? x.slice(2) : w[++i] || ''
    else if (XARGS_VALUE_FLAGS.has(x)) i++
    i++
  }
  return commandWords(w.slice(i).filter(x => !replace || x !== replace))
}

/** A git command line with its global `-C`/`-c` options dropped and the subcommands read here renamed. @param {string[]} w */
function gitWords(w) {
  let i = 1
  while (w[i] === '-C' || w[i] === '-c') i += 2
  const sub = w[i] || ''
  if (sub === 'grep') return ['grep', ...w.slice(i + 1)]
  return sub === 'show' || sub === 'cat-file' || sub === 'ls-files' ? [`git ${sub}`, ...w.slice(i + 1)] : w
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

// The commands that pass the paths on their stdin through to their stdout when they name none of their own,
// and `tr`, which never names one.
const FILTERS = new Set(['grep', 'egrep', 'rg', 'head', 'tail', 'sort', 'uniq', 'sed', 'awk', 'cut'])
const FILES_FLAG = /^-(?:[a-zA-Z]*[lL][a-zA-Z]*|-files-with(?:out)?-matches?)$/
/**
 * The paths a command prints, absolute; null when it prints no paths it names (the contents of a file, an echo).
 * @param {string} cmd @param {string[]} w @param {{ base: string, piped: boolean, upstream: string[] | null }} at
 * @returns {string[] | null}
 */
function stdoutPaths(cmd, w, { base, piped, upstream }) {
  const abs = (/** @type {string[]} */ ps) => ps.map(p => path.resolve(base, p))
  if (piped && (cmd === 'tr' || (FILTERS.has(cmd) && !ownPaths(cmd, w).length))) return upstream
  if (cmd === 'git ls-files') { const ps = w.slice(1).filter(x => !x.startsWith('-')); return abs(ps.length ? ps : ['.']) }
  if (LISTERS.has(cmd) || (SEARCHERS.has(cmd) && w.some(x => FILES_FLAG.test(x)))) return abs(namedPaths(cmd, w, 'list'))
  return null
}

/**
 * The path touches of one Bash command: `kind` read, search, body-search or list; `cd` moves the base. A
 * command downstream of a pipe reads its stdin: the paths it names are what it reads, and none means none.
 * @param {string} command @param {string} cwd @param {string} [repo]  the repository root a `<rev>:<path>` is read from
 * @returns {{ touches: Touch[], cwd: string }}
 */
export function bashTouches(command, cwd, repo = cwd) {
  /** @type {{ base: string, upstream: string[] | null }} */
  const at = { base: cwd, upstream: null }
  const touches = pipedSegments(command).flatMap(seg => segmentTouches(seg, at, repo, command))
  return { touches, cwd: at.base }
}

/**
 * One simple command of a line: its touches; `at` carries where the line stands and the paths the command
 * before it printed. @param {{ words: string[], piped: boolean }} seg @param {{ base: string, upstream: string[] | null }} at
 * @param {string} repo @param {string} command @returns {Touch[]}
 */
function segmentTouches({ words, piped }, at, repo, command) {
  const w0 = commandWords(words)
  const xargs = w0[0] === 'xargs'
  const w = xargs ? xargsWords(w0) : w0
  const cmd = w[0]?.startsWith('git ') ? w[0] : path.basename(w[0] || '')
  if (cmd === 'cd') {
    if (w[1]) at.base = path.resolve(at.base, w[1])
    at.upstream = null
    return []
  }
  const touches = commandTouches(cmd, w, { base: at.base, repo, fromStdin: piped && !xargs, fed: xargs && piped ? { paths: at.upstream, command } : null })
  at.upstream = stdoutPaths(cmd, w, { base: at.base, piped, upstream: at.upstream })
  return touches
}

/**
 * One simple command's touches. `fromStdin`: a plain pipe feeds it — then it reads only the paths it names.
 * `fed`: `xargs` runs it on a pipe — it reads the paths it names and those upstream printed (`paths`, null
 * when upstream printed none it named: a read is then `unattributed`, carrying the whole `command`).
 * @param {string} cmd @param {string[]} w
 * @param {{ base: string, repo: string, fromStdin: boolean, fed: { paths: string[] | null, command: string } | null }} at @returns {Touch[]}
 */
function commandTouches(cmd, w, { base, repo, fromStdin, fed }) {
  if (cmd === 'git show' || cmd === 'git cat-file') return blobPaths(w.slice(1), base, repo).map(p => ({ tool: `Bash:${cmd}`, kind: 'read', path: p }))
  const kind = touchKind(cmd, w)
  if (!kind || (fromStdin && !ownPaths(cmd, w).length)) return []
  const tool = `Bash:${cmd}`
  if (!fed) return namedPaths(cmd, w, kind).map(p => ({ tool, kind, path: path.resolve(base, p) }))
  const own = ownPaths(cmd, w).map(p => ({ tool, kind, path: path.resolve(base, p) }))
  if (fed.paths) return [...own, ...fed.paths.map(p => ({ tool, kind, path: p }))]
  // Nothing upstream named what xargs hands over: a read is unattributed, a search or listing runs where it stands.
  if (kind === 'read') return [...own, { tool, kind: 'unattributed', path: base, command: fed.command }]
  return own.length ? own : [{ tool, kind, path: base }]
}
