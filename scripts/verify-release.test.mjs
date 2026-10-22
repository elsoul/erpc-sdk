import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  classifyRegistryResponse,
  findLocalCargoPackage,
  parseReleaseArguments,
  readReleaseData,
  validateReleaseData,
  validateWorkflowContext,
  verifyArchiveContents,
} from './verify-release.mjs'

const root = new URL('../', import.meta.url)
const sha = 'a'.repeat(40)
const hash = 'b'.repeat(64)

const validContext = () => ({
  repository: 'elsoul/erpc-sdk',
  repositoryId: '1429568627',
  eventName: 'workflow_dispatch',
  eventRef: 'refs/heads/main',
  eventSha: sha,
  expectedCommit: sha,
  checkoutHead: sha,
  expectedVersion: '0.10.0',
  publish: false,
  approvedSha256: '',
})

const validArchive = () => ({
  fileList: [
    'erpc-sdk-0.10.0/',
    'erpc-sdk-0.10.0/.cargo_vcs_info.json',
    'erpc-sdk-0.10.0/Cargo.toml',
    'erpc-sdk-0.10.0/LICENSE',
    'erpc-sdk-0.10.0/README.md',
    'erpc-sdk-0.10.0/src/bitcoin.rs',
    'erpc-sdk-0.10.0/tests/bitcoin.rs',
  ].join('\n'),
  manifest: '[package]\nname = "erpc-sdk"\nversion = "0.10.0"\n',
  vcsInfo: JSON.stringify({
    git: { sha1: sha, dirty: false },
    path_in_vcs: 'packages/rust',
  }),
  expectedVersion: '0.10.0',
  expectedCommit: sha,
})

test('release argument parser supports all explicit cohorts and preserves tags', () => {
  assert.deepEqual(parseReleaseArguments([]), {
    expectedVersion: undefined,
    scope: 'all',
    tag: undefined,
  })
  assert.deepEqual(parseReleaseArguments(['v0.9.0']), {
    expectedVersion: undefined,
    scope: 'all',
    tag: 'v0.9.0',
  })
  assert.deepEqual(parseReleaseArguments(['--scope', 'rust', '--expected-version', '0.10.0']), {
    expectedVersion: '0.10.0',
    scope: 'rust',
    tag: undefined,
  })
  assert.deepEqual(parseReleaseArguments(['non-rust']), {
    expectedVersion: undefined,
    scope: 'non-rust',
    tag: undefined,
  })
  assert.deepEqual(parseReleaseArguments(['rust', '0.10.0']), {
    expectedVersion: '0.10.0',
    scope: 'rust',
    tag: undefined,
  })
  assert.deepEqual(parseReleaseArguments(['--scope=all', '--expected-version=0.9.0']), {
    expectedVersion: '0.9.0',
    scope: 'all',
    tag: undefined,
  })
})

test('release argument parser rejects unknown, duplicate, and conflicting inputs', () => {
  for (const arguments_ of [
    ['--unknown'],
    ['--scope', 'wat'],
    ['--scope', 'rust', '--scope', 'rust'],
    ['--expected-version', '0.10.0', '--expected-version', '0.10.0'],
    ['--scope', 'rust', 'v0.10.0'],
    ['rust', 'non-rust'],
    ['--expected-version', '0.10.0-beta.1'],
    ['v0.10.0-beta.1'],
  ]) {
    assert.throws(() => parseReleaseArguments(arguments_))
  }
})

test('current tree passes split cohorts while strict aggregate verification fails', async () => {
  const data = await readReleaseData(root.pathname)
  assert.equal(validateReleaseData(data, { scope: 'rust', expectedVersion: '0.10.0' }).version, '0.10.0')
  assert.equal(validateReleaseData(data, { scope: 'non-rust' }).version, '0.9.0')
  assert.throws(
    () => validateReleaseData(data, { scope: 'all' }),
    /Package versions differ: npm=0\.9\.0, crates\.io=0\.10\.0/,
  )
})

test('Rust verification binds the unique source-free local lock entry and MSRV', async () => {
  const data = await readReleaseData(root.pathname)
  assert.equal(findLocalCargoPackage(data.cargoLock).version, '0.10.0')
  assert.throws(
    () => findLocalCargoPackage('[[package]]\nname = "erpc-sdk"\nversion = "0.10.0"\n\n[[package]]\nname = "erpc-sdk"\nversion = "0.10.0"\n'),
    /exactly one source-free erpc-sdk/,
  )
  assert.throws(
    () => validateReleaseData({ ...data, cargoManifest: data.cargoManifest.replace('rust-version = "1.85"', 'rust-version = "1.86"') }, { scope: 'rust' }),
    /Unexpected Rust MSRV/,
  )
  assert.throws(
    () => validateReleaseData({ ...data, cargoLockPackage: { version: '0.9.0' } }, { scope: 'rust' }),
    /Cargo\.lock local erpc-sdk version/,
  )
})

test('workflow guard rejects hostile repository, event, ref, source, version, and hash fixtures', () => {
  validateWorkflowContext(validContext())
  for (const field of ['repository', 'repositoryId', 'eventName', 'eventRef', 'eventSha', 'expectedCommit', 'checkoutHead']) {
    const fixture = validContext()
    fixture[field] = field === 'repositoryId' ? '1' : field === 'eventName' ? 'push' : field === 'eventRef' ? 'refs/heads/codex/bad' : 'c'.repeat(40)
    assert.throws(() => validateWorkflowContext(fixture), new RegExp(field === 'repository' ? 'Unexpected repository' : field === 'repositoryId' ? 'Unexpected repository ID' : field === 'eventName' ? 'manually dispatched' : field === 'eventRef' ? 'main' : 'commit'))
  }
  for (const expectedVersion of ['0.10', '0.10.0-beta.1', '']) {
    assert.throws(() => validateWorkflowContext({ ...validContext(), expectedVersion }))
  }
  assert.throws(() => validateWorkflowContext({ ...validContext(), publish: true }), /approved crate hash/)
  assert.throws(() => validateWorkflowContext({ ...validContext(), approvedSha256: 'bad' }), /64-character/)
  assert.throws(() => validateWorkflowContext({ ...validContext(), publish: 'yes' }), /boolean/)
})

test('registry classification distinguishes absent, match, conflict, yanked, malformed, and HTTP failure', () => {
  const response = JSON.stringify({
    version: { crate: 'erpc-sdk', num: '0.10.0', checksum: hash, yanked: false },
  })
  assert.deepEqual(classifyRegistryResponse({ status: 404, body: '', expectedVersion: '0.10.0', expectedChecksum: hash }), { state: 'absent' })
  assert.deepEqual(classifyRegistryResponse({ status: 200, body: response, expectedVersion: '0.10.0', expectedChecksum: hash }), { state: 'match', checksum: hash })
  assert.equal(classifyRegistryResponse({ status: 200, body: response.replace(hash, 'c'.repeat(64)), expectedVersion: '0.10.0', expectedChecksum: hash }).state, 'conflict')
  assert.equal(classifyRegistryResponse({ status: 200, body: response.replace('false', 'true'), expectedVersion: '0.10.0', expectedChecksum: hash }).state, 'yanked')
  assert.equal(classifyRegistryResponse({ status: 200, body: '{', expectedVersion: '0.10.0', expectedChecksum: hash }).state, 'malformed')
  assert.equal(classifyRegistryResponse({ status: 200, body: JSON.stringify({ version: { crate: 'other', num: '0.10.0', checksum: hash, yanked: false } }), expectedVersion: '0.10.0', expectedChecksum: hash }).state, 'malformed')
  assert.equal(classifyRegistryResponse({ status: 500, body: '', expectedVersion: '0.10.0', expectedChecksum: hash }).state, 'http-error')
  assert.equal(classifyRegistryResponse({ status: 0, body: '', expectedVersion: '0.10.0', expectedChecksum: hash }).state, 'http-error')
})

test('archive proof requires one expected root, provenance, and BTC source/tests', () => {
  assert.deepEqual(verifyArchiveContents(validArchive()), {
    root: 'erpc-sdk-0.10.0',
    commit: sha,
    pathInVcs: 'packages/rust',
  })
  for (const mutate of [
    archive => ({ ...archive, fileList: archive.fileList.replace('src/bitcoin.rs', 'src/other.rs') }),
    archive => ({ ...archive, fileList: `${archive.fileList}\nother-root/file` }),
    archive => ({ ...archive, expectedCommit: 'c'.repeat(40) }),
    archive => ({ ...archive, manifest: archive.manifest.replace('0.10.0', '0.9.0') }),
    archive => ({ ...archive, vcsInfo: archive.vcsInfo.replace('false', 'true') }),
    archive => ({ ...archive, vcsInfo: archive.vcsInfo.replace('packages/rust', 'packages/python') }),
  ]) {
    assert.throws(() => verifyArchiveContents(mutate(validArchive())))
  }
})

test('release-rust workflow is manual, exact-source, OIDC-only, and dry-run isolated', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-rust.yml', import.meta.url), 'utf8')
  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /^\s+(schedule|push|pull_request|pull_request_target|workflow_call):/m)
  assert.match(workflow, /cancel-in-progress:\s*false/)
  assert.match(workflow, /contents:\s*read/)
  assert.match(workflow, /id-token:\s*write/)
  assert.match(workflow, /persist-credentials:\s*false/)
  assert.match(workflow, /node scripts\/verify-release\.mjs --workflow-guard/)
  assert.match(workflow, /node scripts\/verify-release\.mjs --scope rust --expected-version/)
  assert.match(workflow, /rust-lang\/crates-io-auth-action@c6f97d42243bad5fab37ca0427f495c86d5b1a18/)
  assert.match(workflow, /cargo \+1\.85\.0 publish --locked --package erpc-sdk --registry crates-io/)
  assert.doesNotMatch(workflow, /cargo\s+(?:login|publish[^\n]*(?:--workspace|--allow-dirty|--no-verify))/)
  assert.doesNotMatch(workflow, /(?:npm publish|gem push|twine upload|git tag|gh release)/)
  assert.match(workflow, /if:\s*\$\{\{ inputs\.publish == true \}\}/)
  assert.match(workflow, /if:\s*steps\.preflight\.outputs\.state == 'absent'/)
  assert.match(workflow, /https:\/\/crates\.io\/api\/v1\/crates\/erpc-sdk\//)
  assert.match(workflow, /archive_sha256/)
  assert.match(workflow, /contents,\n|results:/)
})

test('CI invokes split release cohorts and runs release behavior tests', async () => {
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(ci, /node scripts\/verify-release\.mjs --scope rust/)
  assert.match(ci, /node scripts\/verify-release\.mjs --scope non-rust/)
  assert.match(ci, /node --test scripts\/verify-release\.test\.mjs/)
})
