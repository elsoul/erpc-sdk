import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReleaseArgument } from './release-version.mjs'

test('accepts direct and pnpm-separated stable versions', () => {
  const expected = { tag: 'v1.2.3', version: '1.2.3' }

  assert.deepEqual(parseReleaseArgument(['1.2.3']), expected)
  assert.deepEqual(parseReleaseArgument(['v1.2.3']), expected)
  assert.deepEqual(parseReleaseArgument(['--', '1.2.3']), expected)
})

test('rejects missing, prerelease, and extra arguments', () => {
  for (const arguments_ of [
    [],
    ['--'],
    ['1.2.3-beta.1'],
    ['1.2.3', 'extra'],
    ['--', '1.2.3', 'extra'],
  ]) {
    assert.throws(() => parseReleaseArgument(arguments_))
  }
})
