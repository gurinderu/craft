// The files a launching engine hands adversarial-review to look at (realm @nick/craft, node #420): review sends it
// the source files outside its own profiles, and the rest of the diff is review's. Read from `files` — a list, or
// one comma-separated string — and spoken to each finder lens as one line.

/** @param {unknown} v @returns {string[]} the paths, blanks dropped; [] when absent */
export function focusFilesArg(v) {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  return raw.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean)
}

/** The finder lens's line for the focus, '' without one. @param {string[]} files @returns {string} */
export function focusLine(files) {
  if (!files.length) return ''
  return `FOCUS: review only these changed files — the rest of the diff is reviewed elsewhere; open any other file for context, but report findings located in these only: ${files.join(', ')}`
}
