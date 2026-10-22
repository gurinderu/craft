import { test } from 'vitest'
import assert from 'node:assert/strict'
import { pushesIn, simpleCommands } from './push-command.mjs'

test('a command splits into simple commands at shell operators, quotes kept whole', () => {
  assert.deepEqual(simpleCommands('git add a && git commit -m "a; b" ; git push|cat'), [['git', 'add', 'a'], ['git', 'commit', '-m', 'a; b'], ['git', 'push'], ['cat']])
  assert.deepEqual(simpleCommands('echo \'x y\'\nls'), [['echo', 'x y'], ['ls']])
})

test('a plain push, its rtk proxy, git -C and a cd before it each run where the shell would run them', () => {
  assert.deepEqual(pushesIn('git push', '/r'), [{ dir: '/r', remote: '', refspecs: [], skip: '' }])
  assert.deepEqual(pushesIn('rtk git push -u origin feat/x', '/r'), [{ dir: '/r', remote: 'origin', refspecs: ['feat/x'], skip: '' }])
  assert.deepEqual(pushesIn('git -C ../other -c core.x=1 push origin', '/r/a'), [{ dir: '/r/other', remote: 'origin', refspecs: [], skip: '' }])
  assert.deepEqual(pushesIn('cd sub && GIT_TRACE=0 git push --force-with-lease', '/r'), [{ dir: '/r/sub', remote: '', refspecs: [], skip: '' }])
  assert.deepEqual(pushesIn('git push -o ci.skip origin HEAD:feat/y', '/r')[0]?.refspecs, ['HEAD:feat/y'])
})

test('a heredoc body is no command; a subshell cd moves the push inside it and ends with it', () => {
  const body = 'cat > notes.txt <<EOF\ngit push origin HEAD:feat/z\nEOF\nls'
  assert.deepEqual(simpleCommands(body), [['cat', '>', 'notes.txt', '<<EOF'], ['ls']])
  assert.deepEqual(pushesIn(body, '/r'), [])
  assert.deepEqual(pushesIn("git commit -F- <<'MSG'\ngit push\nMSG\ngit push", '/r').length, 1)
  assert.deepEqual(pushesIn('cat <<-END\n\tgit push\n\tEND\necho done', '/r'), [])
  assert.deepEqual(pushesIn('cat <<<"git push"', '/r'), [], 'a here-string is a quoted word')
  assert.deepEqual(pushesIn('(cd sub && git push) && git push', '/r').map(p => p.dir), ['/r/sub', '/r'])
})

test('--prune beside a refspec still pushes a branch; alone it is a deletion', () => {
  assert.equal(pushesIn('git push --prune origin HEAD:feat/x', '/r')[0]?.skip, '')
  assert.equal(pushesIn('git push --prune origin', '/r')[0]?.skip, 'prune')
  assert.equal(pushesIn('git push --prune --tags origin HEAD:feat/x', '/r')[0]?.skip, 'tags')
})

test('a push that moves no branch head names why; other commands are no push', () => {
  assert.equal(pushesIn('git push --tags', '/r')[0]?.skip, 'tags')
  assert.equal(pushesIn('git push origin --delete feat/x', '/r')[0]?.skip, 'delete')
  assert.equal(pushesIn('git push --dry-run', '/r')[0]?.skip, 'dry-run')
  for (const other of ['git status', 'echo git push', 'git log --grep push', 'npm run push', '']) assert.deepEqual(pushesIn(other, '/r'), [], other)
})
