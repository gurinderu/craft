// The command vocabulary of lib/shell-touches.mjs: which commands read, search or list the paths they name,
// which of their flags take a value, and which of their words are therefore paths.

const READERS = new Set(['cat', 'sed', 'head', 'tail', 'less', 'more', 'nl', 'bat', 'awk', 'view'])
export const SEARCHERS = new Set(['grep', 'egrep', 'rg', 'ag'])
export const LISTERS = new Set(['ls', 'find', 'tree', 'fd'])
// The searchers' and readers' first operand is a pattern or a script, not a path.
const FIRST_OPERAND_IS_PROGRAM = new Set(['grep', 'egrep', 'rg', 'ag', 'sed', 'awk'])
const CONTEXT_FLAG = /^-(?:[ABC]\d*|-(?:context|after-context|before-context)(?:=.*)?)$/

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

/** What a command does to the paths it names: read, search, body-search, list, or '' for anything else. @param {string} cmd @param {string[]} w */
export function touchKind(cmd, w) {
  if (READERS.has(cmd)) return 'read'
  if (SEARCHERS.has(cmd)) return w.some(x => CONTEXT_FLAG.test(x)) ? 'body-search' : 'search'
  return LISTERS.has(cmd) ? 'list' : ''
}

/** The paths a command names itself (a search's first operand is its pattern). @param {string} cmd @param {string[]} w */
export function ownPaths(cmd, w) {
  const operands = operandsOf(cmd, w.slice(1))
  return FIRST_OPERAND_IS_PROGRAM.has(cmd) && !w.includes('-e') ? operands.slice(1) : operands
}

/** The paths a command names; a search or listing that names none runs where it stands. @param {string} cmd @param {string[]} w @param {string} kind */
export function namedPaths(cmd, w, kind) {
  const paths = ownPaths(cmd, w)
  return paths.length || kind === 'read' ? paths : ['.']
}
