import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeArgs, parsePairs } from './workflow-args.mjs'

const warnings = () => {
  const said = []
  return { warn: m => said.push(String(m)), said }
}

test('an object passes through untouched and says nothing', () => {
  const w = warnings()
  const args = { base: 'v1', languages: ['rust'] }
  assert.equal(normalizeArgs(args, w.warn), args)
  assert.deepEqual(w.said, [], 'the correct form must not nag')
})

test('the key=value form the skill advertises is understood', () => {
  // This is the form a caller gets by typing options after the skill name, and it is what silently
  // dropped every option: JSON.parse fails on it, so the run took its defaults and reviewed the
  // working tree while reporting a verdict that read like a requested one.
  const w = warnings()
  const a = normalizeArgs('base=v0.17.0 intent="the release diff" --strict', w.warn)
  assert.equal(a.base, 'v0.17.0')
  assert.equal(a.intent, 'the release diff', 'a quoted value keeps its spaces')
  assert.equal(a.strict, true, 'a dashed key is a flag — an unambiguous statement of intent')
  assert.equal(w.said.length, 1, 'and the repair is said out loud, once')
})

test('a value that is JSON becomes JSON, and a quoted one stays a string', () => {
  const a = normalizeArgs('languages=["rust","nix"] mutants=true rounds=3 intent="[draft] fix"')
  assert.deepEqual(a.languages, ['rust', 'nix'])
  assert.equal(a.mutants, true)
  assert.equal(a.rounds, 3)
  assert.equal(a.intent, '[draft] fix', 'a quoted value is a sentence, not a JSON array')
})

test('a JSON string is parsed and reported', () => {
  const w = warnings()
  const a = normalizeArgs('{"base":"v1","path":"lib/"}', w.warn)
  assert.equal(a.base, 'v1')
  assert.equal(a.path, 'lib/')
  assert.match(w.said[0], /JSON string/)
})

test('what cannot be understood drops the options LOUDLY, never quietly', () => {
  // The whole point. A run that quietly falls back to defaults produces a confident verdict about a
  // diff nobody asked for, and there is nothing in the report to notice.
  for (const bad of ['{"base": oops}', '[1,2,3]', '"just a string"']) {
    const w = warnings()
    assert.deepEqual(normalizeArgs(bad, w.warn), {})
    assert.equal(w.said.length, 1, `${bad}: must say it dropped the options`)
    assert.match(w.said[0], /ignored|defaults/i)
  }
})

test('empty and absent args are not a degradation', () => {
  const w = warnings()
  assert.deepEqual(normalizeArgs('', w.warn), {})
  assert.deepEqual(normalizeArgs(undefined, w.warn), {})
  assert.deepEqual(normalizeArgs(null, w.warn), {})
  assert.deepEqual(w.said, [], 'no options is the ordinary case, not a repair')
})

test('an array is not an options object', () => {
  const w = warnings()
  assert.deepEqual(normalizeArgs(['base', 'v1'], w.warn), {})
})

test('parsePairs keeps a value containing = intact', () => {
  assert.equal(parsePairs('intent=a=b').intent, 'a=b')
})

test('a string of only boolean options is not thrown away', () => {
  // `mutants=true` is a pair whose VALUE is boolean true. Deciding "is this the pair form?" by asking
  // whether any value is not `true` discarded exactly these — the caller got a full audit with no
  // mutation pass and a message saying their input was not understood.
  const w = warnings()
  assert.deepEqual(normalizeArgs('mutants=true', w.warn), { mutants: true })
  assert.deepEqual(normalizeArgs('strict=true fresh=true'), { strict: true, fresh: true })
  assert.ok(!w.said.some(l => /unrecognized/.test(l)), 'and it must not be reported as unrecognized')
})

test('unquoted prose after an option is ignored and named, never turned into flags', () => {
  // The trap the no-`=` guard did not close: once one pair is present, the rest of a sentence was
  // still becoming options. An invented `strict` changes what the run does.
  const w = warnings()
  const a = normalizeArgs('base=v1 intent=review the auth refactor strict', w.warn)
  assert.equal(a.base, 'v1')
  assert.equal(a.intent, 'review')
  assert.ok(!('strict' in a), 'a word from the prose must not become a flag')
  assert.ok(!('auth' in a), 'nor any other')
  assert.ok(w.said.some(l => /ignored 4 word\(s\)/.test(l)), 'and what was ignored must be named')
})

test('a key that would reach through the prototype is refused by name', () => {
  // `__proto__` is a live setter on a plain object: `__proto__={"craftRoot":"/evil"}` stores no own
  // key and still makes `A.craftRoot` read `/evil` — which this engine interpolates into the shell
  // instructions its logger agent is handed. The args string is model-composed, so this is the same
  // threat shape as a model-supplied path, reached by a quieter door. A null-prototype object is NOT
  // enough on its own: assigning back to a plain object re-triggers the setter.
  const w = warnings()
  const a = normalizeArgs('base=v1 __proto__={"craftRoot":"/evil/root"}', w.warn)
  assert.deepEqual(Object.keys(a), ['base'])
  assert.equal(a.craftRoot, undefined, 'nothing may be reachable that was not written as an option')
  assert.equal(({}).craftRoot, undefined, 'and no other object may be affected')
  assert.ok(w.said.some(l => /ignored/.test(l)), 'the refusal is named, not silent')

  for (const key of ['constructor', 'prototype']) {
    const a2 = normalizeArgs(`${key}=x base=v2`)
    assert.equal(a2.base, 'v2', `${key}: the legitimate option beside it still lands`)
    assert.ok(!Object.keys(a2).includes(key), `${key}: must not be stored`)
  }
})
