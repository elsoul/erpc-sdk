import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  FOUNDATION_GO_TAG,
  FOUNDATION_RELEASE_TITLE,
  FOUNDATION_RUST_SHA256,
  FOUNDATION_RUST_SOURCE,
  FOUNDATION_TAG,
  FOUNDATION_VERSION,
  RELEASE_SET_ARTIFACT_KINDS,
  RELEASE_SET_KIND,
  RELEASE_SET_PUBLIC_ASSET_ROLES,
  RELEASE_SET_SCHEMA_VERSION,
  buildReleaseSetPlan,
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
  ingestReleaseSetBundle,
  inspectReleaseSetArtifactBytes,
  inspectReleaseSetRubyGemBytes,
  inspectReleaseSetRustArchiveBytes,
  observeNpmRelease,
  observePyPIRelease,
  parseReleaseSetChecksums,
  releaseSetPlanDigest,
  sha256File,
  validateReleaseSetContext,
  validateReleaseSetPlan,
  validateReleaseSetPreparationBinding,
  validateReleaseSetPreparationMetadata,
  selectFoundationCIRun,
  validateFoundationCIProof,
  validateWorkflowContext,
  verifyArchiveContents,
  verifyFoundationBundle,
  verifyFoundationProofSet,
  verifyReleaseSetArtifactZip,
  verifyReleaseSetPreparation,
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

const extractWorkflowFragment = (workflow, stepName, startMarker, endMarker) => {
  const block = extractWorkflowRunBlock(workflow, stepName)
  const start = block.indexOf(startMarker)
  assert.notEqual(start, -1, `missing workflow fragment start ${startMarker}`)
  const end = endMarker === undefined ? block.length : block.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing workflow fragment end ${endMarker}`)
  return block.slice(start, end)
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
  // The current Rust candidate deliberately remains release-invalid until P2b
  // promotes its mixed-source licence/archive controls.
  assert.throws(() => validateReleaseData(data, { scope: 'rust', expectedVersion: '0.10.0' }), /Unexpected Rust crate license/)
  const nonRustVersions = [data.packageJson.version, data.pythonVersion, data.pythonRuntimeVersion, data.rubyVersion, data.rubyLockVersion]
  if (new Set(nonRustVersions).size === 1) assert.equal(validateReleaseData(data, { scope: 'non-rust' }).version, data.packageJson.version)
  else assert.throws(() => validateReleaseData(data, { scope: 'non-rust' }), /Non-Rust package versions differ/)
  assert.throws(
    () => validateReleaseData(data, { scope: 'all' }),
    /Package versions differ|Non-Rust package versions differ|Unexpected Rust crate license/,
  )
})

test('Rust verification binds the unique source-free local lock entry and MSRV', async () => {
  const data = await readReleaseData(root.pathname)
  assert.equal(findLocalCargoPackage(data.cargoLock).version, '0.10.0')
  assert.throws(
    () => findLocalCargoPackage('[[package]]\nname = "erpc-sdk"\nversion = "0.10.0"\n\n[[package]]\nname = "erpc-sdk"\nversion = "0.10.0"\n'),
    /exactly one source-free erpc-sdk/,
  )
  const historicalLicenseData = { ...data, cargoManifest: data.cargoManifest.replace('license = "MIT AND Apache-2.0"', 'license = "MIT"') }
  assert.throws(
    () => validateReleaseData({ ...historicalLicenseData, cargoManifest: historicalLicenseData.cargoManifest.replace('rust-version = "1.85"', 'rust-version = "1.86"') }, { scope: 'rust' }),
    /Unexpected Rust MSRV/,
  )
  assert.throws(
    () => validateReleaseData({ ...historicalLicenseData, cargoLockPackage: { version: '0.9.0' } }, { scope: 'rust' }),
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

test('checkpoint A ingests genuine future archives, binds context/API metadata, and rejects plan-only evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-release-set-a-'))
  const bundle = join(directory, 'bundle')
  const sourceCommit = 'c'.repeat(40)
  const version = '0.11.0'
  await mkdir(bundle)
  t.after(() => rm(directory, { recursive: true, force: true }))

  const npmRoot = join(directory, 'npm-root')
  await mkdir(join(npmRoot, 'package', 'dist'), { recursive: true })
  await writeFile(join(npmRoot, 'package', 'package.json'), JSON.stringify({ name: '@elsoul/erpc-sdk', version }))
  await writeFile(join(npmRoot, 'package', 'LICENSE'), 'MIT\n')
  await writeFile(join(npmRoot, 'package', 'README.md'), '# SDK\n')
  await writeFile(join(npmRoot, 'package', 'dist', 'index.js'), 'module.exports = {}\n')
  const npmFile = join(bundle, `elsoul-erpc-sdk-${version}.tgz`)
  await execFileAsync('tar', ['-czf', npmFile, '-C', npmRoot, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

  const wheelFile = join(bundle, `erpc_sdk-${version}-py3-none-any.whl`)
  await execFileAsync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("erpc_sdk/__init__.py", "__version__ = \\\"0.11.0\\\"\\n"); z.writestr("erpc_sdk-0.11.0.dist-info/METADATA", "Name: erpc-sdk\\nVersion: 0.11.0\\n"); z.writestr("erpc_sdk-0.11.0.dist-info/LICENSE", "MIT\\n"); z.close()', wheelFile])

  const sdistRoot = join(directory, 'sdist-root', `erpc_sdk-${version}`)
  await mkdir(sdistRoot, { recursive: true })
  await writeFile(join(sdistRoot, 'PKG-INFO'), `Name: erpc-sdk\nVersion: ${version}\n`)
  await writeFile(join(sdistRoot, 'LICENSE'), 'MIT\n')
  await writeFile(join(sdistRoot, 'erpc_sdk.py'), '__version__ = "0.11.0"\n')
  const sdistFile = join(bundle, `erpc_sdk-${version}.tar.gz`)
  await execFileAsync('tar', ['-czf', sdistFile, '-C', join(directory, 'sdist-root'), `erpc_sdk-${version}`], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

  const gemRoot = join(directory, 'gem-root')
  await mkdir(join(gemRoot, 'lib', 'erpc_sdk'), { recursive: true })
  await writeFile(join(gemRoot, 'lib', 'erpc_sdk.rb'), 'module ERPC; VERSION = "0.11.0"; end\n')
  await writeFile(join(gemRoot, 'LICENSE'), 'MIT\n')
  await writeFile(join(gemRoot, 'README.md'), '# SDK\n')
  await writeFile(join(gemRoot, 'erpc-sdk.gemspec'), `Gem::Specification.new do |spec|
  spec.name = 'erpc-sdk'
  spec.version = '0.11.0'
  spec.summary = 'checkpoint A fixture'
  spec.authors = ['fixture']
  spec.files = Dir['lib/**/*.rb'].sort + %w[LICENSE README.md]
  spec.require_paths = ['lib']
  spec.license = 'MIT'
end
`)
  await execFileAsync('gem', ['build', 'erpc-sdk.gemspec'], { cwd: gemRoot })
  const gemFile = join(bundle, `erpc-sdk-${version}.gem`)
  await cp(join(gemRoot, `erpc-sdk-${version}.gem`), gemFile)

  const crateRoot = join(directory, `erpc-sdk-${version}`)
  await mkdir(crateRoot, { recursive: true })
  await writeFile(join(crateRoot, 'Cargo.toml'), `[package]\nname = "erpc-sdk"\nversion = "${version}"\n`)
  await writeFile(join(crateRoot, 'LICENSE'), 'MIT\n')
  await writeFile(join(crateRoot, 'README.md'), '# SDK\n')
  await writeFile(join(crateRoot, '.cargo_vcs_info.json'), JSON.stringify({ git: { sha1: sourceCommit, dirty: false }, path_in_vcs: 'packages/rust' }))
  const crateFile = join(bundle, `erpc-sdk-${version}.crate`)
  await execFileAsync('tar', ['-czf', crateFile, '-C', directory, `erpc-sdk-${version}`], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

  const digest = async file => sha256Hex(await readFile(file))
  const artifacts = [
    { kind: 'npm', filename: `elsoul-erpc-sdk-${version}.tgz`, name: '@elsoul/erpc-sdk', version, sha256: await digest(npmFile), files: ['package', 'package/dist', 'package/LICENSE', 'package/README.md', 'package/dist/index.js', 'package/package.json'] },
    { kind: 'pypi-wheel', filename: `erpc_sdk-${version}-py3-none-any.whl`, name: 'erpc-sdk', version, sha256: await digest(wheelFile), files: ['erpc_sdk-0.11.0.dist-info/LICENSE', 'erpc_sdk-0.11.0.dist-info/METADATA', 'erpc_sdk/__init__.py'] },
    { kind: 'pypi-sdist', filename: `erpc_sdk-${version}.tar.gz`, name: 'erpc-sdk', version, sha256: await digest(sdistFile), files: [`erpc_sdk-${version}`, `erpc_sdk-${version}/LICENSE`, `erpc_sdk-${version}/PKG-INFO`, `erpc_sdk-${version}/erpc_sdk.py`] },
    { kind: 'rubygems', filename: `erpc-sdk-${version}.gem`, name: 'erpc-sdk', version, sha256: await digest(gemFile), files: ['LICENSE', 'README.md', 'lib/erpc_sdk.rb'] },
  ]
  const rustSha = await digest(crateFile)
  const inventoryFiles = [{ path: 'LICENSE', sha256: '5'.repeat(64) }, { path: 'go.mod', sha256: '6'.repeat(64) }]
  const inventory = { files: inventoryFiles, inventorySha256: sha256Hex(canonicalJson(inventoryFiles)) }
  const publicAssets = [
    ...RELEASE_SET_ARTIFACT_KINDS.map(role => ({ role, filename: artifacts.find(artifact => artifact.kind === role).filename })),
    ...RELEASE_SET_PUBLIC_ASSET_ROLES.filter(role => !RELEASE_SET_ARTIFACT_KINDS.includes(role)).map(role => ({ role, filename: ({ 'rust-proof': 'rust-proof.json' })[role] ?? ({ 'go-proof': 'go-proof.json', 'npm-proof': 'npm-proof.json', 'pypi-proof': 'pypi-proof.json', 'rubygems-proof': 'rubygems-proof.json', 'tag-proof': 'tag-proof.json', 'release-set-proof-manifest': 'release-set-proof-manifest.json', 'release-body': 'release-body.md', 'go-inventory': 'go-inventory.json' })[role] })),
    { role: 'rust-crate', filename: `erpc-sdk-${version}.crate` },
  ]
  const plan = buildReleaseSetPlan({
    repository: 'elsoul/erpc-sdk', repositoryId: '1429568627', workflowPath: '.github/workflows/release.yml', ciWorkflowPath: '.github/workflows/ci.yml',
    sourceCommit, controlCommit: sourceCommit, workflowRevision: sourceCommit,
    event: { name: 'workflow_dispatch', ref: 'refs/heads/main', sha: sourceCommit }, checkoutHead: sourceCommit, checkoutStatus: '',
    versions: { nonRustVersion: version, rustVersion: version }, artifacts,
    go: { module: 'github.com/elsoul/erpc-sdk/packages/go', version: 'v0.11.0', tag: 'packages/go/v0.11.0', sourceCommit, inventory },
    rust: { mode: 'publish', version, sourceCommit, sha256: rustSha, archive: { filename: `erpc-sdk-${version}.crate`, sha256: rustSha }, prepared: { runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', sourceCommit, archiveSha256: rustSha, licenseProfile: 'MIT AND Apache-2.0' } },
    ciProof: { workflowPath: '.github/workflows/ci.yml', sourceCommit, runId: '61', runAttempt: '1', jobId: '62', requiredJob: 'required-ci', event: 'push', headBranch: 'main', status: 'completed', conclusion: 'success' },
    tags: { release: 'non-rust-v0.11.0', go: 'packages/go/v0.11.0', commit: sourceCommit },
    githubRelease: { title: 'SDK release set: non-Rust 0.11.0 / Rust 0.11.0', tag: 'non-rust-v0.11.0', body: '# Future release\n', bodySha256: sha256Hex('# Future release\n') },
    approval: { environments: { npm: 'npm', pypi: 'pypi', rubygems: 'rubygems', cratesIo: 'crates-io' }, effects: ['publish npm', 'publish PyPI', 'publish RubyGems', 'create tags', 'create GitHub Release'], publicAssets, bundleFiles: [...artifacts.map(artifact => artifact.filename), `erpc-sdk-${version}.crate`, 'release-set-plan.json', 'release-set-plan.sha256', 'release-body.md', 'go-inventory.json', 'checksums.txt'] },
    licenseProfile: { nonRust: 'MIT', rust: 'MIT AND Apache-2.0' }, toolchain: { node: '24', python: '3.12', go: '1.22', ruby: '3.1', rust: '1.85.0' },
  })
  const historicalReuse = structuredClone(plan)
  historicalReuse.versions.rustVersion = '0.10.0'
  historicalReuse.rust = { mode: 'reuse', version: '0.10.0', sourceCommit: FOUNDATION_RUST_SOURCE, sha256: FOUNDATION_RUST_SHA256, reuse: { registry: 'crates.io', downloadUrl: 'https://crates.io/api/v1/crates/erpc-sdk/0.10.0/download', sourceCommit: FOUNDATION_RUST_SOURCE, sha256: FOUNDATION_RUST_SHA256, yanked: false } }
  historicalReuse.githubRelease.title = 'SDK release set: non-Rust 0.11.0 / Rust 0.10.0'
  historicalReuse.githubRelease.bodySha256 = sha256Hex(historicalReuse.githubRelease.body)
  historicalReuse.licenseProfile.rust = 'MIT'
  historicalReuse.approval.publicAssets = historicalReuse.approval.publicAssets.filter(asset => asset.role !== 'rust-crate')
  historicalReuse.approval.bundleFiles = historicalReuse.approval.bundleFiles.filter(file => file !== 'erpc-sdk-0.11.0.crate')
  assert.equal(validateReleaseSetPlan(historicalReuse).rust.reuse.sourceCommit, FOUNDATION_RUST_SOURCE)
  assert.throws(() => validateReleaseSetPlan({ ...historicalReuse, rust: { ...historicalReuse.rust, sourceCommit: 'not-a-source-sha' } }), /source commit/)
  assert.throws(() => validateReleaseSetPlan({ ...plan, approval: { ...plan.approval, environments: {} } }), /environment/)
  assert.throws(() => validateReleaseSetPlan({ ...plan, approval: { ...plan.approval, environments: { npm: 'unprotected-new', pypi: 'wrong', rubygems: 'wrong', cratesIo: 'wrong' } } }), /environment mismatch/)
  assert.throws(() => validateReleaseSetPlan({ ...plan, rust: { ...plan.rust, reuse: { registry: 'crates.io' } } }), /cannot include a reuse/)
  assert.throws(() => validateReleaseSetPlan({ ...plan, rust: { ...plan.rust, prepared: { ...plan.rust.prepared, licenseProfile: 'different arbitrary license' } } }), /approved named profile/)
  await writeFile(join(bundle, 'release-set-plan.json'), `${canonicalJson(plan)}\n`)
  await writeFile(join(bundle, 'release-set-plan.sha256'), `${releaseSetPlanDigest(plan)}\n`)
  await writeFile(join(bundle, 'release-body.md'), plan.githubRelease.body)
  await writeFile(join(bundle, 'go-inventory.json'), `${canonicalJson(plan.go.inventory)}\n`)
  const checksumFiles = [...plan.approval.bundleFiles].filter(file => file !== 'checksums.txt')
  await writeFile(join(bundle, 'checksums.txt'), `${(await Promise.all(checksumFiles.map(async file => `${await digest(join(bundle, file))}  ./${file}`))).join('\n')}\n`)
  assert.deepEqual((await ingestReleaseSetBundle({ plan, artifactDirectory: bundle })).prepared.map(item => item.filename).sort(), plan.approval.bundleFiles.filter(file => !['release-set-plan.json', 'release-set-plan.sha256', 'release-body.md', 'go-inventory.json', 'checksums.txt'].includes(file)).sort())
  const plain = join(directory, 'plain.tgz')
  await writeFile(plain, 'This is not an archive\n')
  const plainDigest = await digest(plain)
  await assert.rejects(() => inspectReleaseSetArtifactBytes({ ...artifacts[0], filename: 'plain.tgz', sha256: plainDigest }, plain, sourceCommit), /Archive|failed|malformed/i)
  assert.throws(() => parseReleaseSetChecksums(`${'a'.repeat(64)}  ./same\n${'b'.repeat(64)}  same\n`), /duplicates/)

  const validContext = { repository: 'elsoul/erpc-sdk', repositoryId: '1429568627', eventName: 'workflow_dispatch', eventRef: 'refs/heads/main', eventSha: sourceCommit, expectedCommit: sourceCommit, checkoutHead: sourceCommit, checkoutStatus: '', workflowRef: 'elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main', workflowSha: sourceCommit }
  assert.equal(validateReleaseSetContext(validContext, plan).sourceCommit, sourceCommit)
  assert.throws(() => validateReleaseSetContext({ ...validContext, eventSha: 'd'.repeat(40) }, plan), /event SHA mismatch/)
  const binding = { schemaVersion: 2, kind: 'erpc-sdk-release-set-preparation-binding', repository: 'elsoul/erpc-sdk', repositoryId: '1429568627', workflowPath: '.github/workflows/release.yml', sourceCommit, versions: { nonRustVersion: version, rustVersion: version }, runId: '51', runAttempt: '1', artifactId: '52', planSha256: releaseSetPlanDigest(plan) }
  validateReleaseSetPreparationBinding(binding, { plan, expected: { runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53' } })
  assert.throws(() => validateReleaseSetPreparationBinding({ ...binding, bindingArtifactId: '53' }, { plan, expected: { runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53' } }), /unknown field/)
  assert.throws(() => validateReleaseSetPreparationBinding({ ...binding, versions: { nonRustVersion: '9.9.9', rustVersion: version } }, { plan }), /version mismatch/)
  const run = { id: 51, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_branch: 'main', head_sha: sourceCommit, path: '.github/workflows/release.yml', repository: { full_name: 'elsoul/erpc-sdk', id: 1429568627 } }
  const metadata = { id: 52, name: `release-set-bundle-${sourceCommit}`, expired: false, size_in_bytes: 10, digest: `sha256:${'0'.repeat(64)}`, archive_download_url: 'https://api.github.com/repos/elsoul/erpc-sdk/actions/artifacts/52/zip', workflow_run: { id: 51, repository_id: 1429568627, head_repository_id: 1429568627, head_sha: sourceCommit, head_branch: 'main', run_attempt: 1, path: '.github/workflows/release.yml' } }
  const bindingMetadata = { ...metadata, id: 53, name: 'release-set-binding-51-1', archive_download_url: 'https://api.github.com/repos/elsoul/erpc-sdk/actions/artifacts/53/zip' }
  validateReleaseSetPreparationMetadata({ plan, run, artifact: metadata, bindingArtifact: bindingMetadata, expected: { runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', sourceCommit, bundleName: `release-set-bundle-${sourceCommit}`, bindingName: 'release-set-binding-51-1' } })
  assert.throws(() => validateReleaseSetPreparationMetadata({ plan, run: { ...run, head_sha: 'd'.repeat(40) }, artifact: metadata, bindingArtifact: bindingMetadata, expected: { runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', sourceCommit } }), /source mismatch/)
  const planFile = join(directory, 'plan.json')
  const bindingFile = join(directory, 'binding.json')
  const bindingDirectory = join(directory, 'binding-directory')
  await mkdir(bindingDirectory)
  await writeFile(join(bindingDirectory, 'release-set-binding.json'), JSON.stringify(binding))
  await writeFile(planFile, `${canonicalJson(plan)}\n`)
  await writeFile(bindingFile, JSON.stringify(binding))
  await runVerifierCli(['--release-set-ingest'], { RELEASE_SET_PLAN_FILE: planFile, RELEASE_SET_PLAN_SHA256: releaseSetPlanDigest(plan), RELEASE_SET_BINDING_FILE: bindingFile, RELEASE_SET_ARTIFACT_DIR: bundle, RELEASE_SET_PREPARED_RUN_ID: '51', RELEASE_SET_PREPARED_RUN_ATTEMPT: '1', RELEASE_SET_PREPARED_ARTIFACT_ID: '52', RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: '53' })
  const bundleZip = join(directory, 'bundle.zip')
  const bindingZip = join(directory, 'binding.zip')
  await execFileAsync('zip', ['-q', bundleZip, ...plan.approval.bundleFiles], { cwd: bundle })
  await execFileAsync('zip', ['-q', bindingZip, 'release-set-binding.json'], { cwd: bindingDirectory })
  const bundleZipBytes = await readFile(bundleZip)
  const bindingZipBytes = await readFile(bindingZip)
  const strictMetadata = { ...metadata, size_in_bytes: bundleZipBytes.length, digest: `sha256:${sha256Hex(bundleZipBytes)}` }
  const strictBindingMetadata = { ...bindingMetadata, size_in_bytes: bindingZipBytes.length, digest: `sha256:${sha256Hex(bindingZipBytes)}` }
  const runFile = join(directory, 'run.json')
  const artifactMetadataFile = join(directory, 'artifact-metadata.json')
  const bindingMetadataFile = join(directory, 'binding-metadata.json')
  await writeFile(runFile, JSON.stringify(run))
  await writeFile(artifactMetadataFile, JSON.stringify(strictMetadata))
  await writeFile(bindingMetadataFile, JSON.stringify(strictBindingMetadata))
  await runVerifierCli(['--release-set-verify'], {
    RELEASE_SET_PLAN_FILE: planFile, RELEASE_SET_PLAN_SHA256: releaseSetPlanDigest(plan), RELEASE_SET_BINDING_FILE: bindingFile,
    RELEASE_SET_ARTIFACT_DIR: bundle, RELEASE_SET_BINDING_DIR: bindingDirectory, RELEASE_SET_BUNDLE_ZIP_FILE: bundleZip, RELEASE_SET_BINDING_ZIP_FILE: bindingZip,
    RELEASE_SET_RUN_FILE: runFile, RELEASE_SET_ARTIFACT_METADATA_FILE: artifactMetadataFile, RELEASE_SET_BINDING_METADATA_FILE: bindingMetadataFile,
    RELEASE_SET_PREPARED_RUN_ID: '51', RELEASE_SET_PREPARED_RUN_ATTEMPT: '1', RELEASE_SET_PREPARED_ARTIFACT_ID: '52', RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: '53',
    REPOSITORY: 'elsoul/erpc-sdk', REPOSITORY_ID: '1429568627', EVENT_NAME: 'workflow_dispatch', EVENT_REF: 'refs/heads/main', EVENT_SHA: sourceCommit,
    EXPECTED_COMMIT: sourceCommit, CHECKOUT_HEAD: sourceCommit, CHECKOUT_STATUS: '', WORKFLOW_REF: 'elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main', WORKFLOW_SHA: sourceCommit,
  })
  const strictEnv = {
    RELEASE_SET_PLAN_FILE: planFile, RELEASE_SET_PLAN_SHA256: releaseSetPlanDigest(plan), RELEASE_SET_BINDING_FILE: bindingFile,
    RELEASE_SET_ARTIFACT_DIR: bundle, RELEASE_SET_BINDING_DIR: bindingDirectory, RELEASE_SET_BUNDLE_ZIP_FILE: bundleZip, RELEASE_SET_BINDING_ZIP_FILE: bindingZip,
    RELEASE_SET_RUN_FILE: runFile, RELEASE_SET_ARTIFACT_METADATA_FILE: artifactMetadataFile, RELEASE_SET_BINDING_METADATA_FILE: bindingMetadataFile,
    RELEASE_SET_PREPARED_RUN_ID: '51', RELEASE_SET_PREPARED_RUN_ATTEMPT: '1', RELEASE_SET_PREPARED_ARTIFACT_ID: '52', RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: '53',
    REPOSITORY: 'elsoul/erpc-sdk', REPOSITORY_ID: '1429568627', EVENT_NAME: 'workflow_dispatch', EVENT_REF: 'refs/heads/main', EVENT_SHA: sourceCommit,
    EXPECTED_COMMIT: sourceCommit, CHECKOUT_HEAD: sourceCommit, CHECKOUT_STATUS: '', WORKFLOW_REF: 'elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main', WORKFLOW_SHA: sourceCommit,
  }
  const {
    RELEASE_SET_RUN_FILE: _baselineRunFile,
    RELEASE_SET_ARTIFACT_METADATA_FILE: _baselineArtifactMetadataFile,
    RELEASE_SET_BINDING_METADATA_FILE: _baselineBindingMetadataFile,
    RELEASE_SET_BINDING_FILE: _baselineBindingFile,
    RELEASE_SET_BINDING_DIR: _baselineBindingDirectory,
    RELEASE_SET_BUNDLE_ZIP_FILE: _baselineBundleZipFile,
    RELEASE_SET_BINDING_ZIP_FILE: _baselineBindingZipFile,
    RELEASE_SET_PREPARED_RUN_ID: _baselinePreparedRunId,
    RELEASE_SET_PREPARED_RUN_ATTEMPT: _baselinePreparedRunAttempt,
    RELEASE_SET_PREPARED_ARTIFACT_ID: _baselinePreparedArtifactId,
    RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: _baselinePreparedBindingArtifactId,
    ...producerEnvBase
  } = strictEnv
  const producerPairs = [
    { runId: '74101', runAttempt: '1', artifactId: '74153', bindingArtifactId: '74171' },
    { runId: '89201', runAttempt: '1', artifactId: '89273', bindingArtifactId: '89291' },
  ]
  const makeUploadService = allocation => {
    let bundleUpload
    let bindingUpload
    const upload = async (kind, bytes) => {
      if (kind === 'bundle' && bundleUpload !== undefined) throw new Error('fixture bundle upload called more than once')
      if (kind === 'binding' && bindingUpload !== undefined) throw new Error('fixture binding upload called more than once')
      if (kind === 'binding' && bundleUpload === undefined) throw new Error('fixture binding upload requires bundle upload')
      const capturedBytes = Buffer.from(bytes)
      const captured = {
        kind,
        id: kind === 'bundle' ? allocation.artifactId : allocation.bindingArtifactId,
        bytes: capturedBytes,
        sizeInBytes: capturedBytes.length,
        sha256: sha256Hex(capturedBytes),
      }
      captured.archiveDownloadUrl = `https://api.github.com/repos/elsoul/erpc-sdk/actions/artifacts/${captured.id}/zip`
      if (kind === 'bundle') bundleUpload = captured
      else bindingUpload = captured
      return captured
    }
    return {
      upload,
      get bindingArtifactId() {
        if (bindingUpload === undefined) throw new Error('fixture binding artifact ID unavailable before upload')
        return bindingUpload.id
      },
    }
  }
  const producerApiRecord = (upload, name, producerRun) => ({
    id: Number(upload.id),
    name,
    expired: false,
    size_in_bytes: upload.sizeInBytes,
    digest: `sha256:${upload.sha256}`,
    archive_download_url: upload.archiveDownloadUrl,
    workflow_run: {
      id: producerRun.id,
      repository_id: 1429568627,
      head_repository_id: 1429568627,
      head_sha: sourceCommit,
      head_branch: 'main',
      run_attempt: producerRun.run_attempt,
      path: '.github/workflows/release.yml',
    },
  })
  const bindingBodyFields = ({ runId, runAttempt, artifactId }) => ({
    schemaVersion: binding.schemaVersion,
    kind: binding.kind,
    repository: binding.repository,
    repositoryId: binding.repositoryId,
    workflowPath: binding.workflowPath,
    sourceCommit: binding.sourceCommit,
    versions: binding.versions,
    runId,
    runAttempt,
    artifactId,
    planSha256: binding.planSha256,
  })
  for (const [producerIndex, allocation] of producerPairs.entries()) {
    const service = makeUploadService(allocation)
    const producerRun = {
      id: Number(allocation.runId),
      run_attempt: Number(allocation.runAttempt),
      status: 'completed',
      conclusion: 'success',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: sourceCommit,
      path: '.github/workflows/release.yml',
      repository: { full_name: 'elsoul/erpc-sdk', id: 1429568627 },
    }
    const producerRunFile = join(directory, `producer-${allocation.artifactId}-run.json`)
    await writeFile(producerRunFile, JSON.stringify(producerRun))
    const frozenBundle = await service.upload('bundle', bundleZipBytes)
    assert.equal(frozenBundle.id, allocation.artifactId)
    assert.equal(frozenBundle.sizeInBytes, bundleZipBytes.length)
    assert.equal(frozenBundle.sha256, sha256Hex(bundleZipBytes))
    const producerBindingBody = bindingBodyFields({ runId: allocation.runId, runAttempt: allocation.runAttempt, artifactId: frozenBundle.id })
    assert.equal(Object.hasOwn(producerBindingBody, 'bindingArtifactId'), false)
    const producerBindingDirectory = join(directory, `producer-${allocation.artifactId}-binding-directory`)
    await mkdir(producerBindingDirectory)
    const producerBindingFile = join(directory, `producer-${allocation.artifactId}-binding.json`)
    const producerBindingJson = JSON.stringify(producerBindingBody)
    const producerBindingBodyDigest = sha256Hex(Buffer.from(producerBindingJson))
    await writeFile(producerBindingFile, producerBindingJson)
    await writeFile(join(producerBindingDirectory, 'release-set-binding.json'), producerBindingJson)
    const producerBindingZip = join(directory, `producer-${allocation.artifactId}-binding.zip`)
    await execFileAsync('zip', ['-q', producerBindingZip, 'release-set-binding.json'], { cwd: producerBindingDirectory })
    const frozenBindingBytes = await readFile(producerBindingZip)
    const frozenBindingDigest = sha256Hex(frozenBindingBytes)
    assert.throws(() => service.bindingArtifactId, /unavailable before upload/)
    const allocatedBinding = await service.upload('binding', frozenBindingBytes)
    assert.equal(service.bindingArtifactId, allocatedBinding.id)
    assert.equal(allocatedBinding.id, allocation.bindingArtifactId)
    assert.equal(allocatedBinding.sizeInBytes, frozenBindingBytes.length)
    assert.equal(allocatedBinding.sha256, frozenBindingDigest)
    assert.equal(sha256Hex(await readFile(producerBindingFile)), producerBindingBodyDigest)
    assert.equal(sha256Hex(await readFile(producerBindingZip)), frozenBindingDigest)
    assert.equal(sha256Hex(await readFile(bundleZip)), frozenBundle.sha256)
    const bundleName = `release-set-bundle-${sourceCommit}`
    const bindingName = `release-set-binding-${allocation.runId}-${allocation.runAttempt}`
    const producerArtifact = producerApiRecord(frozenBundle, bundleName, producerRun)
    const producerBindingArtifact = producerApiRecord(allocatedBinding, bindingName, producerRun)
    const producerArtifactMetadataFile = join(directory, `producer-${allocation.artifactId}-artifact-metadata.json`)
    const producerBindingMetadataFile = join(directory, `producer-${allocation.artifactId}-binding-metadata.json`)
    await writeFile(producerArtifactMetadataFile, JSON.stringify(producerArtifact))
    await writeFile(producerBindingMetadataFile, JSON.stringify(producerBindingArtifact))
    const producerExpected = {
      runId: allocation.runId,
      runAttempt: allocation.runAttempt,
      artifactId: frozenBundle.id,
      bindingArtifactId: allocatedBinding.id,
      sourceCommit,
      bundleName,
      bindingName,
    }
    const producerEnv = {
      ...producerEnvBase,
      RELEASE_SET_RUN_FILE: producerRunFile,
      RELEASE_SET_ARTIFACT_DIR: bundle,
      RELEASE_SET_BINDING_FILE: producerBindingFile,
      RELEASE_SET_BINDING_DIR: producerBindingDirectory,
      RELEASE_SET_BUNDLE_ZIP_FILE: bundleZip,
      RELEASE_SET_BINDING_ZIP_FILE: producerBindingZip,
      RELEASE_SET_ARTIFACT_METADATA_FILE: producerArtifactMetadataFile,
      RELEASE_SET_BINDING_METADATA_FILE: producerBindingMetadataFile,
      RELEASE_SET_PREPARED_RUN_ID: producerExpected.runId,
      RELEASE_SET_PREPARED_RUN_ATTEMPT: producerExpected.runAttempt,
      RELEASE_SET_PREPARED_ARTIFACT_ID: producerExpected.artifactId,
      RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: producerExpected.bindingArtifactId,
    }
    if (producerIndex === 1) {
      const staleExpectedEnv = {
        ...producerEnv,
        RELEASE_SET_PREPARED_ARTIFACT_ID: producerPairs[0].artifactId,
        RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: producerPairs[0].bindingArtifactId,
      }
      await assert.rejects(runVerifierCli(['--release-set-verify'], staleExpectedEnv), /ID mismatch/)
      t.diagnostic(`stale expected pair ${producerPairs[0].artifactId}/${producerPairs[0].bindingArtifactId} rejected against allocated ${frozenBundle.id}/${allocatedBinding.id}`)
    }
    const helperResult = await verifyReleaseSetPreparation({
      plan,
      context: validContext,
      run: producerRun,
      artifact: producerArtifact,
      bindingArtifact: producerBindingArtifact,
      binding: producerBindingBody,
      bundleZip,
      bindingZip: producerBindingZip,
      artifactDirectory: bundle,
      bindingDirectory: producerBindingDirectory,
      expected: producerExpected,
    })
    assert.equal(helperResult.bundleZip.id, Number(frozenBundle.id))
    assert.equal(helperResult.bindingZip.id, Number(allocatedBinding.id))
    await runVerifierCli(['--release-set-verify'], producerEnv)
    t.diagnostic(`producer allocation pair ${producerIndex + 1}: bundle=${frozenBundle.id}, binding=${allocatedBinding.id}`)
  }
  await assert.rejects(runVerifierCli(['--release-set-verify'], { ...strictEnv, RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: '54' }), /ID mismatch/)
  await assert.rejects(runVerifierCli(['--release-set-verify'], { ...strictEnv, RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: '9007199254740993' }), /safe positive numeric ID/)
  const differentBindingDirectory = join(directory, 'different-binding')
  await mkdir(differentBindingDirectory)
  const differentBinding = { ...binding, bindingArtifactId: '54' }
  const differentBindingFile = join(directory, 'different-binding.json')
  await writeFile(differentBindingFile, JSON.stringify(differentBinding))
  await writeFile(join(differentBindingDirectory, 'release-set-binding.json'), JSON.stringify(differentBinding))
  const differentBindingMetadataFile = join(directory, 'different-binding-metadata.json')
  await writeFile(differentBindingMetadataFile, JSON.stringify({ ...strictBindingMetadata, id: 54, archive_download_url: 'https://api.github.com/repos/elsoul/erpc-sdk/actions/artifacts/54/zip' }))
  await assert.rejects(runVerifierCli(['--release-set-verify'], { ...strictEnv, RELEASE_SET_BINDING_FILE: differentBindingFile, RELEASE_SET_BINDING_DIR: differentBindingDirectory, RELEASE_SET_BINDING_METADATA_FILE: differentBindingMetadataFile, RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: '54' }), /unknown field|ZIP member bytes differ|binding ZIP\/consumed binding mismatch/)
  await writeFile(join(bindingDirectory, 'unrelated.json'), 'unrelated')
  await assert.rejects(runVerifierCli(['--release-set-verify'], strictEnv), /ZIP members do not equal consumed files|exactly release-set-binding/)
  await rm(join(bindingDirectory, 'unrelated.json'))
  await writeFile(join(bindingDirectory, 'release-set-binding.json'), JSON.stringify(binding))
  const symlinkZip = join(directory, 'symlink-binding.zip')
  await execFileAsync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); i=zipfile.ZipInfo("link"); i.create_system=3; i.external_attr=(0o120777 << 16); z.writestr(i,"release-set-binding.json"); z.writestr("release-set-binding.json",open(sys.argv[2],"rb").read()); z.close()', symlinkZip, bindingFile])
  const symlinkBytes = await readFile(symlinkZip)
  const symlinkMetadataFile = join(directory, 'symlink-binding-metadata.json')
  await writeFile(symlinkMetadataFile, JSON.stringify({ ...strictBindingMetadata, size_in_bytes: symlinkBytes.length, digest: `sha256:${sha256Hex(symlinkBytes)}` }))
  await assert.rejects(runVerifierCli(['--release-set-verify'], { ...strictEnv, RELEASE_SET_BINDING_ZIP_FILE: symlinkZip, RELEASE_SET_BINDING_METADATA_FILE: symlinkMetadataFile }), /non-regular|symlink/)
  await assert.rejects(runVerifierCli(['--release-set-verify'], {
    RELEASE_SET_PLAN_FILE: planFile, RELEASE_SET_PLAN_SHA256: releaseSetPlanDigest(plan), RELEASE_SET_BINDING_FILE: bindingFile, RELEASE_SET_ARTIFACT_DIR: bundle,
    RELEASE_SET_PREPARED_RUN_ID: '51', RELEASE_SET_PREPARED_RUN_ATTEMPT: '1', RELEASE_SET_PREPARED_ARTIFACT_ID: '52', RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: '53',
    REPOSITORY: 'elsoul/erpc-sdk', REPOSITORY_ID: '1429568627', EVENT_NAME: 'workflow_dispatch', EVENT_REF: 'refs/heads/main', EVENT_SHA: sourceCommit,
    EXPECTED_COMMIT: sourceCommit, CHECKOUT_HEAD: sourceCommit, CHECKOUT_STATUS: '', WORKFLOW_REF: 'elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main', WORKFLOW_SHA: sourceCommit,
  }), /Missing RELEASE_SET_RUN_FILE/)
  await assert.rejects(runVerifierCli(['--release-set-verify'], {
    RELEASE_SET_PLAN_FILE: planFile, RELEASE_SET_PLAN_SHA256: releaseSetPlanDigest(plan), RELEASE_SET_BINDING_FILE: bindingFile, RELEASE_SET_ARTIFACT_DIR: bundle,
    RELEASE_SET_PREPARED_RUN_ID: '51', RELEASE_SET_PREPARED_RUN_ATTEMPT: '1', RELEASE_SET_PREPARED_ARTIFACT_ID: '52', RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID: '53',
    REPOSITORY: 'elsoul/erpc-sdk', REPOSITORY_ID: '1429568627', EVENT_NAME: 'workflow_dispatch', EVENT_REF: 'refs/heads/main', EVENT_SHA: 'd'.repeat(40), EXPECTED_COMMIT: sourceCommit, CHECKOUT_HEAD: sourceCommit, CHECKOUT_STATUS: '', WORKFLOW_REF: 'elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main', WORKFLOW_SHA: sourceCommit,
  }), /event SHA mismatch|Missing RELEASE_SET_RUN_FILE/)
  const recomputedBindingMetadata = async zipFile => {
    const bytes = await readFile(zipFile)
    return { ...strictBindingMetadata, size_in_bytes: bytes.length, digest: `sha256:${sha256Hex(bytes)}` }
  }
  const b1DifferentBindingDirectory = join(directory, 'b1-different-binding-directory')
  await mkdir(b1DifferentBindingDirectory)
  await writeFile(join(b1DifferentBindingDirectory, 'release-set-binding.json'), JSON.stringify({ ...binding, sourceCommit: 'd'.repeat(40) }))
  const b1DifferentBindingZip = join(directory, 'b1-different-binding.zip')
  await execFileAsync('zip', ['-q', b1DifferentBindingZip, 'release-set-binding.json'], { cwd: b1DifferentBindingDirectory })
  const b1DifferentBindingMetadataFile = join(directory, 'b1-different-binding-metadata.json')
  await writeFile(b1DifferentBindingMetadataFile, JSON.stringify(await recomputedBindingMetadata(b1DifferentBindingZip)))
  await assert.rejects(runVerifierCli(['--release-set-verify'], { ...strictEnv, RELEASE_SET_BINDING_DIR: b1DifferentBindingDirectory, RELEASE_SET_BINDING_ZIP_FILE: b1DifferentBindingZip, RELEASE_SET_BINDING_METADATA_FILE: b1DifferentBindingMetadataFile }), /binding ZIP\/consumed binding mismatch/)

  const b1UnrelatedBindingDirectory = join(directory, 'b1-unrelated-binding-directory')
  await mkdir(b1UnrelatedBindingDirectory)
  await writeFile(join(b1UnrelatedBindingDirectory, 'unrelated.json'), '{"unrelated":true}\n')
  const b1UnrelatedBindingZip = join(directory, 'b1-unrelated-binding.zip')
  await execFileAsync('zip', ['-q', b1UnrelatedBindingZip, 'unrelated.json'], { cwd: b1UnrelatedBindingDirectory })
  const b1UnrelatedBindingMetadataFile = join(directory, 'b1-unrelated-binding-metadata.json')
  await writeFile(b1UnrelatedBindingMetadataFile, JSON.stringify(await recomputedBindingMetadata(b1UnrelatedBindingZip)))
  await assert.rejects(runVerifierCli(['--release-set-verify'], { ...strictEnv, RELEASE_SET_BINDING_DIR: b1UnrelatedBindingDirectory, RELEASE_SET_BINDING_ZIP_FILE: b1UnrelatedBindingZip, RELEASE_SET_BINDING_METADATA_FILE: b1UnrelatedBindingMetadataFile }), /exactly release-set-binding/)

  const typedSymlinkZip = join(directory, 'b1-typed-symlink-binding.zip')
  await execFileAsync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); i=zipfile.ZipInfo("link"); i.create_system=3; i.external_attr=(0o120777 << 16); z.writestr(i,"release-set-binding.json"); z.writestr("release-set-binding.json",open(sys.argv[2],"rb").read()); z.close()', typedSymlinkZip, bindingFile])
  const typedSymlinkMetadataFile = join(directory, 'b1-typed-symlink-binding-metadata.json')
  await writeFile(typedSymlinkMetadataFile, JSON.stringify(await recomputedBindingMetadata(typedSymlinkZip)))
  await assert.rejects(runVerifierCli(['--release-set-verify'], { ...strictEnv, RELEASE_SET_BINDING_ZIP_FILE: typedSymlinkZip, RELEASE_SET_BINDING_METADATA_FILE: typedSymlinkMetadataFile }), /non-regular|symlink/)
  const npmPublisherFile = join(directory, 'npm-publisher.json')
  await writeFile(npmPublisherFile, JSON.stringify({ repository: 'elsoul/erpc-sdk', repositoryId: '1429568627', sourceCommit, workflowPath: '.github/workflows/release.yml', ref: 'refs/heads/main', event: 'workflow_dispatch', environment: 'npm', publisherRunId: '39871872971', publisherAttempt: '1' }))
  const npmOutput = join(directory, 'npm-receipt.json')
  await writeFile(npmOutput, `${JSON.stringify({ schemaVersion: 1, kind: 'npm-public-observation', state: 'observed' })}\n`)
  const npmWork = join(directory, 'npm-work')
  await mkdir(npmWork)
  const npmCliEnvironment = { ...strictEnv, RELEASE_SET_NPM_PUBLISHER_FILE: npmPublisherFile, RELEASE_SET_NPM_OUTPUT_FILE: npmOutput, RELEASE_SET_NPM_WORK_DIR: npmWork, RELEASE_SET_NPM_OBSERVER_RUN_ID: '9001', RELEASE_SET_NPM_OBSERVER_ATTEMPT: '1', RELEASE_SET_NPM_OBSERVER_WORKFLOW: '.github/workflows/release.yml', RELEASE_SET_NPM_OBSERVER_SOURCE: sourceCommit, RELEASE_SET_NPM_NODE: process.execPath, RELEASE_SET_NPM_CLI: process.execPath, RELEASE_SET_NPM_PYTHON: process.execPath }
  delete npmCliEnvironment.RELEASE_SET_RUN_FILE
  await assert.rejects(runVerifierCli(['--release-set-npm-observe'], npmCliEnvironment), /Missing RELEASE_SET_RUN_FILE/)
  await assert.rejects(() => readFile(npmOutput, 'utf8'), { code: 'ENOENT' })
  await assert.rejects(runVerifierCli(['--release-set-observe'], { RELEASE_SET_PLAN_FILE: planFile, RELEASE_SET_PLAN_SHA256: releaseSetPlanDigest(plan), RELEASE_SET_PROOF_FILE: join(directory, 'missing-proof.json') }), /unavailable until checkpoint B/)
})

test('checkpoint A rejects malformed Rust roots/TOML/VCS and malformed Ruby containers/spec payloads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-release-set-a-archives-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const rustScript = `import io, json, sys, tarfile
out, mode = sys.argv[1:]
root = 'erpc-sdk-0.11.0'
manifest = '[package]\\nname = "erpc-sdk"\\nversion = "0.11.0"\\n' if mode != 'no-package' else '[dependencies.not_the_sdk]\\nname = "erpc-sdk"\\nversion = "0.11.0"\\n'
vcs = {'git': {'sha1': '${'c'.repeat(40)}', 'dirty': False}, 'path_in_vcs': 'packages/rust'}
if mode == 'dirty-string': vcs['git']['dirty'] = 'true'
with tarfile.open(out, 'w:gz') as archive:
    def add(name, data):
        info = tarfile.TarInfo(name); info.size = len(data); archive.addfile(info, io.BytesIO(data))
    add(root + '/Cargo.toml', manifest.encode())
    add(root + '/LICENSE', b'MIT\\n')
    add(root + '/README.md', b'# SDK\\n')
    add(root + '/.cargo_vcs_info.json', json.dumps(vcs).encode())
    if mode == 'duplicate': add(root + '/README.md', b'duplicate\\n')
    if mode == 'extra-root': add('other-root/extra.txt', b'extra\\n')
    if mode == 'symlink':
        info = tarfile.TarInfo(root + '/link'); info.type = tarfile.SYMTYPE; info.linkname = 'README.md'; archive.addfile(info)
`
  const makeRust = async mode => {
    const file = join(directory, `rust-${mode}.crate`)
    await execFileAsync('python3', ['-c', rustScript, file, mode])
    return file
  }
  const dirtyRust = await makeRust('dirty-string')
  const noPackageRust = await makeRust('no-package')
  const extraRootRust = await makeRust('extra-root')
  const duplicateRust = await makeRust('duplicate')
  const symlinkRust = await makeRust('symlink')
  await assert.rejects(() => inspectReleaseSetRustArchiveBytes({ filePath: dirtyRust, version: '0.11.0', sourceCommit: 'c'.repeat(40) }), /VCS provenance/)
  await assert.rejects(() => inspectReleaseSetRustArchiveBytes({ filePath: noPackageRust, version: '0.11.0', sourceCommit: 'c'.repeat(40) }), /package table|identity|Cargo\.toml/)
  await assert.rejects(() => inspectReleaseSetRustArchiveBytes({ filePath: extraRootRust, version: '0.11.0', sourceCommit: 'c'.repeat(40) }), /exactly one/)
  await assert.rejects(() => inspectReleaseSetRustArchiveBytes({ filePath: duplicateRust, version: '0.11.0', sourceCommit: 'c'.repeat(40) }), /duplicate member/)
  await assert.rejects(() => inspectReleaseSetRustArchiveBytes({ filePath: symlinkRust, version: '0.11.0', sourceCommit: 'c'.repeat(40) }), /non-regular/)

  const gemRoot = join(directory, 'gem-root')
  await mkdir(join(gemRoot, 'lib'), { recursive: true })
  await writeFile(join(gemRoot, 'lib', 'erpc_sdk.rb'), 'module ERPC; VERSION = "0.11.0"; end\n')
  await writeFile(join(gemRoot, 'LICENSE'), 'MIT\n')
  await writeFile(join(gemRoot, 'README.md'), '# SDK\n')
  await writeFile(join(gemRoot, 'erpc-sdk.gemspec'), `Gem::Specification.new do |spec|
  spec.name = 'erpc-sdk'
  spec.version = '0.11.0'
  spec.summary = 'checkpoint A fixture'
  spec.authors = ['fixture']
  spec.files = Dir['lib/**/*.rb'].sort + %w[LICENSE README.md]
  spec.require_paths = ['lib']
  spec.license = 'MIT'
end
`)
  await execFileAsync('gem', ['build', 'erpc-sdk.gemspec'], { cwd: gemRoot })
  const gem = join(directory, 'erpc-sdk-0.11.0.gem')
  await cp(join(gemRoot, 'erpc-sdk-0.11.0.gem'), gem)
  assert.deepEqual((await inspectReleaseSetRubyGemBytes({ filePath: gem, name: 'erpc-sdk', version: '0.11.0' })).sort(), ['LICENSE', 'README.md', 'lib/erpc_sdk.rb'].sort())
  const mutateGemScript = `import io, sys, tarfile, gzip
source, output, mode = sys.argv[1:]
with tarfile.open(source, 'r:') as outer:
    records = [(info, outer.extractfile(info).read() if info.isfile() else None) for info in outer.getmembers()]
if mode == 'extra-outer':
    info = tarfile.TarInfo('unexpected.bin'); info.size = 5; records.append((info, b'extra'))
else:
    data = next(data for info, data in records if info.name == 'data.tar.gz')
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data)), mode='r:') as data_tar:
        members = [(info, data_tar.extractfile(info).read() if info.isfile() else None) for info in data_tar.getmembers()]
    info = tarfile.TarInfo('extra.rb'); info.size = 8; members.append((info, b'extra.rb'))
    data_buffer = io.BytesIO()
    with tarfile.open(fileobj=data_buffer, mode='w:') as data_tar:
        for info, body in members:
            info = tarfile.TarInfo(info.name); info.size = len(body or b''); data_tar.addfile(info, io.BytesIO(body) if body is not None else None)
    records = [(info, gzip.compress(data_buffer.getvalue()) if info.name == 'data.tar.gz' else body) for info, body in records]
with tarfile.open(output, 'w:') as outer:
    for info, body in records:
        info = tarfile.TarInfo(info.name); info.size = len(body or b''); outer.addfile(info, io.BytesIO(body) if body is not None else None)
`
  for (const mode of ['extra-outer', 'spec-payload']) {
    const mutated = join(directory, `gem-${mode}.gem`)
    await execFileAsync('python3', ['-c', mutateGemScript, gem, mutated, mode])
    await assert.rejects(() => inspectReleaseSetRubyGemBytes({ filePath: mutated, name: 'erpc-sdk', version: '0.11.0' }), /outer member|specification\/data|mismatch/)
  }
})

test('B1 npm observer executes actual HTTP/process/crypto-policy/consumer paths without trusted receipt inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-b1-npm-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pythonPath = (await execFileAsync('which', ['python3'])).stdout.trim()
  const packageRoot = join(directory, 'package-root')
  await mkdir(join(packageRoot, 'package', 'dist'), { recursive: true })
  await writeFile(join(packageRoot, 'package', 'package.json'), JSON.stringify({ name: '@elsoul/erpc-sdk', version: '0.9.1', exports: { '.': { require: './dist/index.cjs', import: './dist/index.mjs' } } }))
  await writeFile(join(packageRoot, 'package', 'LICENSE'), 'MIT\n')
  await writeFile(join(packageRoot, 'package', 'README.md'), '# historical fixture\n')
  await writeFile(join(packageRoot, 'package', 'dist', 'index.cjs'), 'module.exports = { ok: true }\n')
  await writeFile(join(packageRoot, 'package', 'dist', 'index.mjs'), 'export const ok = true\n')
  const archive = join(directory, 'elsoul-erpc-sdk-0.9.1.tgz')
  await execFileAsync('tar', ['-czf', archive, '-C', packageRoot, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const archiveBytes = await readFile(archive)
  const archiveSha256 = sha256Hex(archiveBytes)
  const archiveSha512 = (await import('node:crypto')).createHash('sha512').update(archiveBytes).digest('hex')
  const integrity = `sha512-${(await import('node:crypto')).createHash('sha512').update(archiveBytes).digest('base64')}`
  const descriptor = { kind: 'npm', filename: 'elsoul-erpc-sdk-0.9.1.tgz', name: '@elsoul/erpc-sdk', version: '0.9.1', sha256: archiveSha256, files: ['package', 'package/dist', 'package/LICENSE', 'package/README.md', 'package/dist/index.cjs', 'package/dist/index.mjs', 'package/package.json'] }
  const metadata = { name: descriptor.name, version: descriptor.version, dist: { tarball: 'https://registry.npmjs.org/@elsoul/erpc-sdk/-/erpc-sdk-0.9.1.tgz', integrity } }
  const sourceCommit = '4'.repeat(40)
  const publisher = { repository: 'elsoul/erpc-sdk', repositoryId: '1429568627', sourceCommit, workflowPath: '.github/workflows/release.yml', ref: 'refs/heads/main', event: 'workflow_dispatch', environment: 'npm', publisherRunId: '39871872971', publisherAttempt: '1' }
  const invocation = 'https://github.com/elsoul/erpc-sdk/actions/runs/39871872971/attempts/1'
  const claims = {
    '1.3.6.1.4.1.57264.1.8': 'https://token.actions.githubusercontent.com',
    '1.3.6.1.4.1.57264.1.9': 'https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main',
    '1.3.6.1.4.1.57264.1.10': sourceCommit,
    '1.3.6.1.4.1.57264.1.12': 'https://github.com/elsoul/erpc-sdk',
    '1.3.6.1.4.1.57264.1.13': sourceCommit,
    '1.3.6.1.4.1.57264.1.14': 'refs/heads/main',
    '1.3.6.1.4.1.57264.1.15': '1429568627',
    '1.3.6.1.4.1.57264.1.18': 'https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main',
    '1.3.6.1.4.1.57264.1.19': sourceCommit,
    '1.3.6.1.4.1.57264.1.20': 'workflow_dispatch',
    '1.3.6.1.4.1.57264.1.21': invocation,
    '1.3.6.1.4.1.57264.1.23': 'npm',
    '1.3.6.1.4.1.57264.1.24': 'repo:elsoul@42315168/erpc-sdk@1429568627:environment:npm',
  }
  const provenance = { predicateType: 'https://slsa.dev/provenance/v1', subject: [{ name: 'pkg:npm/%40elsoul/erpc-sdk@0.9.1', digest: { sha512: archiveSha512 } }], predicate: { buildDefinition: { externalParameters: { workflow: { repository: 'https://github.com/elsoul/erpc-sdk', path: '.github/workflows/release.yml', ref: 'refs/heads/main' } }, internalParameters: { github: { repository_id: '1429568627', event_name: 'workflow_dispatch' } }, resolvedDependencies: [{ digest: { gitCommit: sourceCommit } }] }, runDetails: { metadata: { invocationId: invocation } } } }
  const audit = { invalid: [], missing: [], verified: [{ name: descriptor.name, version: descriptor.version, registry: 'https://registry.npmjs.org/', attestationBundles: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { verificationMaterial: { certificate: { rawBytes: Buffer.from('certificate-fixture').toString('base64') } }, dsseEnvelope: { payload: Buffer.from(JSON.stringify(provenance)).toString('base64') } } }] }] }
  const calls = []
  const server = createServer((request_, response) => {
    const path = decodeURIComponent(new URL(request_.url, 'http://loopback').pathname)
    response.setHeader('content-type', 'application/json')
    if (path === '/@elsoul/erpc-sdk/0.9.1') {
      response.statusCode = 200
      response.end(JSON.stringify(metadata))
    } else if (path === '/@elsoul/erpc-sdk') {
      response.statusCode = 200
      response.end(JSON.stringify({ name: descriptor.name, versions: { '0.9.1': metadata } }))
    } else if (path === '/@elsoul/erpc-sdk/-/erpc-sdk-0.9.1.tgz') {
      response.statusCode = 200
      response.setHeader('content-type', 'application/gzip')
      response.end(archiveBytes)
    } else {
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not-found' }))
    }
  })
  await new Promise((resolve_, reject_) => {
    server.once('error', reject_)
    server.listen(0, '127.0.0.1', resolve_)
  })
  t.after(() => new Promise(resolve_ => server.close(resolve_)))
  const port = server.address().port
  const request = async url => {
    calls.push(['request', url])
    const logical = new URL(url)
    if (logical.origin !== 'https://registry.npmjs.org') throw new Error('unexpected registry route')
    const response = await fetch(`http://127.0.0.1:${port}${logical.pathname}`)
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) }
  }
  let brokenEsm = false
  const run = async (command, args, options = {}) => {
    calls.push(['run', command, args, options.cwd, options.env])
    if (args.includes('--version')) return { exitCode: 0, stdout: args.length === 1 ? 'v24.1.0\n' : '11.19.1\n', stderr: '' }
    if (command.includes('python') && args[0] === '-c' && args.at(-1)?.endsWith('.json')) return { exitCode: 0, stdout: `${JSON.stringify(claims)}\n`, stderr: '' }
    if (command.includes('python') && args[0] === '-c') return { exitCode: 0, stdout: '3.12.11\n46.0.3\n', stderr: '' }
    if (args.includes('install')) {
      const prefix = args[args.indexOf('--prefix') + 1]
      const packageDirectory = join(prefix, 'node_modules', '@elsoul', 'erpc-sdk')
      await rm(packageDirectory, { recursive: true, force: true })
      await mkdir(join(prefix, 'node_modules', '@elsoul'), { recursive: true })
      await cp(join(packageRoot, 'package'), packageDirectory, { recursive: true })
      if (brokenEsm && args.some(value => String(value).endsWith('.tgz'))) await writeFile(join(packageDirectory, 'dist', 'index.mjs'), 'throw new Error("fixture-esm-broken")\n')
      if (args.includes(`@elsoul/erpc-sdk@${descriptor.version}`)) await writeFile(join(prefix, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@elsoul/erpc-sdk': { version: descriptor.version, resolved: metadata.dist.tarball, integrity: metadata.dist.integrity } } }))
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args.includes('audit') && args.includes('signatures')) return { exitCode: 0, stdout: JSON.stringify(audit), stderr: '' }
    if (args.includes('--input-type=module') || args.some(value => String(value).includes('require.resolve'))) {
      try {
        const result = await execFileAsync(process.execPath, args, { cwd: options.cwd, env: options.env })
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        return { exitCode: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const outputFile = join(directory, 'npm-observation.json')
  await mkdir(join(directory, 'work'))
  const dummyEnvironment = { npm_config_userconfig: '/tmp/dummy-user', npm_config_globalconfig: '/tmp/dummy-global', npm_config_cache: '/tmp/dummy-cache', npm_config_prefix: '/tmp/dummy-prefix', 'npm_config_@elsoul:registry': 'https://dummy.invalid', GH_TOKEN: 'DUMMY-GH', GITHUB_TOKEN: 'DUMMY-GITHUB', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'DUMMY-OIDC' }
  const previousEnvironment = Object.fromEntries(Object.keys(dummyEnvironment).map(name => [name, process.env[name]]))
  Object.assign(process.env, dummyEnvironment)
  let receipt
  try {
    receipt = await observeNpmRelease({ descriptor, planSha256: 'a'.repeat(64), preparation: { sourceCommit, runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', planSha256: 'a'.repeat(64) }, publisher, observer: { runId: '9001', runAttempt: '1', workflowPath: '.github/workflows/release.yml', sourceCommit: 'b'.repeat(40) }, workDir: join(directory, 'work'), outputFile, toolPaths: { node: join(directory, 'node'), npmCli: join(directory, 'npm-cli.js'), python: pythonPath } }, { request, run, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => {} })
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  assert.equal(receipt.state, 'observed')
  assert.equal(receipt.descriptor.observedSha256, archiveSha256)
  assert.equal(receipt.auth.uploadAttempted, false)
  const auditCall = calls.find(call => call[0] === 'run' && call[2].includes('audit') && call[2].includes('signatures'))
  assert.ok(auditCall)
  assert.equal(auditCall[4].NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org')
  assert.equal(auditCall[4].npm_config_registry, 'https://registry.npmjs.org')
  for (const name of Object.keys(dummyEnvironment)) assert.equal(auditCall[4][name], undefined)
  assert.ok(calls.some(call => call[0] === 'run' && call[2].some(value => String(value).includes('require.resolve'))))
  assert.equal(JSON.parse(await readFile(outputFile, 'utf8')).descriptor.observedSRI, integrity)
  brokenEsm = true
  const brokenOutput = join(directory, 'broken-esm.json')
  await mkdir(join(directory, 'broken-work'))
  await assert.rejects(() => observeNpmRelease({ descriptor, planSha256: 'a'.repeat(64), preparation: { sourceCommit, runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', planSha256: 'a'.repeat(64) }, publisher, observer: { runId: '9001', runAttempt: '1', workflowPath: '.github/workflows/release.yml', sourceCommit: 'b'.repeat(40) }, workDir: join(directory, 'broken-work'), outputFile: brokenOutput, toolPaths: { node: join(directory, 'node'), npmCli: join(directory, 'npm-cli.js'), python: pythonPath } }, { request, run, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => {} }), /smoke-import-failed/)
  await assert.rejects(() => readFile(brokenOutput, 'utf8'), { code: 'ENOENT' })
  brokenEsm = false
  const missingClaimsOutput = join(directory, 'missing-claims.json')
  const missingClaimsWork = join(directory, 'missing-claims-work')
  await mkdir(missingClaimsWork)
  await assert.rejects(() => observeNpmRelease({ descriptor, planSha256: 'a'.repeat(64), preparation: { sourceCommit, runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', planSha256: 'a'.repeat(64) }, publisher, observer: { runId: '9001', runAttempt: '1', workflowPath: '.github/workflows/release.yml', sourceCommit: 'b'.repeat(40) }, workDir: missingClaimsWork, outputFile: missingClaimsOutput, toolPaths: { node: join(directory, 'node'), npmCli: join(directory, 'npm-cli.js'), python: pythonPath } }, { request, run: async (command, args, options) => { const result = await run(command, args, options); if (command.includes('python') && args[0] === '-c' && args.at(-1)?.endsWith('.json')) { const missing = JSON.parse(result.stdout); delete missing['1.3.6.1.4.1.57264.1.9']; return { ...result, stdout: JSON.stringify(missing) } } return result }, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => {} }), /workflow-legacy-claim-failed/)
  await assert.rejects(() => readFile(missingClaimsOutput, 'utf8'), { code: 'ENOENT' })
  let lateClock = 0
  const lateOutput = join(directory, 'late.json')
  const lateWork = join(directory, 'late-work')
  await mkdir(lateWork)
  await assert.rejects(() => observeNpmRelease({ descriptor, planSha256: 'a'.repeat(64), preparation: { sourceCommit, runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', planSha256: 'a'.repeat(64) }, publisher, observer: { runId: '9001', runAttempt: '1', workflowPath: '.github/workflows/release.yml', sourceCommit: 'b'.repeat(40) }, workDir: lateWork, outputFile: lateOutput, toolPaths: { node: join(directory, 'node'), npmCli: join(directory, 'npm-cli.js'), python: pythonPath } }, { request, run: async (command, args, options) => { const result = await run(command, args, options); if (args.includes('audit')) lateClock = 600001; return result }, now: () => lateClock, sleep: async () => {} }), /deadline-exceeded/)
  await assert.rejects(() => readFile(lateOutput, 'utf8'), { code: 'ENOENT' })
  await mkdir(join(directory, 'failed-work'))
  const failedOutput = join(directory, 'failed.json')
  await writeFile(failedOutput, `${JSON.stringify({ schemaVersion: 1, kind: 'npm-public-observation', state: 'observed' })}\n`)
  await assert.rejects(() => observeNpmRelease({ descriptor, planSha256: 'a'.repeat(64), preparation: { sourceCommit, runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', planSha256: 'a'.repeat(64) }, publisher, observer: { runId: '9001', runAttempt: '1', workflowPath: '.github/workflows/release.yml', sourceCommit: 'b'.repeat(40) }, workDir: join(directory, 'failed-work'), outputFile: failedOutput, toolPaths: { node: join(directory, 'node'), npmCli: join(directory, 'npm-cli.js'), python: join(directory, 'python') } }, { request: async url => url.endsWith('.tgz') ? { status: 200, headers: {}, body: Buffer.from('changed') } : request(url), run, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => {} }), /archive SHA-256 mismatch/)
  await assert.rejects(() => readFile(failedOutput, 'utf8'), { code: 'ENOENT' })
  const invalidOutput = join(directory, 'invalid.json')
  await writeFile(invalidOutput, `${JSON.stringify({ schemaVersion: 1, kind: 'npm-public-observation', state: 'observed' })}\n`)
  await mkdir(join(directory, 'invalid-work'))
  await assert.rejects(() => observeNpmRelease({ descriptor: { ...descriptor, filename: 'invalid-name.tgz' }, planSha256: 'a'.repeat(64), preparation: { sourceCommit, runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', planSha256: 'a'.repeat(64) }, publisher, observer: { runId: '9001', runAttempt: '1', workflowPath: '.github/workflows/release.yml', sourceCommit: 'b'.repeat(40) }, workDir: join(directory, 'invalid-work'), outputFile: invalidOutput, toolPaths: { node: join(directory, 'node'), npmCli: join(directory, 'npm-cli.js'), python: pythonPath } }, { request: async () => { throw new Error('unexpected request') }, run }), /archive filename mismatch/)
  await assert.rejects(() => readFile(invalidOutput, 'utf8'), { code: 'ENOENT' })
  const unrelatedRoot = join(directory, 'unrelated-root')
  await mkdir(unrelatedRoot)
  const unrelatedOutput = join(unrelatedRoot, 'unrelated.json')
  await writeFile(unrelatedOutput, 'UNRELATED-FILE\n')
  await assert.rejects(() => observeNpmRelease({ descriptor: { ...descriptor, filename: 'invalid-name.tgz' }, planSha256: 'a'.repeat(64), preparation: { sourceCommit, runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', planSha256: 'a'.repeat(64) }, publisher, observer: { runId: '9001', runAttempt: '1', workflowPath: '.github/workflows/release.yml', sourceCommit: 'b'.repeat(40) }, workDir: join(directory, 'invalid-work'), outputFile: unrelatedOutput, toolPaths: { node: join(directory, 'node'), npmCli: join(directory, 'npm-cli.js'), python: pythonPath } }, { request: async () => { throw new Error('unexpected request') }, run }), /share the external work root/)
  assert.equal(await readFile(unrelatedOutput, 'utf8'), 'UNRELATED-FILE\n')
  const foreignRoot = join(directory, 'foreign-root')
  const escapedParent = join(directory, 'escaped-parent')
  await mkdir(foreignRoot)
  await symlink(foreignRoot, escapedParent, 'dir')
  const escapedOutput = join(escapedParent, 'escaped.json')
  await assert.rejects(() => observeNpmRelease({ descriptor: { ...descriptor, filename: 'invalid-name.tgz' }, planSha256: 'a'.repeat(64), preparation: { sourceCommit, runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', planSha256: 'a'.repeat(64) }, publisher, observer: { runId: '9001', runAttempt: '1', workflowPath: '.github/workflows/release.yml', sourceCommit: 'b'.repeat(40) }, workDir: join(directory, 'invalid-work'), outputFile: escapedOutput, toolPaths: { node: join(directory, 'node'), npmCli: join(directory, 'npm-cli.js'), python: pythonPath } }, { request: async () => { throw new Error('unexpected request') }, run }), /share the external work root/)
  await assert.rejects(() => readFile(join(foreignRoot, 'escaped.json'), 'utf8'), { code: 'ENOENT' })
})

test('B1 synthetic npm archive inspection covers two future versions from actual bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-b1-future-npm-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const version of ['0.11.0', '1.2.3']) {
    const packageRoot = join(directory, `root-${version}`)
    await mkdir(join(packageRoot, 'package', 'dist'), { recursive: true })
    await writeFile(join(packageRoot, 'package', 'package.json'), JSON.stringify({ name: '@elsoul/erpc-sdk', version, main: 'dist/index.js' }))
    await writeFile(join(packageRoot, 'package', 'LICENSE'), 'MIT\n')
    await writeFile(join(packageRoot, 'package', 'README.md'), `# ${version}\n`)
    await writeFile(join(packageRoot, 'package', 'dist', 'index.js'), 'module.exports = {}\n')
    const archive = join(directory, `elsoul-erpc-sdk-${version}.tgz`)
    await execFileAsync('tar', ['-czf', archive, '-C', packageRoot, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const files = ['package', 'package/dist', 'package/LICENSE', 'package/README.md', 'package/dist/index.js', 'package/package.json']
    const descriptor = { kind: 'npm', filename: `elsoul-erpc-sdk-${version}.tgz`, name: '@elsoul/erpc-sdk', version, sha256: sha256Hex(await readFile(archive)), files }
    const inspected = await inspectReleaseSetArtifactBytes(descriptor, archive, 'a'.repeat(40))
    assert.equal(inspected.sha256, descriptor.sha256)
    assert.deepEqual(inspected.members.slice().sort(), files.slice().sort())
  }
})

test('B1 carries A3 recomputed ZIP/API binding, member-set, and symlink regressions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-b1-a3-zip-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const consumed = join(directory, 'consumed')
  await mkdir(consumed)
  const binding = Buffer.from('{"kind":"erpc-sdk-release-set-preparation-binding","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n')
  await writeFile(join(consumed, 'release-set-binding.json'), binding)
  const makeZip = async (name, script) => {
    const zip = join(directory, name)
    await execFileAsync('python3', ['-c', script, zip, join(consumed, 'release-set-binding.json')])
    return zip
  }
  const validZip = await makeZip('valid.zip', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.write(sys.argv[2],"release-set-binding.json"); z.close()')
  const metadataFor = async zip => ({ id: 53, name: 'release-set-binding-51-1', expired: false, size_in_bytes: (await stat(zip)).size, digest: `sha256:${await sha256File(zip)}`, archive_download_url: 'https://api.github.com/repos/elsoul/erpc-sdk/actions/artifacts/53/zip' })
  const expected = { zipFile: validZip, metadata: await metadataFor(validZip), expectedId: '53', consumedDirectory: consumed, expectedName: 'release-set-binding-51-1' }
  assert.equal((await verifyReleaseSetArtifactZip(expected)).members[0], 'release-set-binding.json')

  const changedZip = await makeZip('changed.zip', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("release-set-binding.json",b"{\\"kind\\":\\"different\\"}\\n"); z.close()')
  const changedMetadata = await metadataFor(changedZip)
  await assert.rejects(() => verifyReleaseSetArtifactZip({ ...expected, zipFile: changedZip, metadata: changedMetadata }), /member bytes differ/)

  const unrelatedZip = await makeZip('unrelated.zip', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("unrelated.json",b"{}\\n"); z.close()')
  const unrelatedMetadata = await metadataFor(unrelatedZip)
  await assert.rejects(() => verifyReleaseSetArtifactZip({ ...expected, zipFile: unrelatedZip, metadata: unrelatedMetadata }), /members do not equal consumed files/)

  const symlinkZip = await makeZip('symlink.zip', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); i=zipfile.ZipInfo("release-set-binding.json"); i.create_system=3; i.external_attr=(0o120777 << 16); z.writestr(i,"release-set-binding.json"); z.close()')
  const symlinkMetadata = await metadataFor(symlinkZip)
  await assert.rejects(() => verifyReleaseSetArtifactZip({ ...expected, zipFile: symlinkZip, metadata: symlinkMetadata }), /non-regular|symlink/)
})

test('B1 default subprocess timeout kills a child that ignores SIGTERM', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-b1-timeout-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pythonPath = (await execFileAsync('which', ['python3'])).stdout.trim()
  const packageRoot = join(directory, 'package-root')
  await mkdir(join(packageRoot, 'package', 'dist'), { recursive: true })
  await writeFile(join(packageRoot, 'package', 'package.json'), JSON.stringify({ name: '@elsoul/erpc-sdk', version: '1.2.3', main: 'dist/index.js' }))
  await writeFile(join(packageRoot, 'package', 'LICENSE'), 'MIT\n')
  await writeFile(join(packageRoot, 'package', 'README.md'), '# timeout\n')
  await writeFile(join(packageRoot, 'package', 'dist', 'index.js'), 'module.exports = {}\n')
  const archive = join(directory, 'elsoul-erpc-sdk-1.2.3.tgz')
  await execFileAsync('tar', ['-czf', archive, '-C', packageRoot, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const bytes = await readFile(archive)
  const sha256 = sha256Hex(bytes)
  const integrity = `sha512-${(await import('node:crypto')).createHash('sha512').update(bytes).digest('base64')}`
  const descriptor = { kind: 'npm', filename: 'elsoul-erpc-sdk-1.2.3.tgz', name: '@elsoul/erpc-sdk', version: '1.2.3', sha256, files: ['package', 'package/dist', 'package/LICENSE', 'package/README.md', 'package/dist/index.js', 'package/package.json'] }
  const metadata = { name: descriptor.name, version: descriptor.version, dist: { tarball: 'https://registry.npmjs.org/@elsoul/erpc-sdk/-/erpc-sdk-1.2.3.tgz', integrity } }
  const sourceCommit = '4'.repeat(40)
  const root = join(directory, 'work')
  await mkdir(root)
  const workDir = join(root, 'observer-work')
  await mkdir(workDir)
  const outputFile = join(root, 'receipt.json')
  const pidFile = join(root, 'child.pid')
  const termFile = join(root, 'term.received')
  const trap = join(root, 'trap-node')
  await writeFile(trap, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termFile)}, 'received')); setInterval(() => {}, 1000)\n`)
  await chmod(trap, 0o755)
  const input = { descriptor, planSha256: 'a'.repeat(64), preparation: { sourceCommit, runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', planSha256: 'a'.repeat(64) }, publisher: { repository: 'elsoul/erpc-sdk', repositoryId: '1429568627', sourceCommit, workflowPath: '.github/workflows/release.yml', ref: 'refs/heads/main', event: 'workflow_dispatch', environment: 'npm', publisherRunId: '39871872971', publisherAttempt: '1' }, observer: { runId: '9001', runAttempt: '1', workflowPath: '.github/workflows/release.yml', sourceCommit: 'b'.repeat(40) }, workDir, outputFile, toolPaths: { node: trap, npmCli: join(root, 'npm-cli.js'), python: pythonPath } }
  const request = async url => url.endsWith('.tgz') ? { status: 200, headers: {}, body: bytes } : url.endsWith('/1.2.3') ? { status: 200, headers: {}, body: Buffer.from(JSON.stringify(metadata)) } : { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ name: descriptor.name, versions: { '1.2.3': metadata } })) }
  let clockCalls = 0
  await assert.rejects(() => observeNpmRelease(input, { request, now: () => clockCalls++ === 0 ? 0 : 599500 }), /node-version-failed/)
  assert.equal((await readFile(termFile, 'utf8')), 'received')
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0))
  await assert.rejects(() => readFile(outputFile, 'utf8'), { code: 'ENOENT' })
})

test('B1 canonical output boundary preserves a sentinel behind a symlinked repository ancestor', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'erpc-sdk-b1-path-boundary-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const fakeRepo = join(fixture, 'synthetic-repository')
  await mkdir(join(fakeRepo, 'scripts'), { recursive: true })
  await mkdir(join(fakeRepo, 'registry'), { recursive: true })
  await mkdir(join(fakeRepo, 'work'), { recursive: true })
  await cp(new URL('../scripts/verify-release.mjs', import.meta.url), join(fakeRepo, 'scripts', 'verify-release.mjs'))
  await cp(new URL('../registry/ruby-lockfile.mjs', import.meta.url), join(fakeRepo, 'registry', 'ruby-lockfile.mjs'))
  const alias = join(fixture, 'external-alias')
  await symlink(fakeRepo, alias, 'dir')
  const sentinel = join(fakeRepo, 'protected-sentinel.txt')
  await writeFile(sentinel, 'KEEP-UNRELATED-FILE')
  const verifier = await import(pathToFileURL(join(fakeRepo, 'scripts', 'verify-release.mjs')).href)
  await assert.rejects(() => verifier.observeNpmRelease({ workDir: join(alias, 'work'), outputFile: join(alias, 'protected-sentinel.txt'), descriptor: {} }), /outside the repository/)
  assert.equal(await readFile(sentinel, 'utf8'), 'KEEP-UNRELATED-FILE')
})

test('B2 PyPI observer executes wheel/sdist byte, attestation, partial, and consumer paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-b2-pypi-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pythonPath = (await execFileAsync('which', ['python3'])).stdout.trim()
  const wheel = join(directory, 'erpc_sdk-1.2.3-py3-none-any.whl'); const sdist = join(directory, 'erpc_sdk-1.2.3.tar.gz')
  await execFileAsync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("erpc_sdk/__init__.py","__version__ = \'1.2.3\'\\n"); z.writestr("erpc_sdk-1.2.3.dist-info/METADATA","Name: erpc-sdk\\nVersion: 1.2.3\\n"); z.writestr("erpc_sdk-1.2.3.dist-info/LICENSE","MIT\\n"); z.close()', wheel])
  const sdistRoot = join(directory, 'sdist-root', 'erpc_sdk-1.2.3'); await mkdir(sdistRoot, { recursive: true })
  await writeFile(join(sdistRoot, 'PKG-INFO'), 'Name: erpc-sdk\nVersion: 1.2.3\n'); await writeFile(join(sdistRoot, 'LICENSE'), 'MIT\n'); await writeFile(join(sdistRoot, 'erpc_sdk.py'), '__version__ = "1.2.3"\n')
  await execFileAsync('tar', ['-czf', sdist, '-C', join(directory, 'sdist-root'), 'erpc_sdk-1.2.3'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const wheelBytes = await readFile(wheel); const sdistBytes = await readFile(sdist); const wheelSha = sha256Hex(wheelBytes); const sdistSha = sha256Hex(sdistBytes)
  const wheelDescriptor = { kind: 'pypi-wheel', filename: 'erpc_sdk-1.2.3-py3-none-any.whl', name: 'erpc-sdk', version: '1.2.3', sha256: wheelSha, files: ['erpc_sdk/__init__.py', 'erpc_sdk-1.2.3.dist-info/LICENSE', 'erpc_sdk-1.2.3.dist-info/METADATA'] }
  const sdistDescriptor = { kind: 'pypi-sdist', filename: 'erpc_sdk-1.2.3.tar.gz', name: 'erpc-sdk', version: '1.2.3', sha256: sdistSha, files: ['erpc_sdk-1.2.3', 'erpc_sdk-1.2.3/LICENSE', 'erpc_sdk-1.2.3/PKG-INFO', 'erpc_sdk-1.2.3/erpc_sdk.py'] }
  const base = 'https://files.pythonhosted.org/packages/test/'; const metadata = { info: { name: 'erpc-sdk', version: '1.2.3' }, urls: [{ filename: wheelDescriptor.filename, url: `${base}${wheelDescriptor.filename}`, packagetype: 'bdist_wheel', yanked: false, digests: { sha256: wheelSha } }, { filename: sdistDescriptor.filename, url: `${base}${sdistDescriptor.filename}`, packagetype: 'sdist', yanked: false, digests: { sha256: sdistSha } }] }
  const sourceCommit = '4'.repeat(40); const invocation = 'https://github.com/elsoul/erpc-sdk/actions/runs/39871872971/attempts/1'; const claims = { claims: Object.fromEntries([[8, 'https://token.actions.githubusercontent.com'], [9, 'https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main'], [10, sourceCommit], [12, 'https://github.com/elsoul/erpc-sdk'], [13, sourceCommit], [14, 'refs/heads/main'], [15, '1429568627'], [18, 'https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main'], [19, sourceCommit], [20, 'workflow_dispatch'], [21, invocation]].map(([key, value]) => [`1.3.6.1.4.1.57264.1.${key}`, value])), publisher: { kind: 'GitHub', repository: 'elsoul/erpc-sdk', workflow: 'release.yml', environment: 'pypi' } }
  let partialMode = false; let sdistOnly = false; let retryDownload = false; const retryStatuses = []; const request = async url => {
    if (url.endsWith('/json')) return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(partialMode ? { ...metadata, urls: [sdistOnly ? metadata.urls[1] : metadata.urls[0]] } : metadata)) }
    if (url.endsWith('.whl')) { const status = retryDownload ? 404 : 200; if (retryDownload) retryDownload = false; retryStatuses.push(status); return { status, headers: {}, body: status === 200 ? wheelBytes : Buffer.from('{}') } }
    if (url.endsWith('.tar.gz')) return { status: 200, headers: {}, body: sdistBytes }
    return { status: 200, headers: {}, body: Buffer.from('{}') }
  }
  const run = async (command, args, options = {}) => {
    if (args[0] === '--version') return { exitCode: 0, stdout: 'Python 3.12.11\n', stderr: '' }
    if (args[0] === '-m' && args[1] === 'pypi_attestations') return { exitCode: 0, stdout: '', stderr: '' }
    if (args[0] === '-c' && args[1]?.includes('import sys,importlib.metadata')) return { exitCode: 0, stdout: '3.12.11\n0.0.30\n46.0.3\n', stderr: '' }
    if (args[0] === '-c' && args[1]?.includes('Provenance')) { const filename = args.at(-2).includes('whl') ? wheelDescriptor.filename : sdistDescriptor.filename; return { exitCode: 0, stdout: JSON.stringify({ ...claims, subject: { name: filename, digest: { sha256: filename.endsWith('.whl') ? wheelSha : sdistSha } } }), stderr: '' } }
    if (args[0] === '-m' && args[1] === 'venv') { await mkdir(join(args[2], 'bin'), { recursive: true }); await mkdir(join(args[2], 'lib', 'python3.12', 'site-packages', 'erpc_sdk'), { recursive: true }); await writeFile(join(args[2], 'lib', 'python3.12', 'site-packages', 'erpc_sdk', '__init__.py'), '__version__ = "1.2.3"\n'); return { exitCode: 0, stdout: '', stderr: '' } }
    if (args[0] === '-m' && args[1] === 'build' && args.includes('--version')) return { exitCode: 0, stdout: 'build 1.6.0\n', stderr: '' }
    if (args[0] === '-m' && args[1] === 'build') { const outdir = args[args.indexOf('--outdir') + 1]; await cp(wheel, join(outdir, wheelDescriptor.filename)); return { exitCode: 0, stdout: '', stderr: '' } }
    if (args[0] === '-c' && args[1]?.includes('import erpc_sdk')) return { exitCode: 0, stdout: JSON.stringify({ origin: join(command, '..', '..', 'lib', 'python3.12', 'site-packages', 'erpc_sdk', '__init__.py'), version: '1.2.3' }) + '\n', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const publisher = { repository: 'elsoul/erpc-sdk', repositoryId: '1429568627', sourceCommit, workflowPath: '.github/workflows/release.yml', ref: 'refs/heads/main', event: 'workflow_dispatch', environment: 'pypi', publisherRunId: '39871872971', publisherAttempt: '1' }
  const makeInput = (name, descriptors = { 'pypi-wheel': wheelDescriptor, 'pypi-sdist': sdistDescriptor }) => ({ descriptors, planSha256: 'a'.repeat(64), preparation: { sourceCommit, runId: '51', runAttempt: '1', artifactId: '52', bindingArtifactId: '53', planSha256: 'a'.repeat(64) }, publishers: { [wheelDescriptor.filename]: publisher, [sdistDescriptor.filename]: publisher }, observer: { runId: '9001', runAttempt: '1', workflowPath: '.github/workflows/release.yml', sourceCommit: 'b'.repeat(40) }, workDir: join(directory, `${name}-work`), outputFile: join(directory, `${name}.json`), toolPaths: { python: pythonPath } })
  await mkdir(join(directory, 'complete-work')); const receipt = await observePyPIRelease(makeInput('complete'), { request, run, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => {} }); assert.equal(receipt.state, 'observed'); assert.equal(receipt.files.length, 2)
  partialMode = true; await mkdir(join(directory, 'partial-work')); const partial = await observePyPIRelease(makeInput('partial'), { request, run, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => {} }); assert.equal(partial.state, 'partial'); await assert.rejects(() => readFile(join(directory, 'partial.json'), 'utf8'), { code: 'ENOENT' })
  const approvedWheelSha = metadata.urls[0].digests.sha256
  metadata.urls[0].digests.sha256 = 'f'.repeat(64)
  await mkdir(join(directory, 'conflict-work'))
  await assert.rejects(() => observePyPIRelease(makeInput('conflict'), { request, run, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => {} }), /metadata digest conflicts/)
  metadata.urls[0].digests.sha256 = approvedWheelSha
  sdistOnly = true; await mkdir(join(directory, 'sdist-only-work')); const sdistPartial = await observePyPIRelease(makeInput('sdist-only'), { request, run, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => {} }); assert.equal(sdistPartial.state, 'partial'); assert.equal(sdistPartial.consumers.sdist.exitCode, 0)
  sdistOnly = false; partialMode = false; await mkdir(join(directory, 'missing-publisher-work')); await assert.rejects(() => observePyPIRelease({ ...makeInput('missing-publisher'), publishers: { [sdistDescriptor.filename]: publisher } }, { request, run, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => {} }), /publisher-context-missing/)
  retryDownload = true; retryStatuses.length = 0; let retrySleeps = 0; await mkdir(join(directory, 'retry-work')); const retryReceipt = await observePyPIRelease(makeInput('retry'), { request, run, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => { retrySleeps += 1 } }); assert.equal(retryReceipt.state, 'observed'); assert.deepEqual(retryStatuses, [404, 200]); assert.equal(retrySleeps >= 1, true)
  claims.claims['1.3.6.1.4.1.57264.1.23'] = 'npm'; await mkdir(join(directory, 'wrong-environment-work')); await assert.rejects(() => observePyPIRelease(makeInput('wrong-environment'), { request, run, now: (() => { let value = 0; return () => value += 1 })(), sleep: async () => {} }), /environment claim/)
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
  const npmModeEnvironment = { RELEASE_SET_NPM_OUTPUT_FILE: '/tmp/erpc-sdk-npm-mode-test.json', RELEASE_SET_NPM_WORK_DIR: '/tmp/erpc-sdk-npm-mode-test-work' }
  await mkdir(npmModeEnvironment.RELEASE_SET_NPM_WORK_DIR, { recursive: true })
  const pypiModeEnvironment = { RELEASE_SET_PYPI_OUTPUT_FILE: '/tmp/erpc-sdk-pypi-mode-test.json', RELEASE_SET_PYPI_WORK_DIR: '/tmp/erpc-sdk-pypi-mode-test-work' }
  await mkdir(pypiModeEnvironment.RELEASE_SET_PYPI_WORK_DIR, { recursive: true })
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
    [['--release-set-npm-observe', '--unknown'], npmModeEnvironment],
    [['--release-set-npm-observe', '--release-set-npm-observe'], npmModeEnvironment],
    [['--release-set-pypi-observe', '--unknown'], pypiModeEnvironment],
    [['--release-set-pypi-observe', '--release-set-pypi-observe'], pypiModeEnvironment],
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

test('checkpoint A leaves future orchestration unavailable and preserves baseline action pins', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const baseline = (await execFileAsync('git', ['show', 'b42b8b397354f940d2edbf52fd76f15519661c77:.github/workflows/release.yml'], { cwd: root.pathname })).stdout
  assert.equal(workflow, baseline)
  assert.doesNotMatch(workflow, /release-set-(?:prepare|publish|observe)/)
  for (const match of workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) assert.match(match[1], /^[0-9a-f]{40}$/)
})

test('recovery workflow is manual, M-bound, read-only for registries, and keeps the fifteen-asset boundary', async () => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const expectedWorkflow = (await execFileAsync('git', ['cat-file', 'blob', 'd8e3b3ac1f3257123beca4462e9317f1f5fa9514'], { cwd: root.pathname })).stdout
  const expectedVerifier = (await execFileAsync('git', ['cat-file', 'blob', '61641cd9a4ce597b8abc7278726a3ad219a670b4'], { cwd: root.pathname })).stdout
  // Recovery remains bound to immutable M blobs while the normal verifier
  // evolves through staged P1 checkpoints.
  assert.match(expectedWorkflow, /workflow_dispatch:/)
  assert.match(expectedVerifier, /validateFoundationPlan/)
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
  const outputDirectory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-guard-output-'))
  t.after(() => Promise.all([rm(directory, { recursive: true, force: true }), rm(outputDirectory, { recursive: true, force: true })]))
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
  const outputFile = join(outputDirectory, 'output')
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
    'pwd > "$GEM_PWD_FILE"\n' +
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
    GEM_PWD_FILE: join(directory, 'gem-pwd'),
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
  assert.equal((await readFile(join(directory, 'gem-pwd'), 'utf8')).trim(), join(directory, 'ruby-consumer-3.4'))
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

test('recovery npm metadata block executes exact/full normalization and fails closed on hostile HTTP fixtures', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const block = extractWorkflowRunBlock(workflow, 'Download exact npm metadata with 404-only bounded observation')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-npm-metadata-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const exactFile = join(directory, 'exact.json')
  const fullFile = join(directory, 'full.json')
  const responseFile = join(directory, 'npm-version.json')
  const fullResponseFile = join(directory, 'npm-packument.json')
  const curl = join(directory, 'curl')
  await writeFile(curl, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const output = args[args.indexOf('--output') + 1]
const url = args.at(-1)
const full = !url.endsWith('/0.9.1')
if (process.env.NPM_CASE === 'transport') { fs.writeFileSync(output, ''); process.exit(7) }
const caseName = process.env.NPM_CASE
const status = full ? (caseName === 'exact404-full200' || caseName === 'missing-selected' ? 200 : 200) : (caseName === 'exact404-full200' || caseName === 'missing-selected' ? 404 : caseName === 'http503' ? 503 : 200)
const file = full ? process.env.FULL_FIXTURE : process.env.EXACT_FIXTURE
fs.writeFileSync(output, fs.readFileSync(file))
process.stdout.write(String(status))
`)
  await chmod(curl, 0o755)
  const canonicalTarball = 'https://registry.npmjs.org/@elsoul/erpc-sdk/-/erpc-sdk-0.9.1.tgz'
  const metadata = { name: '@elsoul/erpc-sdk', version: '0.9.1', dist: { integrity: 'sha512-AAAA', tarball: canonicalTarball } }
  const full = { name: '@elsoul/erpc-sdk', versions: { '0.9.1': metadata } }
  const runCase = async (caseName, exact, packument, succeeds) => {
    await writeFile(exactFile, JSON.stringify(exact))
    await writeFile(fullFile, JSON.stringify(packument))
    const result = execFileAsync('bash', ['-c', `set -euo pipefail\n${block}`], {
      cwd: new URL('../', import.meta.url).pathname,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        NPM_CASE: caseName,
        EXACT_FIXTURE: exactFile,
        FULL_FIXTURE: fullFile,
        RESPONSE_FILE: responseFile,
        FULL_RESPONSE_FILE: fullResponseFile,
        RUNNER_TEMP: directory,
        RELEASE_USER_AGENT,
        EXPECTED_VERSION: '0.9.1',
        EXPECTED_REPOSITORY: 'elsoul/erpc-sdk',
      },
    })
    if (succeeds) await result
    else await assert.rejects(result)
  }
  await runCase('exact200-full200', metadata, full, true)
  await runCase('exact404-full200', {}, full, true)
  await runCase('missing-selected', {}, { name: '@elsoul/erpc-sdk', versions: {} }, false)
  await runCase('malformed200', { malformed: true }, full, false)
  await runCase('conflicting200', metadata, { name: '@elsoul/erpc-sdk', versions: { '0.9.1': { ...metadata, dist: { ...metadata.dist, integrity: 'sha512-BBBB' } } } }, false)
  await runCase('http503', metadata, full, false)
  await runCase('transport', metadata, full, false)
})

test('recovery npm provenance blocks execute cryptographic claim and SLSA policy negatives', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const claimsCode = extractWorkflowHeredoc(workflow, 'python - "$RUNNER_TEMP/npm-audit.json" "$RUNNER_TEMP/npm-certificate-claims.json" <<\'PY\'', 'PY')
  const proofCode = extractWorkflowHeredoc(workflow, 'node --input-type=module - "$RUNNER_TEMP/npm-audit.json" "$RUNNER_TEMP/npm-proof.json" <<\'NODE\'', 'NODE')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-npm-provenance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pythonPath = join(directory, 'claims.py')
  const proofPath = join(directory, 'proof.mjs')
  await writeFile(pythonPath, claimsCode)
  await writeFile(proofPath, proofCode)
  let python = 'python3'
  try { await execFileAsync(python, ['-c', 'import cryptography']) } catch {
    const venv = join(directory, 'venv')
    await execFileAsync('python3', ['-m', 'venv', venv])
    python = join(venv, 'bin', 'python')
    await execFileAsync(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'cryptography==46.0.3'])
  }
  const source = '4677d67d14c8fbb17ada3ba824d1623180c6b4d9'
  const expectedWorkflow = 'https://github.com/elsoul/erpc-sdk/.github/workflows/release.yml@refs/heads/main'
  const makeCertificate = async ({ sourceClaim = source, workflowClaim = expectedWorkflow, invocation = 'https://github.com/elsoul/erpc-sdk/actions/runs/39871872971/attempts/1' } = {}) => {
    const config = join(directory, `cert-${Math.random().toString(16).slice(2)}.cnf`)
    const key = `${config}.key`
    const cert = `${config}.der`
    const issuer = Buffer.from('https://token.actions.githubusercontent.com').toString('hex')
    await writeFile(config, `[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = claims\n[dn]\nCN = Fulcio fixture\n[claims]\n1.3.6.1.4.1.57264.1.1 = DER:${issuer}\n1.3.6.1.4.1.57264.1.9 = ASN1:UTF8String:${workflowClaim}\n1.3.6.1.4.1.57264.1.10 = ASN1:UTF8String:${sourceClaim}\n1.3.6.1.4.1.57264.1.12 = ASN1:UTF8String:https://github.com/elsoul/erpc-sdk\n1.3.6.1.4.1.57264.1.13 = ASN1:UTF8String:${sourceClaim}\n1.3.6.1.4.1.57264.1.14 = ASN1:UTF8String:refs/heads/main\n1.3.6.1.4.1.57264.1.15 = ASN1:UTF8String:1429568627\n1.3.6.1.4.1.57264.1.18 = ASN1:UTF8String:${workflowClaim}\n1.3.6.1.4.1.57264.1.19 = ASN1:UTF8String:${sourceClaim}\n1.3.6.1.4.1.57264.1.20 = ASN1:UTF8String:workflow_dispatch\n1.3.6.1.4.1.57264.1.21 = ASN1:UTF8String:${invocation}\n`)
    await execFileAsync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-outform', 'DER', '-days', '1', '-config', config], { maxBuffer: 1024 * 1024 })
    return (await readFile(cert)).toString('base64')
  }
  const auditFile = join(directory, 'npm-audit.json')
  const claimsFile = join(directory, 'npm-certificate-claims.json')
  const runClaims = async (certificate, succeeds = true) => {
    await writeFile(auditFile, JSON.stringify({ invalid: [], missing: [], verified: [{ name: '@elsoul/erpc-sdk', version: '0.9.1', registry: 'https://registry.npmjs.org', attestationBundles: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { verificationMaterial: { certificate: { rawBytes: certificate } } } }] }] }))
    const result = execFileAsync(python, [pythonPath, auditFile, claimsFile], { env: { ...process.env, SOURCE_M: source } })
    if (succeeds) await result
    else await assert.rejects(result)
  }
  await runClaims(await makeCertificate())
  await runClaims(await makeCertificate({ sourceClaim: 'c'.repeat(40) }), false)
  await runClaims(await makeCertificate({ workflowClaim: expectedWorkflow.replace('release.yml', 'other.yml') }), false)
  await runClaims(await makeCertificate({ invocation: 'https://github.com/elsoul/erpc-sdk/actions/runs/999/attempts/1' }), false)
  await runClaims('not-a-certificate', false)

  const archive = join(directory, 'npm.tgz')
  const archiveBytes = Buffer.from('approved npm archive')
  await writeFile(archive, archiveBytes)
  const archiveSha512 = (await import('node:crypto')).createHash('sha512').update(archiveBytes).digest('hex')
  const baseProvenance = {
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'pkg:npm/%40elsoul/erpc-sdk@0.9.1', digest: { sha512: archiveSha512 } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository: 'https://github.com/elsoul/erpc-sdk', path: '.github/workflows/release.yml', ref: 'refs/heads/main' } }, internalParameters: { github: { repository_id: '1429568627', event_name: 'workflow_dispatch' } }, resolvedDependencies: [{ digest: { gitCommit: source } }] }, runDetails: { metadata: { invocationId: 'https://github.com/elsoul/erpc-sdk/actions/runs/39871872971/attempts/1' } } },
  }
  const metadataFile = join(directory, 'npm-version.json')
  await writeFile(metadataFile, JSON.stringify({ dist: { integrity: 'sha512-AAAA' } }))
  await writeFile(claimsFile, JSON.stringify({ '1.3.6.1.4.1.57264.1.8': 'https://token.actions.githubusercontent.com' }))
  const runProof = async (mutate, succeeds = true) => {
    const provenance = mutate(structuredClone(baseProvenance))
    const audit = { invalid: [], missing: [], verified: [{ name: '@elsoul/erpc-sdk', version: '0.9.1', registry: 'https://registry.npmjs.org', attestationBundles: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(provenance)).toString('base64') } } }] }] }
    await writeFile(auditFile, JSON.stringify(audit))
    const result = execFileAsync(process.execPath, [proofPath, auditFile, join(directory, 'npm-proof.json')], { env: { ...process.env, RUNNER_TEMP: directory, NPM_FILE: archive, SOURCE_M: source, EXPECTED_REPOSITORY: 'elsoul/erpc-sdk', PLAN_SHA256: 'a'.repeat(64), PREPARED_RUN_ID: '39862319930', PREPARED_RUN_ATTEMPT: '1', PREPARED_ARTIFACT_ID: '12461868771', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1' } })
    if (succeeds) await result
    else await assert.rejects(result)
  }
  await runProof(value => value)
  await runProof(value => { value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'c'.repeat(40); return value }, false)
  await runProof(value => { value.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml'; return value }, false)
  await runProof(value => { value.subject[0].digest.sha512 = '0'.repeat(128); return value }, false)
  await runProof(value => { value.predicate.runDetails.metadata.invocationId = 'https://github.com/elsoul/erpc-sdk/actions/runs/999/attempts/1'; return value }, false)
})

test('recovery PyPI provenance block executes its crypto verifier and rejects malformed evidence', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const code = extractWorkflowHeredoc(workflow, 'python - "$DOWNLOADS_FILE" "$RUNNER_TEMP" <<\'PY\'', 'PY')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-pypi-provenance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = join(directory, 'pypi-check.py')
  const downloads = join(directory, 'downloads.tsv')
  const artifact = join(directory, 'erpc_sdk-0.9.1-py3-none-any.whl')
  const provenance = `${artifact}.provenance.json`
  await writeFile(script, code)
  await writeFile(artifact, 'not-a-wheel')
  await writeFile(provenance, '{}')
  await writeFile(downloads, `${artifact.split('/').pop()}\thttps://files.pythonhosted.org/packages/example\t${'0'.repeat(64)}\n`)
  let python = 'python3'
  try { await execFileAsync(python, ['-c', 'import pypi_attestations']) } catch {
    const venv = join(directory, 'venv')
    await execFileAsync('python3', ['-m', 'venv', venv])
    python = join(venv, 'bin', 'python')
    await execFileAsync(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'pypi-attestations==0.0.30', 'cryptography==46.0.3'])
  }
  await assert.rejects(
    execFileAsync(python, [script, downloads, directory], { env: { ...process.env, SOURCE_M: '4677d67d14c8fbb17ada3ba824d1623180c6b4d9' } }),
  )
})

test('recovery aggregate metadata block rejects wrong run/head/observer and missing Ruby artifacts', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const code = extractWorkflowHeredoc(workflow, 'node --input-type=module - "$RUNNER_TEMP/current-artifacts.json" "$RUNNER_TEMP/proof-downloads" <<\'NODE\'', 'NODE')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-artifact-metadata-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = join(directory, 'metadata.mjs')
  const artifactFile = join(directory, 'artifacts.json')
  const proofRoot = join(directory, 'proof-downloads')
  await writeFile(script, code)
  const runId = '777'
  const attempt = '1'
  const shaValue = 'c'.repeat(40)
  const names = [
    `foundation-recovery-context-${runId}-${attempt}`,
    `foundation-proof-npm-${runId}`,
    `foundation-proof-pypi-${runId}`,
    `foundation-proof-rubygems-${runId}`,
    `foundation-proof-rust-${runId}`,
    `foundation-proof-tags-${runId}`,
    `foundation-proof-go-${runId}`,
    `foundation-ruby-consumer-${runId}-3.1`,
    `foundation-ruby-consumer-${runId}-3.4`,
  ]
  const artifacts = names.map((name, index) => ({ name, id: index + 1, expired: false, digest: `sha256:${String(index + 1).padStart(64, '0')}`, workflow_run: { id: Number(runId), head_sha: shaValue } }))
  const writeProof = async (relative, content) => { const path = join(proofRoot, relative); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, content) }
  await writeProof('ruby-3.1/ruby-consumer-3.1.json', JSON.stringify({ ruby: '3.1.6', sdk: '/tmp/gem-home-3.1/gems/erpc-sdk', base64: '/tmp/gem-home-3.1/gems/base64', digest_keccak: '/tmp/gem-home-3.1/gems/digest-keccak' }))
  await writeProof('ruby-3.4/ruby-consumer-3.4.json', JSON.stringify({ ruby: '3.4.7', sdk: '/tmp/gem-home-3.4/gems/erpc-sdk', base64: '/tmp/gem-home-3.4/gems/base64', digest_keccak: '/tmp/gem-home-3.4/gems/digest-keccak' }))
  for (const [kind, file] of [['npm', 'npm/npm-proof.json'], ['pypi', 'pypi/pypi-proof.json'], ['rubygems', 'rubygems/rubygems-proof.json'], ['rust', 'rust/rust-proof.json'], ['tags', 'tags/tag-proof.json'], ['go', 'go/go-proof.json']]) await writeProof(file, JSON.stringify({ kind, observerRunId: runId, observerAttempt: attempt }))
  const context = join(directory, 'recovery-context')
  await mkdir(context, { recursive: true })
  await writeFile(join(context, 'recovery-context.json'), '{}')
  await writeFile(artifactFile, JSON.stringify({ artifacts }))
  const runMetadata = async (mutate = value => value, succeeds = true) => {
    const fixture = mutate(JSON.parse(await readFile(artifactFile, 'utf8')))
    await writeFile(artifactFile, JSON.stringify(fixture))
    const result = execFileAsync(process.execPath, [script, artifactFile, proofRoot], { env: { ...process.env, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: shaValue } })
    if (succeeds) await result
    else await assert.rejects(result)
    await writeFile(artifactFile, JSON.stringify({ artifacts }))
  }
  await runMetadata()
  await runMetadata(value => ({ artifacts: value.artifacts.map(item => item.name.includes('ruby-consumer') ? { ...item, workflow_run: { ...item.workflow_run, head_sha: 'd'.repeat(40) } } : item) }), false)
  await runMetadata(value => ({ artifacts: value.artifacts.map(item => item.name.includes('proof-npm') ? { ...item, digest: null } : item) }), false)
  await writeProof('npm/npm-proof.json', JSON.stringify({ kind: 'npm', observerRunId: 'wrong', observerAttempt: attempt }))
  await runMetadata(value => value, false)
})

test('recovery artifact ZIP binding compares consumed bytes and fails on changed members or digest', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const fragment = extractWorkflowFragment(workflow, 'Verify current receipt/context artifact metadata and both Ruby consumers', 'verified_root="$RUNNER_TEMP/verified-artifacts"', 'node --input-type=module - "$RUNNER_TEMP/current-artifacts.json"')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-artifact-zip-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const proofRoot = join(directory, 'proof-downloads')
  const contextRoot = join(directory, 'recovery-context')
  await mkdir(contextRoot, { recursive: true })
  await writeFile(join(contextRoot, 'recovery-context.json'), 'context bytes')
  const members = [
    ['foundation-recovery-context-777-1', 'recovery-context.json', join(contextRoot, 'recovery-context.json')],
    ['foundation-proof-npm-777', 'npm-proof.json', join(proofRoot, 'npm/npm-proof.json')],
    ['foundation-proof-pypi-777', 'pypi-proof.json', join(proofRoot, 'pypi/pypi-proof.json')],
    ['foundation-proof-rubygems-777', 'rubygems-proof.json', join(proofRoot, 'rubygems/rubygems-proof.json')],
    ['foundation-proof-rust-777', 'rust-proof.json', join(proofRoot, 'rust/rust-proof.json')],
    ['foundation-proof-tags-777', 'tag-proof.json', join(proofRoot, 'tags/tag-proof.json')],
    ['foundation-proof-go-777', 'go-proof.json', join(proofRoot, 'go/go-proof.json')],
    ['foundation-ruby-consumer-777-3.1', 'ruby-consumer-3.1.json', join(proofRoot, 'ruby-3.1/ruby-consumer-3.1.json')],
    ['foundation-ruby-consumer-777-3.4', 'ruby-consumer-3.4.json', join(proofRoot, 'ruby-3.4/ruby-consumer-3.4.json')],
  ]
  for (const [, member, consumed] of members) { await mkdir(join(consumed, '..'), { recursive: true }); await writeFile(consumed, member) }
  const zipRoot = join(directory, 'zips')
  await mkdir(zipRoot)
  const artifacts = []
  for (const [name, member, consumed] of members) {
    const zipPath = join(zipRoot, `${name}.zip`)
    await execFileAsync('python3', ['-c', 'import sys, zipfile; z=zipfile.ZipFile(sys.argv[1], "w"); z.write(sys.argv[2], arcname=sys.argv[3]); z.close()', zipPath, consumed, member])
    artifacts.push({ name, id: artifacts.length + 1, digest: `sha256:${sha256Hex(await readFile(zipPath))}`, expired: false, workflow_run: { id: 777, head_sha: 'c'.repeat(40) } })
  }
  const metadata = join(directory, 'current-artifacts.json')
  await writeFile(metadata, JSON.stringify({ artifacts }))
  const curl = join(directory, 'curl')
  await writeFile(curl, '#!/usr/bin/env node\nconst fs=require("node:fs"); const a=process.argv.slice(2); const out=a[a.indexOf("--output")+1]; const id=Number(a.at(-1).split("/").at(-2)); fs.copyFileSync(process.env.ZIP_ROOT + "/" + process.env.ZIP_NAMES.split(",")[id-1] + ".zip", out)\n')
  await chmod(curl, 0o755)
  const gh = join(directory, 'gh')
  await writeFile(gh, '#!/bin/sh\ncat "$CURRENT_ARTIFACTS_FILE"\n')
  await chmod(gh, 0o755)
  const run = async () => {
    await rm(join(directory, 'verified-artifacts'), { recursive: true, force: true })
    return execFileAsync('bash', ['-c', `set -euo pipefail\n${fragment}`], { cwd: new URL('../', import.meta.url).pathname, env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, RUNNER_TEMP: directory, CURRENT_ARTIFACTS_FILE: metadata, ZIP_ROOT: zipRoot, ZIP_NAMES: members.map(item => item[0]).join(','), EXPECTED_REPOSITORY: 'elsoul/erpc-sdk', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'c'.repeat(40), GH_TOKEN: 'fixture', RELEASE_USER_AGENT } })
  }
  await run()
  await writeFile(join(proofRoot, 'npm/npm-proof.json'), 'changed member')
  await assert.rejects(run())
  await writeFile(join(proofRoot, 'npm/npm-proof.json'), 'npm-proof.json')
  artifacts[0].digest = 'sha256:bad'
  await writeFile(metadata, JSON.stringify({ artifacts }))
  await assert.rejects(run())
})

test('recovery Go proof block exercises transitive checksum preparation and hostile ZIP/inventory/origin fixtures', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const block = extractWorkflowRunBlock(workflow, 'Verify Go proxy, checksum, origin, and exact module members')
  assert.match(block, /go mod download all/)
  const pythonCode = extractWorkflowHeredoc(workflow, 'python - "$RUNNER_TEMP/go-download.json" "$RUNNER_TEMP/go-direct-download.json" "$SOURCE_M" <<\'PY\'', 'PY')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-go-proof-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const module = 'github.com/elsoul/erpc-sdk/packages/go'
  const version = 'v0.9.1'
  const commit = '4677d67d14c8fbb17ada3ba824d1623180c6b4d9'
  const sourceFiles = { 'go.mod': `module ${module}\n\ngo 1.22\n`, LICENSE: 'MIT\n' }
  const inventoryFiles = Object.entries(sourceFiles).map(([path, contents]) => ({ path, sha256: sha256Hex(contents) }))
  const inventory = { files: inventoryFiles, inventorySha256: sha256Hex(canonicalJson(inventoryFiles)) }
  const planDir = join(directory, 'sdk-foundation-bundle')
  await mkdir(planDir)
  await writeFile(join(planDir, 'foundation-plan.json'), JSON.stringify({ goInventory: inventory }))
  const info = join(directory, 'module.info'); const gomod = join(directory, 'module.mod'); const moduleDir = join(directory, 'module-dir')
  await mkdir(moduleDir); await writeFile(info, '{}'); await writeFile(gomod, sourceFiles['go.mod'])
  const checksum = `h1:${Buffer.from('a'.repeat(32)).toString('base64')}`
  const expectedOrigin = { VCS: 'git', URL: 'https://github.com/elsoul/erpc-sdk', Hash: commit, Ref: 'refs/tags/packages/go/v0.9.1', Subdir: 'packages/go' }
  const makeZip = async (members, name) => {
    const zipPath = join(directory, name)
    const fixture = join(directory, `${name}.files`); await mkdir(fixture, { recursive: true })
    for (const [member, contents] of members) { const file = join(fixture, member.replaceAll('/', '_')); await writeFile(file, contents) }
    const jsonMembers = JSON.stringify(members)
    await execFileAsync('python3', ['-c', 'import json,sys,zipfile; path,root,members=sys.argv[1:]; members=json.loads(members); z=zipfile.ZipFile(path,"w"); [z.writestr(name, contents) for name,contents in members]; z.close()', zipPath, fixture, jsonMembers])
    return zipPath
  }
  const validMembers = Object.entries(sourceFiles).map(([path, contents]) => [`${module}@${version}/${path}`, contents])
  const makeReceipt = (zip, origin = expectedOrigin) => ({ Path: module, Version: version, Info: info, GoMod: gomod, Zip: zip, Dir: moduleDir, Sum: checksum, GoModSum: checksum, Origin: origin, Reuse: false })
  const runPython = async (result, direct = result, succeeds = true) => {
    const resultFile = join(directory, 'go-download.json'); const directFile = join(directory, 'go-direct-download.json')
    await writeFile(resultFile, JSON.stringify(result)); await writeFile(directFile, JSON.stringify(direct))
    const script = join(directory, 'go-proof.py'); await writeFile(script, pythonCode)
    const command = execFileAsync('python3', [script, resultFile, directFile, commit], { cwd: directory, env: { ...process.env, RUNNER_TEMP: directory, MODULE: module, VERSION: version, SOURCE_M: commit, EXPECTED_REPOSITORY: 'elsoul/erpc-sdk', PLAN_SHA256: 'a'.repeat(64), PREPARED_RUN_ID: '39862319930', PREPARED_RUN_ATTEMPT: '1', PREPARED_ARTIFACT_ID: '12461868771', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1' } })
    if (succeeds) await command
    else await assert.rejects(command)
  }
  const validZip = await makeZip(validMembers, 'valid.zip')
  await runPython(makeReceipt(validZip))
  const duplicateZip = await makeZip([...validMembers, validMembers[0]], 'duplicate.zip')
  await runPython(makeReceipt(duplicateZip), makeReceipt(duplicateZip), false)
  const unsafeZip = await makeZip([[`${module}@${version}/../escape`, 'bad'], ...validMembers], 'unsafe.zip')
  await runPython(makeReceipt(unsafeZip), makeReceipt(unsafeZip), false)
  const wrongInventory = await makeZip([[`${module}@${version}/go.mod`, 'wrong'], [`${module}@${version}/LICENSE`, 'MIT\n']], 'wrong-inventory.zip')
  await runPython(makeReceipt(wrongInventory), makeReceipt(wrongInventory), false)
  await runPython(makeReceipt(validZip, { ...expectedOrigin, Hash: 'c'.repeat(40) }), makeReceipt(validZip, { ...expectedOrigin, Hash: 'c'.repeat(40) }), false)
})

test('recovery Go disposable consumer reproduces the old failure and passes the extracted tidy/download-all recipe on a portable offline proxy', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const fragment = extractWorkflowFragment(workflow, 'Verify Go proxy, checksum, origin, and exact module members', 'cat > "$RUNNER_TEMP/go-consumer/main.go"')
  assert.match(fragment, /go mod tidy/)
  assert.match(fragment, /go mod download all/)
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-go-consumer-'))
  t.after(async () => { await execFileAsync('chmod', ['-R', 'u+rwX', directory]).catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  const proxy = join(directory, 'proxy')
  const consumer = join(directory, 'go-consumer')
  await mkdir(consumer, { recursive: true })
  const module = 'github.com/elsoul/erpc-sdk/packages/go'
  const version = 'v0.9.1'
  const transitive = 'fixture.invalid/transitive'
  const transitiveVersion = 'v0.1.0'
  const moduleGoMod = `module ${module}\n\ngo 1.22\n\nrequire ${transitive} ${transitiveVersion}\n`
  const moduleSource = `package erpc\nimport _ "${transitive}"\n`
  const transitiveGoMod = `module ${transitive}\n\ngo 1.22\n`
  const transitiveSource = 'package transitive\nvar Value = 1\n'
  const moduleModFile = join(directory, 'module-mod'); const transitiveModFile = join(directory, 'transitive-mod')
  await writeFile(moduleModFile, moduleGoMod); await writeFile(transitiveModFile, transitiveGoMod)
  const writeProxyModuleWithMod = async (name, moduleVersion, modFile, sourceName, source) => {
    const versionDirectory = join(proxy, name, '@v')
    await mkdir(versionDirectory, { recursive: true })
    await writeFile(join(versionDirectory, 'list'), `${moduleVersion}\n`)
    await writeFile(join(versionDirectory, `${moduleVersion}.info`), JSON.stringify({ Version: moduleVersion, Time: '2026-01-01T00:00:00Z' }))
    await writeFile(join(versionDirectory, `${moduleVersion}.mod`), await readFile(modFile))
    const sourceFile = join(directory, `${sourceName}-${moduleVersion}.go`)
    await writeFile(sourceFile, source)
    await execFileAsync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], "w"); z.write(sys.argv[2], sys.argv[3]); z.write(sys.argv[4], sys.argv[5]); z.close()', join(versionDirectory, `${moduleVersion}.zip`), modFile, `${name}@${moduleVersion}/go.mod`, sourceFile, `${name}@${moduleVersion}/${sourceName}`])
  }
  await writeProxyModuleWithMod(module, version, moduleModFile, 'erpc.go', moduleSource)
  await writeProxyModuleWithMod(transitive, transitiveVersion, transitiveModFile, 'transitive.go', transitiveSource)
  await writeFile(join(consumer, 'go.mod'), `module example.invalid/consumer\n\ngo 1.22\n\nrequire ${module} ${version}\n`)
  await writeFile(join(consumer, 'main.go'), `package main\nimport _ "${module}"\nfunc main() {}\n`)
  const consumerEnv = { ...process.env, RUNNER_TEMP: directory, MODULE: module, VERSION: version, GOMODCACHE: join(directory, 'modcache'), GOPROXY: `file://${proxy}`, GOSUMDB: 'off' }
  await execFileAsync('go', ['mod', 'download', 'all'], { cwd: consumer, env: consumerEnv })
  await assert.rejects(execFileAsync('go', ['run', '.'], { cwd: consumer, env: consumerEnv }), /go mod tidy|updates to go\.mod needed|missing go\.sum/i)
  await execFileAsync('bash', ['-c', 'set -euo pipefail\n' + fragment], { cwd: new URL('../', import.meta.url).pathname, env: consumerEnv })
  assert.ok((await readFile(join(consumer, 'go.sum'), 'utf8')).split(/\r?\n/).filter(Boolean).length > 2)
})

test('recovery tag and Release asset blocks fail closed before writes on conflicts', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const tagBlock = extractWorkflowRunBlock(workflow, 'Create or verify lightweight tags at immutable M')
  const releaseAssetBlock = extractWorkflowRunBlock(workflow, 'Reconcile fifteen Release assets without overwrite')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-writes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const tagBin = join(directory, 'tag-bin')
  await mkdir(tagBin)
  const tagLog = join(directory, 'tag-log')
  await writeFile(tagLog, '')
  const curl = join(tagBin, 'curl')
  await writeFile(curl, '#!/usr/bin/env node\n' +
    'const fs=require("node:fs"); const args=process.argv.slice(2); const out=args[args.indexOf("--output")+1]; const url=args.at(-1); const key=url.split("/").at(-1); const state=JSON.parse(fs.readFileSync(process.env.TAG_STATE)); const index=state.calls[key]||0; state.calls[key]=index+1; fs.writeFileSync(process.env.TAG_STATE,JSON.stringify(state)); if(process.env.TAG_CASE==="mismatch"){fs.writeFileSync(out,JSON.stringify({object:{sha:"d".repeat(40),type:"commit"}})); process.stdout.write("200"); process.exit(0)} if(index===0){fs.writeFileSync(out,"{}"); process.stdout.write("404")} else {fs.writeFileSync(out,JSON.stringify({object:{sha:process.env.SOURCE_M,type:"commit"}})); process.stdout.write("200")}\n')
  await chmod(curl, 0o755)
  const gh = join(tagBin, 'gh')
  await writeFile(gh, '#!/bin/sh\nif [ "$1" = api ] && [ "$2" = --method ]; then printf \'POST\\n\' >> "$TAG_LOG"; exit 0; fi\nprintf \'{"object":{"sha":"%s","type":"commit"}}\n\' "$SOURCE_M"\n')
  await chmod(gh, 0o755)
  const tagState = join(directory, 'tag-state')
  const tagEnv = { ...process.env, PATH: tagBin + ':' + (process.env.PATH ?? ''), RUNNER_TEMP: directory, SOURCE_M: '4677d67d14c8fbb17ada3ba824d1623180c6b4d9', EXPECTED_REPOSITORY: 'elsoul/erpc-sdk', FOUNDATION_TAG: 'non-rust-v0.9.1', FOUNDATION_GO_TAG: 'packages/go/v0.9.1', PLAN_SHA256: 'a'.repeat(64), PREPARED_RUN_ID: '39862319930', PREPARED_RUN_ATTEMPT: '1', PREPARED_ARTIFACT_ID: '12461868771', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1', RELEASE_USER_AGENT, GH_TOKEN: 'fixture', TAG_LOG: tagLog, TAG_STATE: tagState, TAG_CASE: 'success' }
  await writeFile(tagState, JSON.stringify({ calls: {} }))
  await execFileAsync('bash', ['-c', 'set -euo pipefail\n' + tagBlock], { cwd: new URL('../', import.meta.url).pathname, env: tagEnv })
  assert.equal((await readFile(tagLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length, 2)
  await writeFile(tagLog, '')
  await writeFile(tagState, JSON.stringify({ calls: {} }))
  await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + tagBlock], { cwd: new URL('../', import.meta.url).pathname, env: { ...tagEnv, TAG_CASE: 'mismatch' } }))
  assert.equal((await readFile(tagLog, 'utf8')).trim(), '')

  const assetDirectory = join(directory, 'assets')
  const remoteDirectory = join(directory, 'remote-assets')
  const assetBin = join(directory, 'asset-bin')
  const assetLog = join(directory, 'asset-log')
  await Promise.all([mkdir(assetDirectory), mkdir(remoteDirectory), mkdir(assetBin)])
  await writeFile(assetLog, '')
  const assetNames = Array.from({ length: 15 }, (_, index) => 'asset-' + String(index + 1).padStart(2, '0') + '.txt')
  for (const name of assetNames) {
    await writeFile(join(assetDirectory, name), 'local-' + name)
    if (name !== 'asset-15.txt') await writeFile(join(remoteDirectory, name), 'local-' + name)
  }
  const assetState = join(directory, 'asset-state.json')
  await writeFile(assetState, JSON.stringify(assetNames.slice(0, 14).map((name, index) => ({ id: index + 1, name }))))
  const assetGh = join(assetBin, 'gh')
  await writeFile(assetGh, '#!/usr/bin/env node\n' +
    'const fs=require("node:fs"); const args=process.argv.slice(2); if(args[0]==="api"&&args.includes("--paginate")){process.stdout.write(JSON.stringify([JSON.parse(fs.readFileSync(process.env.ASSET_STATE))]));process.exit(0)} process.exit(99)\n')
  await chmod(assetGh, 0o755)
  const assetCurl = join(assetBin, 'curl')
  await writeFile(assetCurl, '#!/usr/bin/env node\n' +
    'const fs=require("node:fs"); const args=process.argv.slice(2); const output=args[args.indexOf("--output")+1]; const url=args.at(-1); const stateFile=process.env.ASSET_STATE; const records=JSON.parse(fs.readFileSync(stateFile)); if(args.includes("--request")&&args.includes("POST")){const file=args.find(value=>value.startsWith("@")).slice(1); const name=new URL(url).searchParams.get("name"); const id=records.length+1; fs.copyFileSync(file,process.env.REMOTE_ASSETS+"/"+name); records.push({id,name}); fs.writeFileSync(stateFile,JSON.stringify(records)); fs.appendFileSync(process.env.ASSET_LOG,"upload "+name+"\\n"); fs.writeFileSync(output,JSON.stringify({id,name,state:"uploaded",release:{id:421343859}})); process.exit(0)} const id=Number(url.split("/").at(-1)); const record=records.find(value=>value.id===id); if(!record)process.exit(44); fs.copyFileSync(process.env.REMOTE_ASSETS+"/"+record.name,output); process.exit(0)\n')
  await chmod(assetCurl, 0o755)
  const assetTemp = join(directory, 'asset-temp')
  await mkdir(assetTemp)
  const assetEnv = { ...process.env, PATH: assetBin + ':' + (process.env.PATH ?? ''), RUNNER_TEMP: assetTemp, ASSET_DIR: assetDirectory, REMOTE_ASSETS: remoteDirectory, ASSET_STATE: assetState, ASSET_LOG: assetLog, GH_TOKEN: 'fixture', REPOSITORY: 'elsoul/erpc-sdk', RELEASE_ID: '421343859', TAG: 'non-rust-v0.9.1', RELEASE_USER_AGENT, SOURCE_M: '4677d67d14c8fbb17ada3ba824d1623180c6b4d9', PLAN_SHA256: 'a'.repeat(64), PREPARED_RUN_ID: '39862319930', PREPARED_RUN_ATTEMPT: '1', PREPARED_ARTIFACT_ID: '12461868771' }
  await execFileAsync('bash', ['-c', 'set -euo pipefail\n' + releaseAssetBlock], { cwd: new URL('../', import.meta.url).pathname, env: assetEnv })
  assert.equal((await readFile(assetLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length, 1)
  await writeFile(assetLog, '')
  await writeFile(join(remoteDirectory, 'asset-01.txt'), 'conflict')
  await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + releaseAssetBlock], { cwd: new URL('../', import.meta.url).pathname, env: assetEnv }))
  assert.equal((await readFile(assetLog, 'utf8')).trim(), '')
})

test('all five recovery artifact ZIP requests reject old media type and follow a real local redirect with the JSON media type', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const requests = extractWorkflowCurlInvocations(workflow).filter(invocation => invocation.includes('/actions/artifacts/') && invocation.includes('/zip'))
  assert.equal(requests.length, 5)
  for (const request of requests) assert.match(request, /Accept: application\/vnd\.github\+json/)
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-http-415-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const zipFile = join(directory, 'fixture.zip')
  await execFileAsync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("npm-proof.json", "fixture-proof"); z.close()', zipFile])
  const zipBytes = await readFile(zipFile)
  const zipDigest = sha256Hex(zipBytes)
  const received = []
  const server = createServer((request, response) => {
    received.push({ path: request.url, accept: request.headers.accept })
    if (request.url === '/fixture.zip') {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': zipBytes.length })
      response.end(zipBytes)
      return
    }
    if (request.headers.accept !== 'application/vnd.github+json') {
      response.writeHead(415, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'unsupported Accept' }))
      return
    }
    response.writeHead(302, { location: '/fixture.zip' })
    response.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => server.close())
  const port = server.address().port
  const baseEnv = { ...process.env, RUNNER_TEMP: directory, EXPECTED_REPOSITORY: 'elsoul/erpc-sdk', REPOSITORY: 'elsoul/erpc-sdk', RELEASE_USER_AGENT, GH_TOKEN: 'fixture-token', artifact_id: '12468544754', RECEIPT_ARTIFACT_ID: '12468544754', AGGREGATE_ARTIFACT_ID: '12468544754', snapshot_receipts_artifact: '12468544754', REPOSITORY: 'elsoul/erpc-sdk' }
  for (let index = 0; index < requests.length; index += 1) {
    const corrected = requests[index].replaceAll('https://api.github.com', `http://127.0.0.1:${port}`)
    const output = join(directory, `corrected-${index}.zip`)
    const replaceVariables = value => value
      .replace(/--output "\$RUNNER_TEMP\/[^" ]+"/, `--output "${output}"`)
      .replaceAll('"$recovery_zip"', `"${output}"`)
      .replaceAll('$snapshot_receipts_artifact', '12468544754')
    const oldHeader = replaceVariables(corrected).replaceAll('application/vnd.github+json', 'application/zip')
    await assert.rejects(execFileAsync('bash', ['-c', `set -euo pipefail\n${oldHeader}`], { cwd: new URL('../', import.meta.url).pathname, env: baseEnv }), /Command failed|exit code: 22/)
    const runnable = replaceVariables(corrected)
    await execFileAsync('bash', ['-c', `set -euo pipefail\n${runnable}`], { cwd: new URL('../', import.meta.url).pathname, env: baseEnv })
    assert.equal(sha256Hex(await readFile(output)), zipDigest)
  }
  const apiRequests = received.filter(item => item.path.includes('/actions/artifacts/'))
  assert.equal(apiRequests.filter(item => item.accept === 'application/zip').length, 5)
  assert.equal(apiRequests.filter(item => item.accept === 'application/vnd.github+json').length, 5)
  const tampered = Buffer.from(zipBytes); tampered[tampered.length - 1] ^= 1
  assert.notEqual(sha256Hex(tampered), zipDigest)
})

test('final Release draft lookup paginates to the approved numeric ID and rejects missing, ambiguous, wrong, and error listings', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const block = extractWorkflowRunBlock(workflow, 'Resolve and validate the existing draft Release by numeric ID')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-draft-lookup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const gh = join(directory, 'gh')
  const calls = join(directory, 'calls')
  await writeFile(calls, '')
  await writeFile(gh, '#!/usr/bin/env node\n' +
    'const fs=require("node:fs"); const args=process.argv.slice(2); fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+"\\n"); const endpoint=args.find(value=>value.includes("/releases")); const makeRelease=()=>{const mode=process.env.DRAFT_CASE; const release={id:mode==="wrong-id"?999:421343859,tag_name:"non-rust-v0.9.1",name:"SDK release state: non-Rust 0.9.1 / Rust 0.10.0",body:"APPROVED\\n",target_commitish:"4677d67d14c8fbb17ada3ba824d1623180c6b4d9",prerelease:false,draft:true}; if(mode==="wrong-body")release.body="WRONG\\n"; if(mode==="wrong-title")release.name="wrong title"; if(mode==="wrong-source")release.target_commitish="wrong"; if(mode==="wrong-prerelease")release.prerelease=true; if(mode==="published")release.draft=false; return release}; if(args.includes("--paginate")){if(process.env.DRAFT_CASE==="error")process.exit(42); const match=makeRelease(); process.stdout.write(process.env.DRAFT_CASE==="missing"?"[[]]":process.env.DRAFT_CASE==="ambiguous"?JSON.stringify([[match],[match]]):JSON.stringify([[],[match]])); process.exit(0)} if(endpoint?.endsWith("/releases/421343859")){process.stdout.write(JSON.stringify(makeRelease()));process.exit(0)} process.exit(41)\n')
  await chmod(gh, 0o755)
  const body = join(directory, 'body.md')
  const plan = join(directory, 'plan.json')
  await writeFile(body, 'APPROVED\n')
  await writeFile(plan, JSON.stringify({ githubRelease: { body: 'APPROVED\n', bodySha256: sha256Hex('APPROVED\n') } }))
  const baseEnv = { ...process.env, PATH: directory + ':' + (process.env.PATH ?? ''), RUNNER_TEMP: directory, CALLS: calls, DRAFT_CASE: 'success', GH_TOKEN: 'fixture', REPOSITORY: 'elsoul/erpc-sdk', TAG: 'non-rust-v0.9.1', EXPECTED_COMMIT: '4677d67d14c8fbb17ada3ba824d1623180c6b4d9', BODY_FILE: body, PLAN_FILE: plan, FOUNDATION_RELEASE_TITLE: 'SDK release state: non-Rust 0.9.1 / Rust 0.10.0', GITHUB_OUTPUT: join(directory, 'output') }
  await execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], { cwd: new URL('../', import.meta.url).pathname, env: baseEnv })
  assert.match(await readFile(join(directory, 'output'), 'utf8'), /release_id=421343859/)
  for (const draftCase of ['missing', 'ambiguous', 'wrong-id', 'wrong-body', 'wrong-title', 'wrong-source', 'wrong-prerelease', 'error']) await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], { cwd: new URL('../', import.meta.url).pathname, env: { ...baseEnv, DRAFT_CASE: draftCase } }))
  assert.equal((await readFile(calls, 'utf8')).includes('releases/tags/'), false)
})

test('final numeric-ID publication block patches only the approved draft and rejects ID substitution', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const block = extractWorkflowRunBlock(workflow, 'Publish the matching draft and verify the final immutable Release')
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-draft-publish-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const body = join(directory, 'body.md')
  const calls = join(directory, 'calls')
  await writeFile(body, 'APPROVED\n')
  await writeFile(calls, '')
  const assetDirectory = join(directory, 'assets')
  await mkdir(assetDirectory)
  const assetNames = Array.from({ length: 15 }, (_, index) => 'asset-' + String(index + 1).padStart(2, '0') + '.txt')
  for (const name of assetNames) await writeFile(join(assetDirectory, name), name + '\n')
  const patches = join(directory, 'patches')
  await writeFile(patches, '')
  const verifiedAssetReceipt = join(directory, 'verified-assets.json')
  const recordedAssets = assetNames.map((name, index) => ({ id: index + 1, name, sha256: sha256Hex(name + '\n') }))
  await writeFile(verifiedAssetReceipt, JSON.stringify({ releaseId: 421343859, assets: recordedAssets }))
  const gh = join(directory, 'gh')
  await writeFile(gh, '#!/usr/bin/env node\n' +
    'const fs=require("node:fs"); const args=process.argv.slice(2); const endpoint=args.find(value=>value.includes("/releases/")); const baseAssets=Array.from({length:15},(_,i)=>({id:i+1,name:"asset-"+String(i+1).padStart(2,"0")+".txt"})); const getAssets=()=>{const assets=baseAssets.map(asset=>({...asset})); if(process.env.PUBLISH_CASE==="swapped-id"){assets[0].id=2; assets[1].id=1} return assets}; fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+"\\n"); if(args.includes("--paginate")){process.stdout.write(JSON.stringify([getAssets()]));process.exit(0)} if(args.includes("--method")&&args.includes("PATCH")){let data="";process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>{if(data!=="{\\"draft\\":false,\\"make_latest\\":\\"false\\"}")process.exit(43);fs.appendFileSync(process.env.PATCHES,"PATCH\\n");fs.writeFileSync(process.env.STATE,"published");process.stdout.write(JSON.stringify({id:421343859}));});return} if(endpoint?.endsWith("/releases/421343859")){const mode=process.env.PUBLISH_CASE; const release={id:421343859,draft:!fs.existsSync(process.env.STATE),make_latest:false,tag_name:"non-rust-v0.9.1",name:"SDK release state: non-Rust 0.9.1 / Rust 0.10.0",body:"APPROVED\\n",target_commitish:"4677d67d14c8fbb17ada3ba824d1623180c6b4d9",prerelease:false,assets:getAssets()}; if(mode==="body")release.body="wrong\\n"; if(mode==="source")release.target_commitish="wrong"; if(mode==="prerelease")release.prerelease=true; if(mode==="assets")release.assets=release.assets.slice(0,14); process.stdout.write(JSON.stringify(release));process.exit(0)} process.exit(42)\n')
  await chmod(gh, 0o755)
  const curl = join(directory, 'curl')
  await writeFile(curl, '#!/usr/bin/env node\n' +
    'const fs=require("node:fs"); const args=process.argv.slice(2); const output=args[args.indexOf("--output")+1]; const url=args.at(-1); const id=Number(url.split("/").at(-1)); const name="asset-"+String(id).padStart(2,"0")+".txt"; if((process.env.PUBLISH_CASE==="changed-pre"||process.env.PUBLISH_CASE==="changed-post"&&fs.existsSync(process.env.STATE))&&id===1)fs.writeFileSync(output,"changed after publication\\n"); else fs.copyFileSync(process.env.ASSET_DIR+"/"+name,output); process.exit(0)\n')
  await chmod(curl, 0o755)
  const env = { ...process.env, PATH: directory + ':' + (process.env.PATH ?? ''), RUNNER_TEMP: directory, CALLS: calls, PATCHES: patches, STATE: join(directory, 'published'), PUBLISH_CASE: 'success', GH_TOKEN: 'fixture', RELEASE_USER_AGENT, REPOSITORY: 'elsoul/erpc-sdk', RELEASE_ID: '421343859', TAG: 'non-rust-v0.9.1', BODY_FILE: body, ASSET_DIR: assetDirectory, VERIFIED_ASSET_RECEIPT: verifiedAssetReceipt }
  await execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], { cwd: new URL('../', import.meta.url).pathname, env })
  assert.match(await readFile(calls, 'utf8'), /releases\/421343859/)
  assert.equal((await readFile(patches, 'utf8')).trim(), 'PATCH')
  await execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], { cwd: new URL('../', import.meta.url).pathname, env })
  assert.equal((await readFile(patches, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length, 1)
  const swappedDirectory = join(directory, 'swapped-publish')
  await mkdir(swappedDirectory)
  await writeFile(patches, '')
  await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...env, PUBLISH_CASE: 'swapped-id', RUNNER_TEMP: swappedDirectory, STATE: join(swappedDirectory, 'published') },
  }))
  assert.equal((await readFile(patches, 'utf8')).trim(), '')
  await writeFile(patches, '')
  const changedPreDirectory = join(directory, 'changed-pre-publish')
  await mkdir(changedPreDirectory)
  await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...env, PUBLISH_CASE: 'changed-pre', RUNNER_TEMP: changedPreDirectory, STATE: join(changedPreDirectory, 'published') },
  }))
  assert.equal((await readFile(patches, 'utf8')).trim(), '')
  const changedDirectory = join(directory, 'changed-post-publish')
  await mkdir(changedDirectory)
  await writeFile(patches, '')
  await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...env, PUBLISH_CASE: 'changed-post', RUNNER_TEMP: changedDirectory, STATE: join(changedDirectory, 'published') },
  }))
  assert.equal((await readFile(patches, 'utf8')).trim(), 'PATCH')
  await assert.rejects(readFile(join(changedDirectory, 'final-release-proof.json')))
  for (const publishCase of ['body', 'source', 'prerelease', 'assets']) {
    await writeFile(patches, '')
    await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], {
      cwd: new URL('../', import.meta.url).pathname,
      env: { ...env, PUBLISH_CASE: publishCase, STATE: join(directory, `published-${publishCase}`) },
    }))
    assert.equal((await readFile(patches, 'utf8')).trim(), '')
  }
  await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...env, RELEASE_ID: '421343858', STATE: join(directory, 'published-wrong-id') },
  }))
})

test('final numeric-ID asset block handles partial assets idempotently and stops before upload on a late conflict', async t => {
  const workflow = await readFile(new URL('../.github/workflows/reconcile-foundation.yml', import.meta.url), 'utf8')
  const block = extractWorkflowRunBlock(workflow, 'Reconcile fifteen Release assets without overwrite')
  assert.match(block, /foundation-proof-manifest\.json/)
  assert.match(block, /snapshot_receipts_artifact/)
  const directory = await mkdtemp(join(tmpdir(), 'erpc-sdk-recovery-final-assets-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const assetDirectory = join(directory, 'assets')
  const remoteDirectory = join(directory, 'remote')
  const bin = join(directory, 'bin')
  const log = join(directory, 'uploads.log')
  const requests = join(directory, 'requests.log')
  const state = join(directory, 'remote.json')
  await Promise.all([mkdir(assetDirectory), mkdir(remoteDirectory), mkdir(bin)])
  await writeFile(log, '')
  await writeFile(requests, '')
  const names = Array.from({ length: 15 }, (_, i) => 'asset-' + String(i + 1).padStart(2, '0') + '.txt')
  const remoteRecords = []
  for (const [index, name] of names.entries()) {
    await writeFile(join(assetDirectory, name), 'local-' + name)
    if (index < 14) { await writeFile(join(remoteDirectory, name), 'local-' + name); remoteRecords.push({ id: index + 1, name }) }
  }
  await writeFile(state, JSON.stringify(remoteRecords))
  const gh = join(bin, 'gh')
  await writeFile(gh, '#!/usr/bin/env node\n' +
    'const fs=require("node:fs"); const args=process.argv.slice(2); if(args[0]==="api"&&args.includes("--paginate")){process.stdout.write(JSON.stringify([JSON.parse(fs.readFileSync(process.env.REMOTE_STATE))]));process.exit(0)} process.exit(99)\n')
  await chmod(gh, 0o755)
  const curl = join(bin, 'curl')
  await writeFile(curl, '#!/usr/bin/env node\n' +
    'const fs=require("node:fs"); const args=process.argv.slice(2); fs.appendFileSync(process.env.REQUESTS,JSON.stringify(args)+"\\n"); const out=args[args.indexOf("--output")+1]; const url=args.at(-1); if(args.includes("--request")&&args.includes("POST")){const file=args.find(x=>x.startsWith("@")).slice(1); const name=new URL(url).searchParams.get("name"); const records=JSON.parse(fs.readFileSync(process.env.REMOTE_STATE)); const id=records.length+1; fs.copyFileSync(file,process.env.REMOTE_DIR+"/"+name); records.push({id,name}); fs.writeFileSync(process.env.REMOTE_STATE,JSON.stringify(records)); fs.appendFileSync(process.env.UPLOAD_LOG,name+"\\n"); fs.writeFileSync(out,JSON.stringify({id,name,state:"uploaded",release:{id:421343859}})); process.stdout.write(""); process.exit(0)} const id=Number(url.split("/").at(-1)); const records=JSON.parse(fs.readFileSync(process.env.REMOTE_STATE)); const record=records.find(x=>x.id===id); fs.copyFileSync(process.env.REMOTE_DIR+"/"+record.name,out); process.stdout.write("");\n')
  await chmod(curl, 0o755)
  const env = { ...process.env, PATH: bin + ':' + (process.env.PATH ?? ''), RUNNER_TEMP: directory, REPOSITORY: 'elsoul/erpc-sdk', RELEASE_ID: '421343859', TAG: 'non-rust-v0.9.1', ASSET_DIR: assetDirectory, REMOTE_STATE: state, REMOTE_DIR: remoteDirectory, UPLOAD_LOG: log, REQUESTS: requests, GH_TOKEN: 'fixture', RELEASE_USER_AGENT, SOURCE_M: '4677d67d14c8fbb17ada3ba824d1623180c6b4d9', FOUNDATION_PLAN_SHA256: 'a'.repeat(64), FOUNDATION_PREPARED_RUN_ID: '39862319930', FOUNDATION_PREPARED_RUN_ATTEMPT: '1', FOUNDATION_PREPARED_ARTIFACT_ID: '12461868771' }
  await execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], { cwd: new URL('../', import.meta.url).pathname, env })
  assert.equal((await readFile(log, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length, 1)
  const verifiedReceipt = JSON.parse(await readFile(join(directory, 'verified-release-assets.json'), 'utf8'))
  assert.equal(verifiedReceipt.releaseId, 421343859)
  assert.deepEqual(verifiedReceipt.assets.map(asset => asset.name).sort(), names)
  assert.ok(verifiedReceipt.assets.every(asset => Number.isSafeInteger(asset.id) && /^[0-9a-f]{64}$/.test(asset.sha256)))
  const requestArgs = (await readFile(requests, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const post = requestArgs.find(arguments_ => arguments_.includes('--request') && arguments_.includes('POST'))
  assert.ok(post)
  assert.equal(post.includes('--location'), false)
  assert.equal(post.includes('--retry'), false)
  assert.ok(post.includes('Accept: application/vnd.github+json'))
  assert.ok(post.includes('Content-Type: application/octet-stream'))
  assert.ok(post.some(value => value === 'https://uploads.github.com/repos/elsoul/erpc-sdk/releases/421343859/assets?name=asset-15.txt'))
  assert.deepEqual(await readFile(join(remoteDirectory, 'asset-15.txt')), await readFile(join(assetDirectory, 'asset-15.txt')))
  assert.ok(requestArgs.filter(arguments_ => arguments_.includes('Accept: application/octet-stream')).every(arguments_ => arguments_.some(value => value.startsWith('https://api.github.com/repos/elsoul/erpc-sdk/releases/assets/'))))
  await writeFile(log, '')
  await execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], { cwd: new URL('../', import.meta.url).pathname, env })
  assert.equal((await readFile(log, 'utf8')).trim(), '')
  await writeFile(state, JSON.stringify([...remoteRecords, { id: 99, name: 'unexpected.txt' }]))
  await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], { cwd: new URL('../', import.meta.url).pathname, env }))
  assert.equal((await readFile(log, 'utf8')).trim(), '')
  await writeFile(state, JSON.stringify([...remoteRecords, { id: 99, name: 'asset-01.txt' }]))
  await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], { cwd: new URL('../', import.meta.url).pathname, env }))
  assert.equal((await readFile(log, 'utf8')).trim(), '')
  await writeFile(state, JSON.stringify(remoteRecords))
  await writeFile(join(remoteDirectory, 'asset-01.txt'), 'late conflict')
  await assert.rejects(execFileAsync('bash', ['-c', 'set -euo pipefail\n' + block], { cwd: new URL('../', import.meta.url).pathname, env }))
  assert.equal((await readFile(log, 'utf8')).trim(), '')
})
