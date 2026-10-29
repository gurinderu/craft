// lib/shell-heredocs.mjs: where a heredoc opens, what its body is, and the text left without it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { heredocs } from './shell-heredocs.mjs'

/** @param {string} src */
const read = src => { const { text, bodies } = heredocs(src); return { text, bodies: [...bodies] } }

test('a body is taken out and kept by where its << stands; its word may be quoted, escaped or tab-closed', () => {
  assert.deepEqual(read('cat <<EOF\na\nEOF\nls'), { text: 'cat <<EOF\nls', bodies: [[4, 'a']] })
  assert.deepEqual(read('cat <<\\EOF >f\n"\nEOF'), { text: 'cat <<\\EOF >f\n', bodies: [[4, '"']] })
  assert.deepEqual(read('cat <<-"E"\n\tx\n\tE\nls'), { text: 'cat <<-"E"\nls', bodies: [[4, '\tx']] })
  assert.deepEqual(read('cat <<A\nnever closed'), { text: 'cat <<A\n', bodies: [[4, 'never closed']] })
})

test('a << opens one inside $(…), even within double quotes, and nowhere else', () => {
  assert.deepEqual(read(`x "$(cat <<'E'\n"\nE\n)" y`), { text: `x "$(cat <<'E'\n)" y`, bodies: [[9, '"']] })
  for (const src of ['echo "a <<E"\nE', "echo 'a <<E'\nE", 'echo $((1<<E))\nE', '((a<<E))\nE', 'cat <<<E\nE', 'cat <<1\n1']) {
    assert.deepEqual(read(src), { text: src, bodies: [] }, src)
  }
})
