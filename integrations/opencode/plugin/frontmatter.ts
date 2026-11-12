// The YAML frontmatter of craft's own Markdown files (agents, commands, skills), as far as they spell it: `key: value`
// scalars (quotes stripped, true/false read as booleans), folded (`>`, `>-`) and literal (`|`, `|-`) block scalars, and
// one level of nested `key:` map. Not a YAML parser: the plugin ships no dependency for one, and these files are ours
// (plugin-content.test.mjs reads every shipped file through it).

export type Scalar = string | boolean
export type FrontValue = Scalar | Record<string, Scalar>
export interface Markdown {
  data: Record<string, FrontValue>
  body: string
}

function scalar(raw: string): Scalar {
  const v = raw.trim()
  if (v === 'true' || v === 'false') return v === 'true'
  const quoted = /^(['"])(.*)\1$/.exec(v)
  return quoted ? (quoted[2] ?? '') : v
}

const indented = (line: string) => line === '' || /^\s/.test(line)

// The block scalar's lines (the indented ones after its key), folded into one line per paragraph or kept as they are.
function block(lines: string[], style: string): string {
  const text = lines.map(l => l.trim())
  if (style.startsWith('|')) return text.join('\n').trimEnd()
  return text
    .join('\n')
    .split(/\n{2,}/)
    .map(p => p.split('\n').join(' ').trim())
    .join('\n')
    .trim()
}

function nested(lines: string[]): Record<string, Scalar> {
  const out: Record<string, Scalar> = {}
  for (const line of lines) {
    const m = /^\s+([\w.*-]+):\s*(.*)$/.exec(line)
    if (m?.[1] !== undefined) out[m[1]] = scalar(m[2] ?? '')
  }
  return out
}

// One key's value: a block scalar, a nested map (nothing after the colon) or a plain scalar.
function value(rest: string, under: string[]): FrontValue {
  if (/^[>|]-?$/.test(rest)) return block(under, rest)
  return rest === '' ? nested(under) : scalar(rest)
}

function fields(lines: string[]): Record<string, FrontValue> {
  const data: Record<string, FrontValue> = {}
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w-]+):\s*(.*)$/.exec(lines[i] ?? '')
    if (m?.[1] === undefined) continue
    let end = i + 1
    while (end < lines.length && indented(lines[end] ?? '')) end++
    data[m[1]] = value((m[2] ?? '').trim(), lines.slice(i + 1, end))
    i = end - 1
  }
  return data
}

/** `text`'s frontmatter and the body after it; a text without frontmatter is all body. */
export function parseMarkdown(text: string): Markdown {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  if (close < 0) return { data: {}, body: text.trim() }
  return {
    data: fields(lines.slice(1, close)),
    body: lines
      .slice(close + 1)
      .join('\n')
      .trim(),
  }
}
