import { test } from 'vitest'
import assert from 'node:assert/strict'
import { pushesIn } from './push-command.mjs'
import { simpleCommands } from './shell-words.mjs'

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
  assert.deepEqual(simpleCommands(body), [['cat'], ['ls']])
  assert.deepEqual(pushesIn(body, '/r'), [])
  assert.deepEqual(pushesIn("git commit -F- <<'MSG'\ngit push\nMSG\ngit push", '/r').length, 1)
  assert.deepEqual(pushesIn('cat <<-END\n\tgit push\n\tEND\necho done', '/r'), [])
  assert.deepEqual(pushesIn('cat <<<"git push"', '/r'), [], 'a here-string is a quoted word')
  assert.deepEqual(pushesIn('(cd sub && git push) && git push', '/r').map(p => p.dir), ['/r/sub', '/r'])
  // A << in quotes opens no heredoc, so the line after it is a command; a shell fed a heredoc runs its body.
  assert.deepEqual(pushesIn('echo "x <<EOF"\ngit push', '/r').length, 1)
  assert.deepEqual(pushesIn('bash <<EOF\ncd sub && git push\nEOF\ngit push', '/r').map(p => p.dir), ['/r/sub', '/r'])
})

test('redirections and their targets are no words of the push, whatever their shape', () => {
  const plain = { dir: '/r', remote: '', refspecs: [], skip: '' }
  for (const command of ['git push 2>&1 | tail -3', 'git push >&2', 'git push &>log', 'git push &>> log', 'git push 1>/dev/null', 'git push 2> err.txt', 'git push < /dev/null', 'git push >|out 2>&-']) {
    assert.deepEqual(pushesIn(command, '/r'), [plain], command)
  }
  assert.deepEqual(pushesIn('git push origin 2>&1', '/r'), [{ ...plain, remote: 'origin' }])
  assert.deepEqual(pushesIn('git push origin HEAD:feat/x>out.txt', '/r')[0]?.refspecs, ['HEAD:feat/x'])
  assert.deepEqual(simpleCommands('a 2>&1 && b > f c'), [['a'], ['b', 'c']])
})

test('the env, command and timeout prefixes run the push after them', () => {
  for (const command of ['env GIT_TRACE=0 git push', 'command git push', 'timeout 30 git push', 'timeout 30 rtk git push', 'FOO=1 env git push']) {
    assert.equal(pushesIn(command, '/r').length, 1, command)
  }
  assert.deepEqual(pushesIn('timeout git push', '/r'), [], 'a timeout without its duration is not unwrapped into a push')
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
