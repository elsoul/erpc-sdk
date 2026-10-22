import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  FOUNDATION_GO_TAG,
  FOUNDATION_RELEASE_TITLE,
  FOUNDATION_RUST_SHA256,
  FOUNDATION_RUST_SOURCE,
  FOUNDATION_TAG,
  FOUNDATION_VERSION,
  buildFoundationPlan,
  buildGoInventory,
  classifyRegistryResponse,
  classifyFoundationRegistryResponse,
  canonicalJson,
  describeFoundationArtifacts,
  findLocalCargoPackage,
  parseReleaseArguments,
  readReleaseData,
  sha256Hex,
  validateReleaseData,
  validateFoundationWorkflowContext,
  validateFoundationPreparationMetadata,
  validateFoundationPlan,
  validateFoundationArtifactDescriptor,
  validateFoundationPyPIResponse,
  selectFoundationCIRun,
  validateFoundationCIProof,
  validateWorkflowContext,
  verifyArchiveContents,
  verifyFoundationBundle,
  verifyFoundationProofSet,
} from './verify-release.mjs'

const root = new URL('../', import.meta.url)
const sha = 'a'.repeat(40)
const hash = 'b'.repeat(64)
const RELEASE_USER_AGENT = 'erpc-sdk-release-verification (https://github.com/elsoul/erpc-sdk)'
const execFileAsync = promisify(execFile)
const verifierPath = new URL('./verify-release.mjs', import.meta.url)

const runVerifierCli = (arguments_, environment = {}) => execFileAsync(
  process.execPath,
  [verifierPath.pathname, ...arguments_],
  { env: { ...process.env, ...environment } },
)

const dedent = source => {
  const lines = source.split(/\r?\n/)
  const indent = Math.min(...lines.filter(line => line.trim()).map(line => line.match(/^\s*/)[0].length))
  return lines.map(line => line.slice(indent)).join('\n')
}

const extractWorkflowRunBlock = (workflow, stepName) => {
  const step = workflow.slice(workflow.indexOf(`- name: ${stepName}`))
  const runStart = step.indexOf('run: |')
  const afterRun = step.slice(runStart + 'run: |'.length + 1)
  return dedent(afterRun.slice(0, afterRun.indexOf('\n      - name:')))
}

const extractWorkflowHeredoc = (workflow, marker, terminator) => {
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `missing workflow heredoc ${marker}`)
  const bodyStart = workflow.indexOf('\n', start) + 1
  const endMatch = workflow.slice(bodyStart).match(new RegExp(`\\n\\s*${terminator}\\s*(?:\\n|$)`))
  assert.notEqual(endMatch, null, `unterminated workflow heredoc ${marker}`)
  return dedent(workflow.slice(bodyStart, bodyStart + endMatch.index))
}

const extractWorkflowCurlInvocations = workflow => {
  const lines = workflow.split(/\r?\n/)
  const invocations = []
  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lines[index].trim()
    if (
      !firstLine.startsWith('HTTP_STATUS="$(curl ') &&
      !firstLine.startsWith('curl ')
    ) {
      continue
    }
    const command = [firstLine]
    while (command.at(-1).endsWith('\\')) {
      index += 1
      assert.notEqual(lines[index], undefined, 'truncated workflow curl invocation')
      command.push(lines[index].trim())
    }
    invocations.push(command.join('\n'))
  }
  return invocations
}

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
  assert.deepEqual(parseReleaseArguments([`v${FOUNDATION_VERSION}`]), {
    expectedVersion: undefined,
    scope: 'all',
    tag: `v${FOUNDATION_VERSION}`,
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
  assert.deepEqual(parseReleaseArguments([`--scope=all`, `--expected-version=${FOUNDATION_VERSION}`]), {
    expectedVersion: FOUNDATION_VERSION,
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
  const nonRustVersions = [data.packageJson.version, data.pythonVersion, data.pythonRuntimeVersion, data.rubyVersion, data.rubyLockVersion]
  if (new Set(nonRustVersions).size === 1) assert.equal(validateReleaseData(data, { scope: 'non-rust' }).version, data.packageJson.version)
  else assert.throws(() => validateReleaseData(data, { scope: 'non-rust' }), /Non-Rust package versions differ/)
  assert.throws(
    () => validateReleaseData(data, { scope: 'all' }),
    /Package versions differ|Non-Rust package versions differ/,
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

test('foundation workflow guard binds an exact main dispatch and fixed 0.9.1 cohort', () => {
  validateFoundationWorkflowContext({
    repository: 'elsoul/erpc-sdk',
    repositoryId: '1429568627',
    eventName: 'workflow_dispatch',
    eventRef: 'refs/heads/main',
    eventSha: sha,
    expectedCommit: sha,
    checkoutHead: sha,
    checkoutStatus: '',
    expectedVersion: FOUNDATION_VERSION,
    mode: 'prepare',
    workflowRef: 'elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main',
    workflowSha: sha,
  })
  for (const mutation of [
    { eventName: 'push' },
    { eventRef: 'refs/heads/feature' },
    { expectedVersion: '0.9.0' },
    { mode: 'other' },
  ]) {
    assert.throws(() => validateFoundationWorkflowContext({
      repository: 'elsoul/erpc-sdk',
      repositoryId: '1429568627',
      eventName: 'workflow_dispatch',
      eventRef: 'refs/heads/main',
      eventSha: sha,
      expectedCommit: sha,
      checkoutHead: sha,
      checkoutStatus: '',
      expectedVersion: FOUNDATION_VERSION,
      mode: 'prepare',
      workflowRef: 'elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main',
      workflowSha: sha,
      ...mutation,
    }))
  }
})

test('preparation metadata requires a successful exact workflow run and both owned artifacts', () => {
  const runId = '12345'
  const runAttempt = '2'
  const artifactId = '45678'
  const bindingArtifactId = '45679'
  const run = {
    id: Number(runId),
    run_attempt: Number(runAttempt),
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: sha,
    path: '.github/workflows/release.yml',
    name: 'Release SDK foundation',
    workflow_id: 99,
    repository: { full_name: 'elsoul/erpc-sdk', id: 1429568627 },
  }
  const artifact = {
    id: Number(artifactId),
    name: `sdk-foundation-bundle-${sha}`,
    expired: false,
    size_in_bytes: 100,
    archive_download_url: 'https://api.github.com/repos/elsoul/erpc-sdk/actions/artifacts/45678/zip',
    workflow_run: { id: Number(runId), repository_id: 1429568627, head_repository_id: 1429568627, head_sha: sha, head_branch: 'main' },
  }
  const bindingArtifact = {
    ...artifact,
    id: Number(bindingArtifactId),
    name: `sdk-foundation-binding-${runId}-${runAttempt}`,
  }
  assert.deepEqual(validateFoundationPreparationMetadata({ run, artifact, bindingArtifact, expected: { runId, runAttempt, artifactId, bindingArtifactId, sourceCommit: sha } }).runId, Number(runId))
  for (const mutation of [
    { run: { ...run, conclusion: 'failure' } },
    { run: { ...run, path: '.github/workflows/other.yml' } },
    { run: { ...run, head_sha: 'c'.repeat(40) } },
    { artifact: { ...artifact, workflow_run: { ...artifact.workflow_run, id: 999 } } },
    { artifact: { ...artifact, workflow_run: { ...artifact.workflow_run, head_repository_id: 999 } } },
    { bindingArtifact: { ...bindingArtifact, expired: true } },
  ]) {
    assert.throws(() => validateFoundationPreparationMetadata({ run: mutation.run ?? run, artifact: mutation.artifact ?? artifact, bindingArtifact: mutation.bindingArtifact ?? bindingArtifact, expected: { runId, runAttempt, artifactId, bindingArtifactId, sourceCommit: sha } }))
  }
})

test('bounded CI proof selects the newest exact-source attempt and rejects stale or incomplete evidence', () => {
  const workflow = { id: 77, path: '.github/workflows/ci.yml', url: 'https://api.github.com/repos/elsoul/erpc-sdk/actions/workflows/77' }
  const runs = {
    total_count: 2,
    workflow_runs: [
      { id: 100, run_attempt: 1, workflow_id: 77, path: '.github/workflows/ci.yml', repository: { full_name: 'elsoul/erpc-sdk', id: 1429568627 }, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-10-22T00:00:00Z' },
      { id: 101, run_attempt: 1, workflow_id: 77, path: '.github/workflows/ci.yml', repository: { full_name: 'elsoul/erpc-sdk', id: 1429568627 }, head_sha: sha, head_branch: 'main', event: 'push', status: 'in_progress', conclusion: null, created_at: '2026-10-22T00:01:00Z' },
    ],
  }
  const selection = selectFoundationCIRun({ workflow, runs, expected: { sourceCommit: sha } })
  assert.equal(selection.id, 101)
  assert.throws(() => validateFoundationCIProof({ workflow, runs, selection, recheck: runs.workflow_runs[1], jobs: { total_count: 1, jobs: [{ id: 1, name: 'required-ci', status: 'completed', conclusion: 'success', run_id: 101, run_attempt: 1, head_sha: sha, repository_id: 1429568627 }] }, expected: { sourceCommit: sha } }), /not completed|did not succeed/)
  const successfulRuns = { ...runs, workflow_runs: runs.workflow_runs.map(run => run.id === 101 ? { ...run, status: 'completed', conclusion: 'success' } : run) }
  assert.throws(() => validateFoundationCIProof({ workflow, runs: successfulRuns, selection, recheck: successfulRuns.workflow_runs[1], jobs: { total_count: 2, jobs: [{ id: 1, name: 'required-ci', status: 'completed', conclusion: 'success' }, { id: 2, name: 'required-ci', status: 'completed', conclusion: 'success' }] }, expected: { sourceCommit: sha } }), /exactly one required-ci/)
  assert.throws(() => selectFoundationCIRun({ workflow, runs: { total_count: 1, workflow_runs: [{ ...successfulRuns.workflow_runs[1], event: 'pull_request' }] }, expected: { sourceCommit: sha } }), /ineligible|No eligible/)
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

const foundationArtifacts = [
  { kind: 'npm', filename: 'elsoul-erpc-sdk-0.9.1.tgz', name: '@elsoul/erpc-sdk', version: FOUNDATION_VERSION, sha256: '1'.repeat(64), files: ['package/package.json', 'package/LICENSE', 'package/dist/index.js'] },
  { kind: 'pypi-wheel', filename: 'erpc_sdk-0.9.1-py3-none-any.whl', name: 'erpc-sdk', version: FOUNDATION_VERSION, sha256: '2'.repeat(64), files: ['erpc_sdk/__init__.py', 'erpc_sdk-0.9.1.dist-info/METADATA', 'erpc_sdk-0.9.1.dist-info/LICENSE'] },
  { kind: 'pypi-sdist', filename: 'erpc_sdk-0.9.1.tar.gz', name: 'erpc-sdk', version: FOUNDATION_VERSION, sha256: '3'.repeat(64), files: ['erpc_sdk-0.9.1/PKG-INFO', 'erpc_sdk-0.9.1/LICENSE'] },
  { kind: 'rubygems', filename: 'erpc-sdk-0.9.1.gem', name: 'erpc-sdk', version: FOUNDATION_VERSION, sha256: '4'.repeat(64), files: ['metadata.gz', 'data.tar.gz', 'checksums.yaml.gz', 'LICENSE'] },
]

const foundationGoInventory = {
  files: [
    { path: 'LICENSE', sha256: '5'.repeat(64) },
    { path: 'go.mod', sha256: '6'.repeat(64) },
    { path: 'rpc.go', sha256: '7'.repeat(64) },
  ],
  inventorySha256: '',
}
foundationGoInventory.inventorySha256 = sha256Hex(canonicalJson(foundationGoInventory.files))

const foundationRustReceipt = {
  identity: 'erpc-sdk',
  version: '0.10.0',
  sourceCommit: FOUNDATION_RUST_SOURCE,
  sha256: FOUNDATION_RUST_SHA256,
  yanked: false,
  downloadUrl: 'https://crates.io/api/v1/crates/erpc-sdk/0.10.0/download',
}

test('foundation plan is content-addressed and states the mixed release boundary', () => {
  const plan = buildFoundationPlan({
    sourceSha: sha,
    artifacts: foundationArtifacts,
    goInventory: foundationGoInventory,
    rustReceipt: foundationRustReceipt,
    registryPreflight: {
      npm: { state: 'absent', status: 404 },
      pypi: { state: 'absent', status: 404 },
      rubygems: { state: 'absent', status: 404 },
      rust: { state: 'match', status: 200 },
    },
  })
  assert.equal(plan.tags.release, FOUNDATION_TAG)
  assert.equal(plan.tags.go, FOUNDATION_GO_TAG)
  assert.equal(plan.githubRelease.title, FOUNDATION_RELEASE_TITLE)
  assert.equal(plan.githubRelease.bodySha256, sha256Hex(plan.githubRelease.body))
  assert.match(plan.githubRelease.body, /Bitcoin Core HTTP JSON-RPC exists only in Rust 0\.10\.0/)
  assert.doesNotMatch(plan.githubRelease.body, /all-language BTC|five-language BTC/i)
  assert.deepEqual(validateFoundationPlan(plan).artifacts, foundationArtifacts)
  assert.throws(() => validateFoundationPlan({ ...plan, tags: { ...plan.tags, release: 'v0.9.1' } }), /release tag/)
  assert.throws(() => validateFoundationArtifactDescriptor({ ...foundationArtifacts[0], filename: 'elsoul-erpc-sdk-0.9.1.tgz$(touch pwned)' }), /basename is not canonical/)
})

test('foundation proof aggregate binds observed receipts, auth paths, and attestation claims', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-proof-set-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const plan = buildFoundationPlan({
    sourceSha: sha,
    artifacts: foundationArtifacts,
    goInventory: foundationGoInventory,
    rustReceipt: foundationRustReceipt,
    registryPreflight: { npm: { state: 'absent', status: 404 }, pypi: { state: 'absent', status: 404 }, rubygems: { state: 'absent', status: 404 }, rust: { state: 'match', status: 200 } },
  })
  const common = { schemaVersion: 1, repository: 'elsoul/erpc-sdk', sourceCommit: sha, planSha256: sha256Hex(canonicalJson(plan)), version: FOUNDATION_VERSION, preparedRunId: '12345', preparedRunAttempt: '1', preparedArtifactId: '45678', observerRunId: '54321', observerAttempt: '1', observedAt: '2026-10-22T00:00:00.000Z' }
  const provenance = { predicateType: 'https://slsa.dev/provenance/v1', predicate: { buildDefinition: { externalParameters: { workflow: { repository: 'https://github.com/elsoul/erpc-sdk', path: '.github/workflows/release.yml', ref: 'refs/heads/main' } }, internalParameters: { github: { repository_id: '1429568627', event_name: 'workflow_dispatch' } }, resolvedDependencies: [{ digest: { gitCommit: sha } }] } } }
  const pypiStatement = { predicateType: 'https://docs.pypi.org/attestations/publish/v1', subject: [{ name: foundationArtifacts[1].filename, digest: { sha256: foundationArtifacts[1].sha256 } }] }
  const pypiClaims = { '1.3.6.1.4.1.57264.1.8': 'https://token.actions.githubusercontent.com', '1.3.6.1.4.1.57264.1.9': 'https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main', '1.3.6.1.4.1.57264.1.12': 'https://github.com/elsoul/erpc-sdk', '1.3.6.1.4.1.57264.1.13': sha, '1.3.6.1.4.1.57264.1.14': 'refs/heads/main', '1.3.6.1.4.1.57264.1.15': '1429568627', '1.3.6.1.4.1.57264.1.18': 'https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main', '1.3.6.1.4.1.57264.1.19': sha, '1.3.6.1.4.1.57264.1.20': 'workflow_dispatch' }
  const sum = `h1:${Buffer.from('a'.repeat(32)).toString('base64')}`
  const receipts = {
    'npm-proof.json': { ...common, registry: 'npmjs.org', identity: '@elsoul/erpc-sdk', state: 'published', tarball: 'https://registry.npmjs.org/@elsoul/erpc-sdk/-/erpc-sdk-0.9.1.tgz', integrity: 'sha512-test', expectedSha256: foundationArtifacts[0].sha256, observedSha256: foundationArtifacts[0].sha256, provenance, certificateClaims: { '1.3.6.1.4.1.57264.1.8': 'https://token.actions.githubusercontent.com', '1.3.6.1.4.1.57264.1.9': 'https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main', '1.3.6.1.4.1.57264.1.13': sha, '1.3.6.1.4.1.57264.1.14': 'refs/heads/main', '1.3.6.1.4.1.57264.1.19': sha, '1.3.6.1.4.1.57264.1.15': '1429568627', '1.3.6.1.4.1.57264.1.18': 'https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main', '1.3.6.1.4.1.57264.1.20': 'workflow_dispatch' }, auth: { requested: true, uploadAttempted: true, uploadOutcome: 'success', publicProvenanceObserved: true } },
    'pypi-proof.json': { ...common, registry: 'pypi.org', identity: 'erpc-sdk', state: 'published', files: [
      { filename: foundationArtifacts[1].filename, url: 'https://files.pythonhosted.org/wheel', sha256: foundationArtifacts[1].sha256, yanked: false, attestations: [pypiStatement], certificateClaims: pypiClaims },
      { filename: foundationArtifacts[2].filename, url: 'https://files.pythonhosted.org/sdist', sha256: foundationArtifacts[2].sha256, yanked: false, attestations: [pypiStatement], certificateClaims: pypiClaims },
    ], auth: { requested: true, uploadAttempted: true, uploadOutcome: 'success', attestationsVerified: true } },
    'rubygems-proof.json': { ...common, registry: 'rubygems.org', identity: 'erpc-sdk', state: 'published', sha256: foundationArtifacts[3].sha256, auth: { requested: true, uploadAttempted: true, credentialObserved: true }, credentialCleanup: { envCleared: true, filesCleared: true }, consumer: { installed: true } },
    'rust-proof.json': { ...common, registry: 'crates.io', identity: 'erpc-sdk', version: '0.10.0', sourceCommit: FOUNDATION_RUST_SOURCE, foundationSourceCommit: sha, sha256: FOUNDATION_RUST_SHA256, registryStatus: 200, yanked: false, downloadStatus: 200, auth: { requested: false, uploadAttempted: false } },
    'tag-proof.json': { ...common, registry: 'github.com', tags: { release: { ref: 'refs/tags/non-rust-v0.9.1', sha }, go: { ref: 'refs/tags/packages/go/v0.9.1', sha } }, auth: { requested: true, writeObserved: true } },
    'go-proof.json': { ...common, registry: 'proxy.golang.org', version: 'v0.9.1', module: 'github.com/elsoul/erpc-sdk/packages/go', sum, goModSum: sum, originHash: sha, originSubdir: 'packages/go', directOriginHash: sha, directOriginSubdir: 'packages/go', zipSha256: hash, auth: { requested: false, uploadAttempted: false } },
  }
  for (const [file, receipt] of Object.entries(receipts)) await writeFile(join(directory, file), JSON.stringify(receipt))
  const manifestFile = join(directory, 'foundation-proof-manifest.json')
  const manifest = await verifyFoundationProofSet({ plan, proofDirectory: directory, manifestFile, expected: { runId: '12345', runAttempt: '1', artifactId: '45678' } })
  assert.equal(manifest.state, 'complete')
  const boundManifest = await verifyFoundationProofSet({ plan, proofDirectory: directory, manifestFile, expected: { runId: '12345', runAttempt: '1', artifactId: '45678', receiptArtifactId: '56789' } })
  assert.equal(boundManifest.proofReceiptsArtifactId, '56789')
  const planFile = `${directory}-foundation-plan.json`
  t.after(() => rm(planFile, { force: true }))
  await writeFile(planFile, `${canonicalJson(plan)}\n`)
  const cliEnvironment = { FOUNDATION_PLAN_FILE: planFile, FOUNDATION_PROOF_DIR: directory, FOUNDATION_PROOF_MANIFEST_FILE: manifestFile, FOUNDATION_PREPARED_RUN_ID: '12345', FOUNDATION_PREPARED_RUN_ATTEMPT: '1', FOUNDATION_PREPARED_ARTIFACT_ID: '45678', FOUNDATION_PROOF_RECEIPTS_ARTIFACT_ID: '56789' }
  await runVerifierCli(['--foundation-proof-verify'], cliEnvironment)
  assert.equal(JSON.parse(await readFile(manifestFile, 'utf8')).proofReceiptsArtifactId, '56789')
  await assert.rejects(runVerifierCli(['--foundation-proof-verify'], { ...cliEnvironment, FOUNDATION_PROOF_RECEIPTS_ARTIFACT_ID: '99999' }), /receipts artifact binding mismatch/)
  await runVerifierCli(['--foundation-proof-verify'], { ...cliEnvironment, FOUNDATION_PROOF_RECEIPTS_ARTIFACT_ID: undefined })
  assert.equal(JSON.parse(await readFile(manifestFile, 'utf8')).proofReceiptsArtifactId, '56789')
  const tampered = { ...receipts['tag-proof.json'], tags: { ...receipts['tag-proof.json'].tags, go: { ref: 'refs/tags/packages/go/v0.9.1', sha: 'c'.repeat(40) } } }
  await writeFile(join(directory, 'tag-proof.json'), JSON.stringify(tampered))
  await assert.rejects(() => verifyFoundationProofSet({ plan, proofDirectory: directory, manifestFile, expected: { runId: '12345', runAttempt: '1', artifactId: '45678' } }))
})

test('foundation registry states keep HTTP failures distinct from absence and support PyPI subsets', () => {
  assert.equal(classifyFoundationRegistryResponse({ registry: 'npm', status: 403, body: '', expectedVersion: FOUNDATION_VERSION }).state, 'http-error')
  assert.equal(classifyFoundationRegistryResponse({ registry: 'npm', status: 404, body: '', expectedVersion: FOUNDATION_VERSION }).state, 'absent')
  const npm = JSON.stringify({ name: '@elsoul/erpc-sdk', version: FOUNDATION_VERSION, dist: { integrity: 'sha512-test', tarball: 'https://registry.npmjs.org/@elsoul/erpc-sdk/-/erpc-sdk-0.9.1.tgz' } })
  assert.equal(classifyFoundationRegistryResponse({ registry: 'npm', status: 200, body: npm, expectedVersion: FOUNDATION_VERSION }).state, 'match')
  assert.equal(classifyFoundationRegistryResponse({ registry: 'npm', status: 200, body: JSON.stringify({ versions: { '0.9.1': JSON.parse(npm) } }), expectedVersion: FOUNDATION_VERSION }).state, 'malformed')
  const pypi = JSON.stringify({ info: { name: 'erpc-sdk', version: FOUNDATION_VERSION }, urls: [{ filename: 'erpc_sdk-0.9.1-py3-none-any.whl', packagetype: 'bdist_wheel', digests: { sha256: '2'.repeat(64) }, yanked: false, url: 'https://files.pythonhosted.org/wheel' }] })
  assert.equal(classifyFoundationRegistryResponse({ registry: 'pypi', status: 200, body: pypi, expectedVersion: FOUNDATION_VERSION, expectedArtifacts: ['erpc_sdk-0.9.1-py3-none-any.whl', 'erpc_sdk-0.9.1.tar.gz'] }).state, 'partial')
  const ruby = JSON.stringify({ name: 'erpc-sdk', version: FOUNDATION_VERSION, sha: '4'.repeat(64), platform: 'ruby' })
  assert.equal(classifyFoundationRegistryResponse({ registry: 'rubygems', status: 200, body: ruby, expectedVersion: FOUNDATION_VERSION, expectedSha256: '9'.repeat(64) }).state, 'conflict')
  assert.equal(classifyFoundationRegistryResponse({ registry: 'rubygems', status: 200, body: ruby.replace('"ruby"', '"x86_64-linux"'), expectedVersion: FOUNDATION_VERSION, expectedSha256: '4'.repeat(64) }).state, 'malformed')
  assert.deepEqual(validateFoundationPyPIResponse({ body: JSON.stringify({ info: { name: 'erpc-sdk', version: FOUNDATION_VERSION }, urls: [
    { filename: 'erpc_sdk-0.9.1-py3-none-any.whl', packagetype: 'bdist_wheel', yanked: false, url: 'https://files.pythonhosted.org/wheel', digests: { sha256: '2'.repeat(64) }, attestations: [{ url: 'https://pypi.org/attestation/wheel' }] },
    { filename: 'erpc_sdk-0.9.1.tar.gz', packagetype: 'sdist', yanked: false, url: 'https://files.pythonhosted.org/sdist', digests: { sha256: '3'.repeat(64) }, attestations: [{ url: 'https://pypi.org/attestation/sdist' }] },
  ] }), expectedVersion: FOUNDATION_VERSION, expectedFiles: ['erpc_sdk-0.9.1-py3-none-any.whl', 'erpc_sdk-0.9.1.tar.gz'], expectedSha256: { 'erpc_sdk-0.9.1-py3-none-any.whl': '2'.repeat(64), 'erpc_sdk-0.9.1.tar.gz': '3'.repeat(64) } }), [
    { filename: 'erpc_sdk-0.9.1-py3-none-any.whl', url: 'https://files.pythonhosted.org/wheel', sha256: '2'.repeat(64) },
    { filename: 'erpc_sdk-0.9.1.tar.gz', url: 'https://files.pythonhosted.org/sdist', sha256: '3'.repeat(64) },
  ])
  assert.throws(() => validateFoundationPyPIResponse({ body: JSON.stringify({ info: { name: 'WRONG', version: FOUNDATION_VERSION }, urls: [] }), expectedVersion: FOUNDATION_VERSION, expectedFiles: [], expectedSha256: {} }), /identity\/version/)
  assert.throws(() => validateFoundationPyPIResponse({ body: JSON.stringify({ info: { name: 'erpc-sdk', version: FOUNDATION_VERSION }, urls: [{ filename: 'extra.whl' }] }), expectedVersion: FOUNDATION_VERSION, expectedFiles: [], expectedSha256: {} }), /missing or unexpected/)
  assert.throws(() => validateFoundationPyPIResponse({ body: JSON.stringify({ info: { name: 'erpc-sdk', version: FOUNDATION_VERSION }, urls: [
    { filename: 'erpc_sdk-0.9.1-py3-none-any.whl', packagetype: 'sdist', yanked: false, url: 'https://files.pythonhosted.org/wheel', digests: { sha256: '2'.repeat(64) } },
  ] }), expectedVersion: FOUNDATION_VERSION, expectedFiles: ['erpc_sdk-0.9.1-py3-none-any.whl'], expectedSha256: { 'erpc_sdk-0.9.1-py3-none-any.whl': '2'.repeat(64) } }), /file proof mismatch/)
})

test('foundation bundle verifier binds every sidecar and rejects tampering or extras', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-foundation-bundle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const artifacts = foundationArtifacts.map(artifact => ({
    ...artifact,
    sha256: sha256Hex(`${artifact.kind}-approved`),
  }))
  for (const artifact of artifacts) await writeFile(join(directory, artifact.filename), `${artifact.kind}-approved`)
  const preflight = { npm: { state: 'absent', status: 404 }, pypi: { state: 'absent', status: 404 }, rubygems: { state: 'absent', status: 404 }, rust: { state: 'match', status: 200 } }
  const plan = buildFoundationPlan({ sourceSha: sha, artifacts, goInventory: foundationGoInventory, rustReceipt: foundationRustReceipt, registryPreflight: preflight })
  await writeFile(join(directory, 'artifact-metadata.json'), `${canonicalJson(plan.artifacts)}\n`)
  await writeFile(join(directory, 'go-inventory.json'), `${canonicalJson(plan.goInventory)}\n`)
  await writeFile(join(directory, 'rust-receipt.json'), `${canonicalJson(plan.rustReceipt)}\n`)
  await writeFile(join(directory, 'preflight.json'), `${canonicalJson(plan.registryPreflight)}\n`)
  await writeFile(join(directory, 'foundation-plan.json'), `${canonicalJson(plan)}\n`)
  await writeFile(join(directory, 'foundation-plan.sha256'), `${sha256Hex(canonicalJson(plan))}\n`)
  await writeFile(join(directory, 'release-body.md'), plan.githubRelease.body)
  const checksums = []
  for (const file of plan.bundleFiles.filter(file => file !== 'checksums.txt')) {
    checksums.push(`${await sha256Hex(await readFile(join(directory, file)))}  ${file}`)
  }
  await writeFile(join(directory, 'checksums.txt'), `${checksums.join('\n')}\n`)
  assert.equal((await verifyFoundationBundle({ plan, artifactDirectory: directory })).files.length, 4)

  await writeFile(join(directory, 'release-body.md'), 'tampered release body')
  await assert.rejects(() => verifyFoundationBundle({ plan, artifactDirectory: directory }), /release body sidecar/)
  await writeFile(join(directory, 'release-body.md'), plan.githubRelease.body)
  await writeFile(join(directory, 'go-inventory.json'), '{}')
  await assert.rejects(() => verifyFoundationBundle({ plan, artifactDirectory: directory }), /Go inventory sidecar/)
  await writeFile(join(directory, 'go-inventory.json'), `${canonicalJson(plan.goInventory)}\n`)
  await writeFile(join(directory, 'rust-receipt.json'), '{}')
  await assert.rejects(() => verifyFoundationBundle({ plan, artifactDirectory: directory }), /Rust receipt sidecar/)
  await writeFile(join(directory, 'rust-receipt.json'), `${canonicalJson(plan.rustReceipt)}\n`)
  await rm(join(directory, 'release-body.md'))
  await assert.rejects(() => verifyFoundationBundle({ plan, artifactDirectory: directory }))
  await writeFile(join(directory, 'release-body.md'), plan.githubRelease.body)
  await writeFile(join(directory, 'unexpected.txt'), 'unexpected')
  await assert.rejects(() => verifyFoundationBundle({ plan, artifactDirectory: directory }), /Unexpected foundation bundle member/)
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

test('clean Cargo metadata may omit dirty while true or malformed values fail', () => {
  const cleanCargoMetadata = JSON.stringify({
    git: { sha1: sha },
    path_in_vcs: 'packages/rust',
  })
  assert.deepEqual(
    verifyArchiveContents({ ...validArchive(), vcsInfo: cleanCargoMetadata }),
    {
      root: 'erpc-sdk-0.10.0',
      commit: sha,
      pathInVcs: 'packages/rust',
    },
  )
  for (const dirty of [true, null, 'false', 0]) {
    const vcsInfo = JSON.stringify({
      git: { sha1: sha, dirty },
      path_in_vcs: 'packages/rust',
    })
    assert.throws(() => verifyArchiveContents({ ...validArchive(), vcsInfo }))
  }
})

test('workflow archive selection executes the exact CLI guard with real files', async t => {
  const archiveDirectory = await mkdtemp(join(tmpdir(), 'erpc-sdk-archive-selection-'))
  t.after(() => rm(archiveDirectory, { recursive: true, force: true }))
  const selectFromWorkflow = () => execFileAsync(
    process.execPath,
    [verifierPath.pathname, '--select-archive'],
    {
      env: {
        ...process.env,
        ARCHIVE_DIR: archiveDirectory,
        EXPECTED_VERSION: '0.10.0',
      },
    },
  )

  await writeFile(join(archiveDirectory, 'erpc-sdk-0.10.0.crate'), 'crate')
  const valid = await selectFromWorkflow()
  assert.equal(valid.stdout.trim(), join(archiveDirectory, 'erpc-sdk-0.10.0.crate'))

  await rm(join(archiveDirectory, 'erpc-sdk-0.10.0.crate'))
  await writeFile(join(archiveDirectory, 'erpc-sdk-0.9.0.crate'), 'wrong version')
  await assert.rejects(selectFromWorkflow, /found 0/)

  await writeFile(join(archiveDirectory, 'erpc_sdk-0.10.0.crate'), 'crate')
  await writeFile(join(archiveDirectory, 'erpc-sdk-0.10.0.crate'), 'crate')
  await assert.rejects(selectFromWorkflow, /found 2/)
})

test('every internal verifier mode rejects extra, duplicate, and conflicting CLI arguments', async () => {
  const workflowEnvironment = {
    REPOSITORY: 'elsoul/erpc-sdk',
    REPOSITORY_ID: '1429568627',
    EVENT_NAME: 'workflow_dispatch',
    EVENT_REF: 'refs/heads/main',
    EVENT_SHA: sha,
    EXPECTED_COMMIT: sha,
    CHECKOUT_HEAD: sha,
    EXPECTED_VERSION: '0.10.0',
    PUBLISH: 'false',
    APPROVED_SHA256: '',
  }
  const registryEnvironment = {
    REGISTRY_STATUS: '200',
    REGISTRY_RESPONSE_FILE: '/dev/null',
    EXPECTED_VERSION: '0.10.0',
    APPROVED_SHA256: hash,
  }
  const archiveEnvironment = {
    ARCHIVE_LIST_FILE: '/dev/null',
    MANIFEST_FILE: '/dev/null',
    VCS_INFO_FILE: '/dev/null',
    EXPECTED_VERSION: '0.10.0',
    EXPECTED_COMMIT: sha,
  }
  const selectEnvironment = {
    ARCHIVE_DIR: '/tmp/erpc-sdk-no-such-archive-directory',
    EXPECTED_VERSION: '0.10.0',
  }
  const cases = [
    [['--workflow-guard', '--unknown'], workflowEnvironment],
    [['--workflow-guard', '--scope', 'all'], workflowEnvironment],
    [['--workflow-guard', '--workflow-guard'], workflowEnvironment],
    [['--registry-check', '--unknown'], registryEnvironment],
    [['--registry-check', '--registry-check'], registryEnvironment],
    [['--archive-check', '--scope', 'rust'], archiveEnvironment],
    [['--archive-check', '--archive-check'], archiveEnvironment],
    [['--select-archive', '--scope', 'rust'], selectEnvironment],
    [['--select-archive', '--select-archive'], selectEnvironment],
    [['--foundation-describe-artifacts', '--unknown'], {}],
    [['--foundation-go-inventory', '--foundation-go-inventory'], {}],
    [['--foundation-plan', '--scope', 'all'], {}],
    [['--foundation-ci-select', '--unknown'], {}],
    [['--foundation-ci-proof', '--unknown'], {}],
    [['--foundation-preparation', '--unknown'], {}],
    [['--foundation-verify', '--foundation-verify'], {}],
    [['--foundation-proof-verify', '--unknown'], {}],
    [['--foundation-registry', '--unknown'], {}],
    [['--foundation-pypi-proof', '--unknown'], {}],
  ]
  for (const [arguments_, environment] of cases) {
    await assert.rejects(
      runVerifierCli(arguments_, environment),
      /accepts exactly one mode argument/,
    )
  }
})

test('extracted workflow Python/npm/tag blocks execute their corrected guards offline', async t => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const pythonBuildBlock = extractWorkflowRunBlock(workflow, 'Validate and build exact Python distributions')
  assert.doesNotMatch(pythonBuildBlock, /--no-deps/)
  assert.match(pythonBuildBlock, /pip install --disable-pip-version-check "\$WHEEL_FILE"/)
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-workflow-blocks-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const bundle = join(directory, 'bundle')
  const stage = join(directory, 'stage')
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(bundle), mkdir(stage)]))
  const wheel = 'erpc_sdk-0.9.1-py3-none-any.whl'
  const sdist = 'erpc_sdk-0.9.1.tar.gz'
  const wheelBytes = 'wheel-approved'
  const sdistBytes = 'sdist-approved'
  await writeFile(join(bundle, wheel), wheelBytes)
  await writeFile(join(bundle, sdist), sdistBytes)
  await writeFile(join(bundle, 'foundation-plan.json'), JSON.stringify({ artifacts: [
    { kind: 'pypi-wheel', filename: wheel, sha256: sha256Hex(wheelBytes) },
    { kind: 'pypi-sdist', filename: sdist, sha256: sha256Hex(sdistBytes) },
  ] }))
  const pypiResponse = join(directory, 'pypi.json')
  await writeFile(pypiResponse, JSON.stringify({ urls: [{ filename: wheel, packagetype: 'bdist_wheel', yanked: false, digests: { sha256: sha256Hex(wheelBytes) } }] }))
  const output = join(directory, 'github-output')
  await writeFile(output, '')
  const pypiCode = extractWorkflowHeredoc(workflow, 'python - "$STATUS" "$RESPONSE_FILE" "$BUNDLE_DIR" "$STAGE_DIR" "$EXPECTED_ARTIFACTS" "$STATE" <<\'PY\'', 'PY')
  const pypiCodePath = join(directory, 'pypi-stage.py')
  await writeFile(pypiCodePath, pypiCode)
  await execFileAsync('python3', [pypiCodePath, '200', pypiResponse, bundle, stage, JSON.stringify([wheel, sdist]), 'partial'], { env: { ...process.env, GITHUB_OUTPUT: output } })
  assert.equal((await readFile(join(stage, sdist), 'utf8')), sdistBytes)
  await assert.rejects(() => readFile(join(stage, wheel), 'utf8'))
  assert.match(await readFile(output, 'utf8'), /missing=true/)

  const npmArchive = join(directory, 'npm.tgz')
  const npmBytes = Buffer.from('npm-approved')
  await writeFile(npmArchive, npmBytes)
  const npmResponse = join(directory, 'npm.json')
  const npmIntegrity = `sha512-${(await import('node:crypto')).createHash('sha512').update(npmBytes).digest('base64')}`
  await writeFile(npmResponse, JSON.stringify({ name: '@elsoul/erpc-sdk', version: '0.9.1', dist: { integrity: npmIntegrity, tarball: 'https://registry.npmjs.org/@elsoul/erpc-sdk/-/erpc-sdk-0.9.1.tgz' } }))
  const npmCodePath = join(directory, 'npm-check.mjs')
  const npmCode = extractWorkflowHeredoc(workflow, 'node --input-type=module - "$RESPONSE_FILE" "$RUNNER_TEMP/npm-published.tgz" "$EXPECTED_VERSION" <<\'NODE\'', 'NODE')
  await writeFile(npmCodePath, npmCode)
  await execFileAsync(process.execPath, [npmCodePath, npmResponse, npmArchive, '0.9.1'])

  const npmUrlCode = extractWorkflowHeredoc(workflow, 'NPM_TARBALL_URL="$(node --input-type=module - "$RESPONSE_FILE" "$EXPECTED_VERSION" <<\'NODE\'', 'NODE')
  const npmUrlCodePath = join(directory, 'npm-url-check.mjs')
  await writeFile(npmUrlCodePath, npmUrlCode)
  const npmUrlResult = await execFileAsync(process.execPath, [npmUrlCodePath, npmResponse, '0.9.1'])
  assert.equal(npmUrlResult.stdout, 'https://registry.npmjs.org/@elsoul/erpc-sdk/-/erpc-sdk-0.9.1.tgz')

  const npmPublishStub = join(directory, 'npm')
  const npmPublishLog = join(directory, 'npm-publish-argv.json')
  const forbiddenCommandFile = join(directory, 'command-substitution-ran')
  await writeFile(npmPublishStub, `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.NPM_PUBLISH_LOG, JSON.stringify(process.argv.slice(2)))
`)
  await chmod(npmPublishStub, 0o755)
  const npmPublishBlock = extractWorkflowRunBlock(workflow, 'Publish exact npm tarball with OIDC')
  await execFileAsync('bash', ['-c', `set -euo pipefail\n${npmPublishBlock}`], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      NPM_CONFIG_USERCONFIG: join(directory, 'empty-npmrc'),
      NPM_FILE: `$(touch ${forbiddenCommandFile})`,
      NPM_PUBLISH_LOG: npmPublishLog,
      RUNNER_TEMP: directory,
    },
  })
  assert.equal(JSON.parse(await readFile(npmPublishLog, 'utf8'))[2], `--registry=https://registry.npmjs.org/`)
  await assert.rejects(() => readFile(forbiddenCommandFile), { code: 'ENOENT' })

  const ghPath = join(directory, 'gh')
  const ghLog = join(directory, 'gh-argv.jsonl')
  await writeFile(ghLog, '')
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n')
if (args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST') { process.stdout.write(JSON.stringify({ ref: 'refs/tags/example', object: { sha: process.env.EXPECTED_COMMIT } })); process.exit(0) }
if (args.includes('--jq')) { process.stdout.write(process.env.EXPECTED_COMMIT); process.exit(0) }
process.stderr.write('HTTP 404')
process.exit(1)
`)
  await chmod(ghPath, 0o755)
  const curlPath = join(directory, 'curl')
  const curlCount = join(directory, 'curl-count')
  await writeFile(curlCount, '0')
  await writeFile(curlPath, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const count = Number(fs.readFileSync(process.env.CURL_COUNT, 'utf8')) + 1
fs.writeFileSync(process.env.CURL_COUNT, String(count))
const outputIndex = args.indexOf('--output')
const status = count <= 2 ? 404 : 200
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], status === 200 ? JSON.stringify({ object: { sha: process.env.EXPECTED_COMMIT } }) : '')
const writeOutIndex = args.indexOf('--write-out')
if (writeOutIndex >= 0) process.stdout.write(String(status))
`)
  await chmod(curlPath, 0o755)
  const tagBlock = extractWorkflowRunBlock(workflow, 'Create or verify only the two approved refs')
  await execFileAsync('bash', ['-c', `set -euo pipefail\n${tagBlock}`], { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, RELEASE_USER_AGENT, GH_LOG: ghLog, CURL_COUNT: curlCount, EXPECTED_COMMIT: sha, REPOSITORY: 'elsoul/erpc-sdk', RUNNER_TEMP: directory, GH_TOKEN: 'offline-test-token' } })
  const ghCalls = (await readFile(ghLog, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.ok(ghCalls.some(arguments_ => arguments_.includes('--method') && arguments_.includes('POST')))
  assert.doesNotMatch(tagBlock, /git push/)

  const conflictDirectory = join(directory, 'tag-conflict')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(conflictDirectory))
  const conflictCurl = join(conflictDirectory, 'curl')
  const conflictLog = join(conflictDirectory, 'curl-count')
  const conflictGhLog = join(conflictDirectory, 'gh-log')
  await writeFile(conflictLog, '0')
  await writeFile(conflictGhLog, '')
  await writeFile(conflictCurl, `#!/usr/bin/env node
const fs = require('node:fs')
const count = Number(fs.readFileSync(process.env.CURL_COUNT, 'utf8')) + 1
fs.writeFileSync(process.env.CURL_COUNT, String(count))
const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output')
const status = count === 1 ? 404 : 200
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], status === 200 ? JSON.stringify({ object: { sha: 'c'.repeat(40) } }) : '')
const writeOutIndex = args.indexOf('--write-out')
if (writeOutIndex >= 0) process.stdout.write(String(status))
`)
  await chmod(conflictCurl, 0o755)
  const conflictGh = join(conflictDirectory, 'gh')
  await writeFile(conflictGh, `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.exit(99)
`)
  await chmod(conflictGh, 0o755)
  await assert.rejects(
    execFileAsync('bash', ['-c', `set -euo pipefail\n${tagBlock}`], {
      env: {
        ...process.env,
        PATH: `${conflictDirectory}:${process.env.PATH ?? ''}`,
        RELEASE_USER_AGENT,
        GH_LOG: conflictGhLog,
        CURL_COUNT: conflictLog,
        EXPECTED_COMMIT: sha,
        REPOSITORY: 'elsoul/erpc-sdk',
        RUNNER_TEMP: conflictDirectory,
        GH_TOKEN: 'offline-test-token',
      },
    }),
  )
  assert.equal((await readFile(conflictGhLog, 'utf8')).trim(), '')

  const releaseBlock = extractWorkflowRunBlock(workflow, 'Reconcile existing Release or create a draft')
  const releasePlan = join(directory, 'release-plan.json')
  const releaseBody = join(directory, 'release-body.md')
  await writeFile(releasePlan, JSON.stringify({ githubRelease: { body: 'APPROVED\n', bodySha256: sha256Hex('APPROVED\n') } }))
  await writeFile(releaseBody, 'UNAPPROVED\n')
  const forbiddenWrite = join(directory, 'forbidden-write')
  await writeFile(forbiddenWrite, '#!/bin/sh\nexit 99\n')
  await chmod(forbiddenWrite, 0o755)
  await assert.rejects(
    execFileAsync('bash', ['-c', `set -euo pipefail\n${releaseBlock}`], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        RELEASE_USER_AGENT,
        GH_TOKEN: 'offline-test-token',
        REPOSITORY: 'elsoul/erpc-sdk',
        TAG: 'non-rust-v0.9.1',
        EXPECTED_COMMIT: sha,
        RELEASE_TITLE: FOUNDATION_RELEASE_TITLE,
        BODY_FILE: releaseBody,
        PLAN_FILE: releasePlan,
        RUNNER_TEMP: directory,
      },
    }),
    /Release body is not the approved plan body/,
  )
  const releaseNetworkBin = join(directory, 'release-network-bin')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(releaseNetworkBin))
  await writeFile(join(releaseNetworkBin, 'curl'), `#!/bin/sh
out=''
for arg in "$@"; do
  if [ "$previous" = --output ]; then out="$arg"; fi
  previous="$arg"
done
printf '%s\n' '{"message":"backend says 404 in a HTTP 500 response"}' > "$out"
printf '%s' 500
`)
  await writeFile(join(releaseNetworkBin, 'gh'), '#!/bin/sh\nexit 99\n')
  await chmod(join(releaseNetworkBin, 'curl'), 0o755)
  await chmod(join(releaseNetworkBin, 'gh'), 0o755)
  await writeFile(releaseBody, 'APPROVED\n')
  await assert.rejects(
    execFileAsync('bash', ['-c', `set -euo pipefail\n${releaseBlock}`], {
      env: {
        ...process.env,
        PATH: `${releaseNetworkBin}:${process.env.PATH ?? ''}`,
        RELEASE_USER_AGENT,
        GH_TOKEN: 'offline-test-token',
        REPOSITORY: 'elsoul/erpc-sdk',
        TAG: 'non-rust-v0.9.1',
        EXPECTED_COMMIT: sha,
        RELEASE_TITLE: FOUNDATION_RELEASE_TITLE,
        BODY_FILE: releaseBody,
        PLAN_FILE: releasePlan,
        RUNNER_TEMP: directory,
      },
    }),
    /HTTP 500/,
  )

  const assetBlock = extractWorkflowRunBlock(workflow, 'Reconcile Release assets without overwrite')
  assert.match(assetBlock, /proofReceiptsArtifactId/)
  assert.match(assetBlock, /actions\/artifacts\/\$snapshot_receipts_artifact\/zip/)
  assert.match(assetBlock, /preflight_dir/)
  assert.ok(assetBlock.indexOf('preflight_dir=') < assetBlock.indexOf('missing=()'))
  const assetDirectory = join(directory, 'assets')
  const assetDownloadDirectory = join(directory, 'asset-downloads')
  const assetBin = join(directory, 'asset-bin')
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(assetDirectory), mkdir(assetDownloadDirectory), mkdir(assetBin)]))
  await writeFile(join(assetDirectory, 'approved.txt'), 'approved bytes')
  const assetGh = join(assetBin, 'gh')
  const assetLog = join(directory, 'gh-assets-log')
  await writeFile(assetLog, '')
  await writeFile(assetGh, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.ASSET_GH_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'api' && args.includes('--jq')) { process.stdout.write('1'); process.exit(0) }
if (args[0] === 'api') { process.stdout.write(process.env.GH_ASSETS_JSON); process.exit(0) }
if (args[0] === 'release' && args[1] === 'download') {
  const dir = args[args.indexOf('--dir') + 1]
  const name = args[args.indexOf('--pattern') + 1]
  fs.writeFileSync(dir + '/' + name, 'approved bytes')
  process.exit(0)
}
if (args[0] === 'release' && args[1] === 'upload') process.exit(0)
process.exit(99)
`)
  await chmod(assetGh, 0o755)
  const runAssetBlock = (assetsJson) => execFileAsync('bash', ['-c', `set -euo pipefail\n${assetBlock}`], {
    env: { ...process.env, PATH: `${assetBin}:${process.env.PATH ?? ''}`, GH_ASSETS_JSON: assetsJson, ASSET_GH_LOG: assetLog, GH_LOG: assetLog, GH_TOKEN: 'offline-test-token', REPOSITORY: 'elsoul/erpc-sdk', TAG: 'non-rust-v0.9.1', ASSET_DIR: assetDirectory, RUNNER_TEMP: assetDownloadDirectory },
  })
  await runAssetBlock(JSON.stringify([{ name: 'approved.txt' }]))
  const assetCalls = (await readFile(assetLog, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(assetCalls.filter(arguments_ => arguments_[0] === 'release' && arguments_[1] === 'download').length, 2)
  await assert.rejects(runAssetBlock(JSON.stringify([{ name: 'approved.txt' }, { name: 'unexpected.txt' }])), /unexpected existing Release asset/)
  await writeFile(join(assetDirectory, 'missing.txt'), 'missing bytes')
  await writeFile(join(assetDirectory, 'approved.txt'), 'conflicting local bytes')
  await writeFile(assetLog, '')
  await assert.rejects(runAssetBlock(JSON.stringify([{ name: 'approved.txt' }])))
  const conflictCalls = (await readFile(assetLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  assert.equal(conflictCalls.filter(arguments_ => arguments_[0] === 'release' && arguments_[1] === 'upload').length, 0)
})

test('actual npm Fulcio claim decoder accepts legacy raw issuer OIDs and rejects issuer/source mismatches', async t => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const pythonCode = extractWorkflowHeredoc(workflow, 'python - "$RUNNER_TEMP/npm-audit.json" "$RUNNER_TEMP/npm-certificate-claims.json" <<\'PY\'', 'PY')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-npm-cert-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pythonPath = join(directory, 'claims.py')
  await writeFile(pythonPath, pythonCode)
  let python = 'python3'
  try {
    await execFileAsync(python, ['-c', 'import cryptography'])
  } catch {
    const venv = join(directory, 'venv')
    await execFileAsync('python3', ['-m', 'venv', venv])
    python = join(venv, 'bin', 'python')
    await execFileAsync(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'pypi-attestations==0.0.30'])
  }
  const makeCertificate = async (issuer, source) => {
    const config = join(directory, `cert-${issuer.includes('evil') ? 'wrong-issuer' : source === sha ? 'valid' : 'wrong-source'}.cnf`)
    const key = `${config}.key`
    const cert = `${config}.der`
    const rawIssuer = Buffer.from(issuer).toString('hex')
    await writeFile(config, `[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = claims\n[dn]\nCN = Fulcio fixture\n[claims]\n1.3.6.1.4.1.57264.1.1 = DER:${rawIssuer}\n1.3.6.1.4.1.57264.1.9 = ASN1:UTF8String:https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main\n1.3.6.1.4.1.57264.1.10 = ASN1:UTF8String:${source}\n1.3.6.1.4.1.57264.1.12 = ASN1:UTF8String:https://github.com/elsoul/erpc-sdk\n1.3.6.1.4.1.57264.1.13 = ASN1:UTF8String:${source}\n1.3.6.1.4.1.57264.1.14 = ASN1:UTF8String:refs/heads/main\n1.3.6.1.4.1.57264.1.15 = ASN1:UTF8String:1429568627\n1.3.6.1.4.1.57264.1.18 = ASN1:UTF8String:https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main\n1.3.6.1.4.1.57264.1.19 = ASN1:UTF8String:${source}\n1.3.6.1.4.1.57264.1.20 = ASN1:UTF8String:workflow_dispatch\n`)
    await execFileAsync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-outform', 'DER', '-days', '1', '-config', config], { maxBuffer: 1024 * 1024 })
    return (await readFile(cert)).toString('base64')
  }
  const auditFile = join(directory, 'npm-audit.json')
  const claimsFile = join(directory, 'claims.json')
  const run = async (certificate, registry = 'https://registry.npmjs.org/') => {
    await writeFile(auditFile, JSON.stringify({ invalid: [], missing: [], verified: [{ name: '@elsoul/erpc-sdk', version: FOUNDATION_VERSION, registry, attestationBundles: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { verificationMaterial: { certificate: { rawBytes: certificate } } } }] }] }))
    return execFileAsync(python, [pythonPath, auditFile, claimsFile], { env: { ...process.env, EXPECTED_VERSION: FOUNDATION_VERSION, FOUNDATION_SOURCE_SHA: sha, EXPECTED_REPOSITORY_ID: '1429568627' } })
  }
  const validCertificate = await makeCertificate('https://token.actions.githubusercontent.com', sha)
  await run(validCertificate)
  await assert.rejects(run(validCertificate, 'https://registry.npmjs.org.evil/'))
  await assert.rejects(run(await makeCertificate('https://evil.invalid', sha)))
  await assert.rejects(run(await makeCertificate('https://token.actions.githubusercontent.com', 'c'.repeat(40))))
})

test('actual bounded CI proof step parses and fails closed on stale, pending, duplicate, and truncated evidence', async t => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const block = extractWorkflowRunBlock(workflow, 'Verify bounded CI proof for this immutable release')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-ci-proof-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const blockFile = join(directory, 'ci-proof.sh')
  await writeFile(blockFile, block)
  await execFileAsync('bash', ['-n', blockFile])
  const gh = join(directory, 'gh')
  await writeFile(gh, `#!/usr/bin/env node
const args = process.argv.slice(2)
const endpoint = args[1] || ''
const sha = process.env.FOUNDATION_SOURCE_SHA
const workflow = { id: 77, path: '.github/workflows/ci.yml', url: 'https://api.github.com/repos/elsoul/erpc-sdk/actions/workflows/77' }
const oldRun = { id: 100, run_attempt: 1, workflow_id: 77, path: '.github/workflows/ci.yml', repository: { full_name: 'elsoul/erpc-sdk', id: 1429568627 }, head_repository: { full_name: 'elsoul/erpc-sdk', id: 1429568627 }, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-10-22T00:00:00Z' }
const latestRun = { id: 101, run_attempt: 1, workflow_id: 77, path: '.github/workflows/ci.yml', repository: { full_name: 'elsoul/erpc-sdk', id: 1429568627 }, head_repository: { full_name: 'elsoul/erpc-sdk', id: 1429568627 }, head_sha: sha, head_branch: 'main', event: 'push', status: process.env.CI_CASE === 'pending' ? 'in_progress' : 'completed', conclusion: process.env.CI_CASE === 'pending' ? null : 'success', created_at: '2026-10-22T00:01:00Z' }
if (endpoint.endsWith('/actions/workflows/ci.yml')) process.stdout.write(JSON.stringify(workflow))
else if (endpoint.includes('/actions/workflows/77/runs')) process.stdout.write(JSON.stringify(process.env.CI_CASE === 'truncated' ? { total_count: 101, workflow_runs: [latestRun] } : process.env.CI_CASE === 'short' ? { total_count: 2, workflow_runs: [latestRun] } : process.env.CI_CASE === 'duplicate-run' ? { total_count: 2, workflow_runs: [latestRun, { ...latestRun, status: 'completed', conclusion: 'failure' }] } : { total_count: 2, workflow_runs: [oldRun, latestRun] }))
else if (endpoint.includes('/attempts/1/jobs')) {
  const job = { id: 200, name: 'required-ci', status: 'completed', conclusion: process.env.CI_CASE === 'job-failure' ? 'failure' : 'success', run_id: 101, run_attempt: 1, head_sha: sha, repository_id: 1429568627 }
  process.stdout.write(JSON.stringify({ total_count: process.env.CI_CASE === 'duplicate' ? 2 : 1, jobs: process.env.CI_CASE === 'duplicate' ? [job, { ...job, id: 201 }] : [job] }))
} else if (endpoint.endsWith('/actions/runs/101')) process.stdout.write(JSON.stringify(latestRun))
else process.exit(97)
`)
  await chmod(gh, 0o755)
  const runCase = (caseName = 'success') => execFileAsync('bash', ['-c', `set -euo pipefail\n${block}`], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      GH_TOKEN: 'offline-token',
      EXPECTED_REPOSITORY: 'elsoul/erpc-sdk',
      FOUNDATION_SOURCE_SHA: sha,
      CI_WORKFLOW_FILE: join(directory, 'workflow.json'),
      CI_RUNS_FILE: join(directory, 'runs.json'),
      CI_SELECTION_FILE: join(directory, 'selection.json'),
      CI_RECHECK_FILE: join(directory, 'recheck.json'),
      CI_JOBS_FILE: join(directory, 'jobs.json'),
      CI_EVIDENCE_FILE: join(directory, 'evidence.json'),
      CI_CASE: caseName,
    },
  })
  await runCase()
  assert.equal(JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')).requiredJobName, 'required-ci')
  for (const caseName of ['pending', 'duplicate', 'job-failure', 'truncated', 'short', 'duplicate-run']) await assert.rejects(runCase(caseName))
})

test('actual Go proof block rejects wrong module, origin, subdirectory, sums, and zip members', async t => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const block = extractWorkflowRunBlock(workflow, 'Verify Go proxy, checksum, origin, and exact module members')
  assert.match(block, /GOMODCACHE=\"\$RUNNER_TEMP\/go-mod-cache\"/)
  assert.match(block, /GOPROXY=direct GOSUMDB=\"\$GOSUMDB\"/)
  assert.doesNotMatch(block, /GOSUMDB=off/)
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-go-proof-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bundle = join(directory, 'sdk-foundation-bundle')
  await mkdir(bundle)
  const module = 'github.com/elsoul/erpc-sdk/packages/go'
  const version = 'v0.9.1'
  const commit = sha
  const sourceFiles = {
    'go.mod': `module ${module}\n\ngo 1.22\n`,
    'LICENSE': 'MIT\n',
    'rpc.go': 'package erpc\n',
  }
  const inventoryFiles = Object.entries(sourceFiles).map(([path, contents]) => ({ path, sha256: sha256Hex(contents) }))
  const inventory = { files: inventoryFiles, inventorySha256: sha256Hex(canonicalJson(inventoryFiles)) }
  await writeFile(join(bundle, 'go-inventory.json'), JSON.stringify(inventory))
  const zipPath = join(directory, 'module.zip')
  const zipScript = `import sys, zipfile\nzip_path, prefix = sys.argv[1:]\nfiles = {'go.mod': ${JSON.stringify(sourceFiles['go.mod'])}, 'LICENSE': ${JSON.stringify(sourceFiles.LICENSE)}, 'rpc.go': ${JSON.stringify(sourceFiles['rpc.go'])}}\nwith zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:\n    for name, contents in files.items(): archive.writestr(prefix + name, contents)`
  await execFileAsync('python3', ['-c', zipScript, zipPath, `${module}@${version}/`])
  const infoPath = join(directory, 'module.info')
  const goModPath = join(directory, 'module.mod')
  const moduleDirectory = join(directory, 'module-dir')
  await mkdir(moduleDirectory)
  await writeFile(infoPath, '{}')
  await writeFile(goModPath, sourceFiles['go.mod'])
  const goSum = `h1-${Buffer.from('a'.repeat(32)).toString('base64')}`.replace('-', ':')
  const result = {
    Path: module,
    Version: version,
    Info: infoPath,
    GoMod: goModPath,
    Zip: zipPath,
    Dir: moduleDirectory,
    Sum: goSum,
    GoModSum: goSum,
    Origin: { VCS: 'git', URL: 'https://github.com/elsoul/erpc-sdk', Hash: commit, Ref: 'refs/tags/packages/go/v0.9.1', Subdir: 'packages/go' },
    Reuse: false,
  }
  const goStub = join(directory, 'go')
  await writeFile(goStub, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'mod' && args[1] === 'download') process.stdout.write(process.env.GO_RESULT)
else if (args[0] === 'run') process.exit(0)
else process.exit(98)
`)
  await chmod(goStub, 0o755)
  const gitStub = join(directory, 'git')
  await writeFile(gitStub, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'fetch') process.exit(0)
if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') process.stdout.write(process.env.EXPECTED_COMMIT + '\\n')
else process.exit(98)
`)
  await chmod(gitStub, 0o755)
  const pythonStub = join(directory, 'python')
  await writeFile(pythonStub, '#!/bin/sh\nexec python3 "$@"\n')
  await chmod(pythonStub, 0o755)
  const runBlock = (receipt = result) => execFileAsync('bash', ['-c', `set -euo pipefail\n${block}`], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: directory,
      GOPROXY: 'https://proxy.golang.org',
      GOSUMDB: 'sum.golang.org',
      MODULE: module,
      VERSION: version,
      EXPECTED_COMMIT: commit,
      EXPECTED_REPOSITORY: 'elsoul/erpc-sdk',
      FOUNDATION_SOURCE_SHA: commit,
      FOUNDATION_PLAN_SHA256: 'd'.repeat(64),
      FOUNDATION_PREPARED_RUN_ID: '12345',
      FOUNDATION_PREPARED_RUN_ATTEMPT: '2',
      FOUNDATION_PREPARED_ARTIFACT_ID: '45678',
      GITHUB_RUN_ID: '54321',
      GITHUB_RUN_ATTEMPT: '1',
      GO_RESULT: JSON.stringify(receipt),
    },
  })
  await runBlock()
  assert.equal(JSON.parse(await readFile(join(directory, 'go-proof.json'), 'utf8')).originSubdir, 'packages/go')
  for (const receipt of [
    { ...result, Path: 'github.com/example-owner/other/packages/go' },
    { ...result, Version: 'v0.9.0' },
    { ...result, Origin: { ...result.Origin, URL: 'https://example.invalid/other' } },
    { ...result, Origin: { ...result.Origin, Subdir: 'packages/python' } },
    { ...result, Sum: 'h1:not-a-valid-go-checksum' },
  ]) {
    await assert.rejects(runBlock(receipt))
  }
})

test('actual Ruby artifact inspection requires Gem::Package metadata, matching data files, and LICENSE', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-gem-artifact-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const npmRoot = join(directory, 'npm-root')
  const sdistRoot = join(directory, 'sdist-root')
  const gemRoot = join(directory, 'gem-root')
  await mkdir(join(npmRoot, 'package', 'dist'), { recursive: true })
  await mkdir(join(sdistRoot, 'erpc_sdk-0.9.1'), { recursive: true })
  await mkdir(join(gemRoot, 'lib', 'erpc_sdk'), { recursive: true })
  await writeFile(join(npmRoot, 'package', 'package.json'), JSON.stringify({ name: '@elsoul/erpc-sdk', version: FOUNDATION_VERSION }))
  await writeFile(join(npmRoot, 'package', 'LICENSE'), 'MIT\n')
  await writeFile(join(npmRoot, 'package', 'README.md'), '# SDK\n')
  await writeFile(join(npmRoot, 'package', 'dist', 'index.js'), 'export {}\n')
  await writeFile(join(sdistRoot, 'erpc_sdk-0.9.1', 'PKG-INFO'), 'Name: erpc-sdk\nVersion: 0.9.1\n')
  await writeFile(join(sdistRoot, 'erpc_sdk-0.9.1', 'LICENSE'), 'MIT\n')
  await writeFile(join(sdistRoot, 'erpc_sdk-0.9.1', 'erpc_sdk.py'), '__version__ = "0.9.1"\n')
  await writeFile(join(gemRoot, 'lib', 'erpc_sdk.rb'), 'module ERPC; VERSION = "0.9.1"; end\n')
  await writeFile(join(gemRoot, 'LICENSE'), 'MIT\n')
  await writeFile(join(gemRoot, 'README.md'), '# SDK\n')
  await writeFile(join(gemRoot, 'erpc-sdk.gemspec'), `Gem::Specification.new do |spec|
  spec.name = 'erpc-sdk'
  spec.version = '0.9.1'
  spec.summary = 'test fixture'
  spec.authors = ['fixture']
  spec.files = Dir['lib/**/*.rb'].sort + %w[LICENSE README.md]
  spec.require_paths = ['lib']
  spec.license = 'MIT'
end
`)
  await execFileAsync('tar', ['-czf', join(directory, 'elsoul-erpc-sdk-0.9.1.tgz'), '-C', npmRoot, 'package'])
  await execFileAsync('tar', ['-czf', join(directory, 'erpc_sdk-0.9.1.tar.gz'), '-C', sdistRoot, 'erpc_sdk-0.9.1'])
  const wheelScript = `import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:\n    archive.writestr('erpc_sdk/__init__.py', '')\n    archive.writestr('erpc_sdk-0.9.1.dist-info/METADATA', 'Name: erpc-sdk\\nVersion: 0.9.1\\n')\n    archive.writestr('erpc_sdk-0.9.1.dist-info/LICENSE', 'MIT\\n')`
  await execFileAsync('python3', ['-c', wheelScript, join(directory, 'erpc_sdk-0.9.1-py3-none-any.whl')])
  await execFileAsync('gem', ['build', 'erpc-sdk.gemspec'], { cwd: gemRoot })
  await cp(join(gemRoot, 'erpc-sdk-0.9.1.gem'), join(directory, 'erpc-sdk-0.9.1.gem'))
  const descriptors = await describeFoundationArtifacts(directory)
  const gemDescriptor = descriptors.find(descriptor => descriptor.kind === 'rubygems')
  assert.equal(gemDescriptor.name, 'erpc-sdk')
  assert.ok(gemDescriptor.files.includes('LICENSE'))

  await symlink('LICENSE', join(npmRoot, 'package', 'link'))
  await rm(join(directory, 'elsoul-erpc-sdk-0.9.1.tgz'))
  await execFileAsync('tar', ['-czf', join(directory, 'elsoul-erpc-sdk-0.9.1.tgz'), '-C', npmRoot, 'package'])
  await assert.rejects(() => describeFoundationArtifacts(directory), /non-regular member/)
  await rm(join(npmRoot, 'package', 'link'))
  await rm(join(directory, 'elsoul-erpc-sdk-0.9.1.tgz'))
  await execFileAsync('tar', ['-czf', join(directory, 'elsoul-erpc-sdk-0.9.1.tgz'), '-C', npmRoot, 'package'])

  const fakeRoot = join(directory, 'fake-gem-root')
  await mkdir(fakeRoot)
  await writeFile(join(fakeRoot, 'LICENSE'), 'MIT\n')
  await rm(join(directory, 'erpc-sdk-0.9.1.gem'))
  await execFileAsync('tar', ['-czf', join(directory, 'erpc-sdk-0.9.1.gem'), '-C', fakeRoot, 'LICENSE'])
  await assert.rejects(() => describeFoundationArtifacts(directory))
})

test('actual foundation Rust reuse block rejects metadata 404 before any reuse proof', async t => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const block = extractWorkflowRunBlock(workflow, 'Verify Rust registry/download receipt without OIDC')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-rust-reuse-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const curlStub = join(directory, 'curl')
  await writeFile(curlStub, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output')
const status = Number(process.env.CURL_STATUS)
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], args.includes('--write-out') ? (process.env.CURL_BODY || '') : 'crate bytes')
if (args.includes('--write-out')) process.stdout.write(String(status))
if (args.includes('--fail') && status >= 400) process.exit(22)
`)
  await chmod(curlStub, 0o755)
  const shaStub = join(directory, 'sha256sum')
  await writeFile(shaStub, `#!/bin/sh
printf '%s  %s\\n' "$EXPECTED_SHA256" "$2"
`)
  await chmod(shaStub, 0o755)
  const registryBody = JSON.stringify({ version: { crate: 'erpc-sdk', num: '0.10.0', checksum: FOUNDATION_RUST_SHA256, yanked: false } })
  const runBlock = (status, body = registryBody) => execFileAsync('bash', ['-c', `set -euo pipefail\n${block}`], {
    cwd: new URL('../', import.meta.url).pathname,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      RELEASE_USER_AGENT,
      EXPECTED_SHA256: FOUNDATION_RUST_SHA256,
      CURL_STATUS: String(status),
      CURL_BODY: body,
      RUNNER_TEMP: directory,
    },
  })
  await assert.rejects(runBlock(404), /Rust reuse registry check stopped in absent state/)
  assert.doesNotMatch(block, /verified:true/)
})

test('actual workflow crates.io curl invocations require the fixed UA and preserve 403/404 states', async t => {
  const workflow = await readFile(new URL('../.github/workflows/release-rust.yml', import.meta.url), 'utf8')
  const invocations = extractWorkflowCurlInvocations(workflow)
  assert.equal(invocations.length, 3)
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'erpc-sdk-curl-ua-'))
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }))
  const capturePath = join(fixtureDirectory, 'curl-argv.jsonl')
  const curlPath = join(fixtureDirectory, 'curl')
  const responsePath = join(fixtureDirectory, 'response.json')
  const downloadPath = join(fixtureDirectory, 'download.crate')
  await writeFile(capturePath, '')
  await writeFile(
    curlPath,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CURL_CAPTURE, JSON.stringify(args) + '\\n')
const userAgentIndex = args.indexOf('--user-agent')
if (userAgentIndex < 0 || args[userAgentIndex + 1] !== ${JSON.stringify(RELEASE_USER_AGENT)}) {
  process.exit(97)
}
const outputIndex = args.indexOf('--output')
if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], process.env.CURL_BODY ?? '')
const status = Number(process.env.CURL_STATUS ?? '200')
const writeOutIndex = args.indexOf('--write-out')
if (writeOutIndex >= 0 && args[writeOutIndex + 1] === '%{http_code}') {
  process.stdout.write(String(status))
}
if (args.includes('--fail') && status >= 400) process.exit(22)
`,
  )
  await chmod(curlPath, 0o755)
  const responseBody = JSON.stringify({
    version: { crate: 'erpc-sdk', num: '0.10.0', checksum: hash, yanked: false },
  })
  const runCurl = (invocation, status) => execFileAsync(
    'bash',
    [
      '-c',
      `set -euo pipefail\n${invocation}${invocation.startsWith('HTTP_STATUS=') ? '\nprintf \'%s\\n\' "$HTTP_STATUS"' : ''}`,
    ],
    {
      env: {
        ...process.env,
        PATH: `${fixtureDirectory}:${process.env.PATH ?? ''}`,
        CURL_CAPTURE: capturePath,
        CURL_BODY: responseBody,
        CURL_STATUS: String(status),
        EXPECTED_VERSION: '0.10.0',
        RESPONSE_FILE: responsePath,
        DOWNLOAD_PATH: downloadPath,
      },
    },
  )

  const forbidden = await runCurl(invocations[0], 403)
  assert.equal(forbidden.stdout.trim(), '403')
  assert.equal(
    classifyRegistryResponse({
      status: Number(forbidden.stdout.trim()),
      body: '',
      expectedVersion: '0.10.0',
      expectedChecksum: hash,
    }).state,
    'http-error',
  )
  const absent = await runCurl(invocations[0], 404)
  assert.equal(absent.stdout.trim(), '404')
  assert.equal(
    classifyRegistryResponse({
      status: Number(absent.stdout.trim()),
      body: '',
      expectedVersion: '0.10.0',
      expectedChecksum: hash,
    }).state,
    'absent',
  )
  await runCurl(invocations[1], 200)
  await runCurl(invocations[2], 200)
  const capturedArguments = (await readFile(capturePath, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line))
  assert.equal(capturedArguments.length, 4)
  for (const arguments_ of capturedArguments) {
    const userAgentIndex = arguments_.indexOf('--user-agent')
    assert.equal(arguments_[userAgentIndex + 1], RELEASE_USER_AGENT)
  }
  assert.ok(capturedArguments.at(-1).some(argument => argument.endsWith('/download')))
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
  assert.equal((workflow.match(/node scripts\/verify-release\.mjs --select-archive/g) ?? []).length, 2)
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

test('recovery workflow is manual, M-bound, read-only for registries, and keeps the fifteen-asset boundary', async () => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const originalWorkflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const originalVerifier = await readFile(new URL('./verify-release.mjs', import.meta.url), 'utf8')
  const expectedWorkflow = (await execFileAsync('git', ['show', 'HEAD:.github/workflows/release.yml'])).stdout
  const expectedVerifier = (await execFileAsync('git', ['show', 'HEAD:scripts/verify-release.mjs'])).stdout
  assert.equal(originalWorkflow, expectedWorkflow)
  assert.equal(originalVerifier, expectedVerifier)
  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /^\s+(schedule|push|pull_request|pull_request_target|workflow_call|release):/m)
  assert.match(workflow, /expected_control_commit:/)
  assert.match(workflow, /cancel-in-progress:\s*false/)
  assert.match(workflow, /permissions:\n\s+contents: read/)
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}[\s\S]*CONTROL_COMMIT: \$\{\{ steps\.guard\.outputs\.control_commit \}\}/)
  assert.match(workflow, /Recheck main remains C at the read-before-write boundary[\s\S]*CONTROL_COMMIT: \$\{\{ steps\.guard\.outputs\.control_commit \}\}/)
  assert.doesNotMatch(workflow, /id-token:\s*write/)
  assert.doesNotMatch(workflow, /npm\s+publish|npm\s+dist-tag|twine\s+upload|gem\s+push|pypa\/gh-action-pypi-publish|configure-rubygems-credentials/)
  assert.doesNotMatch(workflow, /--local(?:\s|$)/m)
  assert.match(workflow, /SOURCE_M:\s*4677d67d14c8fbb17ada3ba824d1623180c6b4d9/)
  assert.match(workflow, /PUBLISH_RUN_ID:\s*'39871872971'/)
  assert.match(workflow, /PREPARED_ARTIFACT_ID:\s*'12461868771'/)
  assert.match(workflow, /PREPARED_BINDING_ARTIFACT_ID:\s*'12463070497'/)
  assert.match(workflow, /foundation-recovery-context-\$\{\{ github\.run_id \}\}/)
  assert.match(workflow, /gem install [^\n]*--both[^\n]*--clear-sources --source https:\/\/rubygems\.org\//)
  assert.match(workflow, /npm audit signatures --json --include-attestations/)
  assert.match(workflow, /pypi_attestations import Distribution, GitHubPublisher, Provenance/)
  assert.match(workflow, /test "\$\(find "\$ASSET_DIR" -maxdepth 1 -type f \| wc -l \| tr -d ' '\)" = 15/)
  const aggregateStep = workflow.slice(workflow.indexOf('- name: Verify current receipt/context artifact metadata and both Ruby consumers'), workflow.indexOf('\n      - name:', workflow.indexOf('- name: Verify current receipt/context artifact metadata and both Ruby consumers') + 1))
  assert.match(aggregateStep, /FOUNDATION_PLAN_FILE:/)
  assert.match(aggregateStep, /--foundation-verify/)
  assert.match(aggregateStep, /--foundation-proof-verify/)
  assert.match(workflow, /compare_consumed \"foundation-ruby-consumer-\$GITHUB_RUN_ID-3\.1\"/)
})

test('recovery control guard executes valid C/M fixtures and rejects event and projection changes', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const block = extractWorkflowRunBlock(workflow, 'Guard repository, event, control C, source M, and exact projection')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-guard-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const runGit = arguments_ => execFileAsync('git', arguments_, { cwd: directory })
  await runGit(['init', '-q'])
  await runGit(['config', 'user.email', 'fixture@example.invalid'])
  await runGit(['config', 'user.name', 'fixture'])
  await mkdir(join(directory, '.github', 'workflows'), { recursive: true })
  await mkdir(join(directory, 'scripts'), { recursive: true })
  await mkdir(join(directory, 'docs'), { recursive: true })
  await writeFile(join(directory, '.github/workflows/release.yml'), 'immutable release\n')
  await writeFile(join(directory, 'scripts/verify-release.mjs'), 'immutable verifier\n')
  await writeFile(join(directory, 'scripts/verify-release.test.mjs'), 'old test\n')
  await writeFile(join(directory, 'docs/RELEASING.md'), 'old docs\n')
  const gh = join(directory, 'gh')
  await writeFile(gh, '#!/usr/bin/env node\n' +
    'const args = process.argv.slice(2)\n' +
    'if (args.includes("--jq")) process.stdout.write(process.env.CONTROL_COMMIT + "\\n")\n' +
    'else process.stdout.write(JSON.stringify({ object: { sha: process.env.CONTROL_COMMIT } }))\n')
  await chmod(gh, 0o755)
  await runGit(['add', '.'])
  await runGit(['commit', '-qm', 'M fixture'])
  const sourceCommit = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
  await writeFile(join(directory, '.github/workflows/reconcile-foundation.yml'), 'recovery workflow\n')
  await writeFile(join(directory, 'scripts/verify-release.test.mjs'), 'new test\n')
  await writeFile(join(directory, 'docs/RELEASING.md'), 'new docs\n')
  await runGit(['add', '.'])
  await runGit(['commit', '-qm', 'C fixture'])
  const controlCommit = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
  const outputFile = join(directory, 'output')
  const runGuard = (overrides = {}) => execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: directory + ':' + (process.env.PATH ?? ''),
      CONTROL_COMMIT: controlCommit,
      EVENT_SHA: controlCommit,
      WORKFLOW_SHA: controlCommit,
      WORKFLOW_REF: 'elsoul/erpc-sdk/.github/workflows/reconcile-foundation.yml@refs/heads/main',
      EVENT_NAME: 'workflow_dispatch',
      EVENT_REF: 'refs/heads/main',
      REPOSITORY: 'elsoul/erpc-sdk',
      REPOSITORY_ID: '1429568627',
      EXPECTED_REPOSITORY: 'elsoul/erpc-sdk',
      EXPECTED_REPOSITORY_ID: '1429568627',
      SOURCE_M: sourceCommit,
      GITHUB_OUTPUT: outputFile,
      ...overrides,
    },
  })
  await runGuard()
  assert.match(await readFile(outputFile, 'utf8'), new RegExp('control_commit=' + controlCommit))
  await assert.rejects(runGuard({ EVENT_NAME: 'push' }))
  await writeFile(join(directory, 'packages-extra.txt'), 'unapproved path\n')
  await runGit(['add', 'packages-extra.txt'])
  await runGit(['commit', '-qm', 'unapproved projection'])
  const hostileCommit = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
  await assert.rejects(runGuard({ CONTROL_COMMIT: hostileCommit, EVENT_SHA: hostileCommit, WORKFLOW_SHA: hostileCommit }))
})

test('recovery Ruby consumer block executes the isolated dependency path and fails on install errors', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const block = extractWorkflowRunBlock(workflow, 'Run the exact gem with declared dependencies from only RubyGems.org')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-ruby-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const gemFile = join(directory, 'erpc-sdk-0.9.1.gem')
  await writeFile(gemFile, 'approved gem fixture\n')
  const gemArgs = join(directory, 'gem-args')
  const gem = join(directory, 'gem')
  await writeFile(gem, '#!/bin/sh\n' +
    'printf "%s\\n" "$@" > "$GEM_ARGS"\n' +
    'if [ "$GEM_FAIL" = 1 ]; then exit 23; fi\n')
  await chmod(gem, 0o755)
  const ruby = join(directory, 'ruby')
  await writeFile(ruby, '#!/bin/sh\n' +
    'cat > "$RUBY_STDIN"\n' +
    'if [ "$RUBY_FAIL" = 1 ]; then exit 24; fi\n')
  await chmod(ruby, 0o755)
  const proof = join(directory, 'rubygems-proof.json')
  const baseEnvironment = {
    ...process.env,
    PATH: directory + ':' + (process.env.PATH ?? ''),
    RUNNER_TEMP: directory,
    GEM_FILE: gemFile,
    GEM_SHA256: '9af4312d655206e3f71481a2414382095cf8857fd481fed878503577b2a946d2',
    RUBY_VERSION_UNDER_TEST: '3.4',
    GEM_ARGS: gemArgs,
    RUBY_STDIN: join(directory, 'ruby-stdin'),
    RUBY_EVIDENCE_FILE: join(directory, 'ruby-consumer-3.4.json'),
    EXPECTED_REPOSITORY: 'elsoul/erpc-sdk',
    SOURCE_M: '4677d67d14c8fbb17ada3ba824d1623180c6b4d9',
    PLAN_SHA256: '779aa1c48dc9ba2178fcfe021e102a12df85e4098c66120b1a3d2e8d7ca1911c',
    PREPARED_RUN_ID: '39862319930',
    PREPARED_RUN_ATTEMPT: '1',
    PREPARED_ARTIFACT_ID: '12461868771',
    GITHUB_RUN_ID: '777777',
    GITHUB_RUN_ATTEMPT: '1',
  }
  for (const key of ['GEM_HOST_API_KEY', 'BUNDLE_GEM__PUSH_KEY', 'RUBYGEMS_API_KEY', 'RUBYGEMS_GEMDEPS', 'BUNDLER_ORIG_BUNDLE_BIN_PATH', 'BUNDLER_ORIG_BUNDLE_GEMFILE', 'BUNDLER_ORIG_BUNDLE_PATH', 'BUNDLER_ORIG_BUNDLE_WITH', 'BUNDLER_ORIG_BUNDLE_WITHOUT', 'BUNDLER_ORIG_RUBYOPT', 'BUNDLER_ORIG_RUBYLIB', 'BUNDLE_GEMFILE', 'BUNDLE_PATH', 'BUNDLE_WITH', 'BUNDLE_WITHOUT', 'RUBYOPT', 'RUBYLIB']) delete baseEnvironment[key]
  const runConsumer = (overrides = {}) => execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], {
    cwd: directory,
    env: { ...baseEnvironment, ...overrides },
  })
  await runConsumer()
  const arguments_ = (await readFile(gemArgs, 'utf8')).trim().split(/\r?\n/)
  assert.ok(arguments_.includes(gemFile))
  assert.ok(arguments_.includes('--both'))
  assert.ok(arguments_.includes('--clear-sources'))
  assert.ok(arguments_.includes('--source'))
  assert.ok(arguments_.includes('https://rubygems.org/'))
  assert.equal(arguments_.includes('--local'), false)
  assert.equal(arguments_.includes('--ignore-dependencies'), false)
  const receipt = JSON.parse(await readFile(proof, 'utf8'))
  assert.equal(receipt.state, 'reused')
  assert.deepEqual(receipt.auth, { requested: false, uploadAttempted: false, credentialObserved: false })
  await rm(proof, { force: true })
  await assert.rejects(runConsumer({ GEM_FAIL: '1' }))
  await assert.rejects(runConsumer({ RUBY_FAIL: '1' }))
  await assert.rejects(runConsumer({ RUBYGEMS_GEMDEPS: join(directory, 'Gemfile') }))
})
