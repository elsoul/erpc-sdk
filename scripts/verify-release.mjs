import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { rubyLockVersion } from '../registry/ruby-lockfile.mjs'

export const REPOSITORY_ROOT = resolve(new URL('../', import.meta.url).pathname)
export const RELEASE_SCOPES = Object.freeze(['all', 'rust', 'non-rust'])
export const RUST_VERSION = '0.10.0'
export const RUST_TOOLCHAIN = '1.85.0'
export const CRATE_NAME = 'erpc-sdk'
export const EXPECTED_REPOSITORY = 'elsoul/erpc-sdk'
export const EXPECTED_REPOSITORY_ID = '1429568627'
export const FOUNDATION_VERSION = '0.9.1'
export const FOUNDATION_TAG = 'non-rust-v0.9.1'
export const FOUNDATION_GO_TAG = 'packages/go/v0.9.1'
export const FOUNDATION_RELEASE_TITLE = 'SDK release state: non-Rust 0.9.1 / Rust 0.10.0'
export const FOUNDATION_RUST_SOURCE = 'f05abe4276991612c4b5e404fdc768baace32e61'
export const FOUNDATION_RUST_SHA256 = 'f2ad81528b35470b8f193dc45ad9f95e2d5ba0749b916ab9422cb07639088dd7'
export const RELEASE_USER_AGENT = 'erpc-sdk-release-verification (https://github.com/elsoul/erpc-sdk)'
export const FOUNDATION_WORKFLOW = '.github/workflows/release.yml'
export const FOUNDATION_CI_WORKFLOW = '.github/workflows/ci.yml'
export const FOUNDATION_CI_JOB = 'required-ci'
export const FOUNDATION_ARTIFACT_KINDS = Object.freeze([
  'npm',
  'pypi-wheel',
  'pypi-sdist',
  'rubygems',
])

export const FOUNDATION_ARTIFACT_FILENAMES = Object.freeze({
  npm: 'elsoul-erpc-sdk-0.9.1.tgz',
  'pypi-wheel': 'erpc_sdk-0.9.1-py3-none-any.whl',
  'pypi-sdist': 'erpc_sdk-0.9.1.tar.gz',
  rubygems: 'erpc-sdk-0.9.1.gem',
})
export const FOUNDATION_PROOF_ASSETS = Object.freeze([
  'npm-proof.json',
  'pypi-proof.json',
  'rubygems-proof.json',
  'rust-proof.json',
  'tag-proof.json',
  'go-proof.json',
  'foundation-proof-manifest.json',
])

const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const ARCHIVE_SHA256 = /^[0-9a-f]{64}$/
const execFile = promisify(execFileCallback)

const fail = message => {
  throw new Error(message)
}

const sortedObject = value => {
  if (Array.isArray(value)) return value.map(sortedObject)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, sortedObject(value[key])]),
    )
  }
  return value
}

/** Stable JSON used for approval content hashes; run metadata stays outside it. */
export const canonicalJson = value => JSON.stringify(sortedObject(value))

export const sha256Hex = value => createHash('sha256').update(value).digest('hex')

const safeRelativePath = value => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    value.split('/').includes('.') ||
    value.split('/').includes('') ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail(`Unsafe foundation path ${value}`)
  }
  return value
}

const requireFoundationVersion = expectedVersion =>
  requireStableVersion(expectedVersion, 'Foundation version') === FOUNDATION_VERSION
    ? expectedVersion
    : fail(`Foundation cohort must use ${FOUNDATION_VERSION}`)

const requireStableVersion = (value, label) => {
  if (typeof value !== 'string' || !STABLE_VERSION.test(value)) {
    fail(`${label} must be a stable X.Y.Z version`)
  }
  return value
}

const requireSha = (value, label) => {
  if (typeof value !== 'string' || !COMMIT_SHA.test(value)) {
    fail(`${label} must be a 40-character lowercase commit SHA`)
  }
  return value
}

const requireArchiveSha = (value, label) => {
  if (typeof value !== 'string' || !ARCHIVE_SHA256.test(value)) {
    fail(`${label} must be a 64-character hexadecimal SHA-256`)
  }
  return value
}

const takeOptionValue = (arguments_, index, option) => {
  const value = arguments_[index + 1]
  if (value === undefined || value.startsWith('-')) {
    fail(`${option} requires a value`)
  }
  return value
}

/**
 * Parse the verifier's deliberately small CLI. The historical positional tag
 * remains an aggregate (all-language) check; split checks must use a scope.
 */
export function parseReleaseArguments(arguments_ = []) {
  let scope = 'all'
  let scopeProvided = false
  let expectedVersion
  let tag
  let positionalSeparator = false

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--') {
      if (positionalSeparator) fail('Duplicate -- separator')
      positionalSeparator = true
      continue
    }

    if (
      !positionalSeparator &&
      (argument === '--scope' || argument.startsWith('--scope='))
    ) {
      if (scopeProvided) fail('Duplicate --scope')
      const value = argument === '--scope'
        ? takeOptionValue(arguments_, index++, '--scope')
        : argument.slice('--scope='.length)
      if (!RELEASE_SCOPES.includes(value)) {
        fail(`Unknown release scope ${value}`)
      }
      scope = value
      scopeProvided = true
      continue
    }

    if (
      !positionalSeparator &&
      (argument === '--expected-version' ||
        argument.startsWith('--expected-version='))
    ) {
      if (expectedVersion !== undefined) fail('Duplicate --expected-version')
      const value = argument === '--expected-version'
        ? takeOptionValue(arguments_, index++, '--expected-version')
        : argument.slice('--expected-version='.length)
      expectedVersion = requireStableVersion(value, 'Expected version')
      continue
    }

    if (!positionalSeparator && argument.startsWith('-')) {
      fail(`Unknown verifier option ${argument}`)
    }

    if (!positionalSeparator && RELEASE_SCOPES.includes(argument)) {
      if (scopeProvided) fail('Conflicting release scopes')
      scope = argument
      scopeProvided = true
      continue
    }

    if (
      scope !== 'all' &&
      expectedVersion === undefined &&
      STABLE_VERSION.test(argument)
    ) {
      expectedVersion = argument
      continue
    }

    if (tag !== undefined) fail('Only one aggregate release tag is allowed')
    tag = argument
  }

  if (tag !== undefined) {
    if (scope !== 'all') {
      fail('An aggregate release tag cannot be combined with a split scope')
    }
    if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
      fail(`Release tag ${tag} must be a stable vX.Y.Z tag`)
    }
  }

  return { expectedVersion, scope, tag }
}

const parseCargoPackageBlocks = lockSource =>
  lockSource
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map(block => ({
      name: block.match(/^name = "([^"]+)"$/m)?.[1],
      source: block.match(/^source = "([^"]+)"$/m)?.[1],
      version: block.match(/^version = "([^"]+)"$/m)?.[1],
    }))

/** Return the one source-free workspace package entry for the Rust crate. */
export function findLocalCargoPackage(lockSource, packageName = CRATE_NAME) {
  const entries = parseCargoPackageBlocks(lockSource).filter(
    entry => entry.name === packageName,
  )
  const localEntries = entries.filter(entry => entry.source === undefined)
  if (localEntries.length !== 1) {
    fail(
      `Cargo.lock must contain exactly one source-free ${packageName} entry; ` +
        `found ${localEntries.length}`,
    )
  }
  return localEntries[0]
}

export const readReleaseData = async (root, scope = 'all') => {
  if (!RELEASE_SCOPES.includes(scope)) fail(`Unknown release scope ${scope}`)
  const read = relativePath => readFile(resolve(root, relativePath), 'utf8')
  const data = {}
  if (scope === 'all' || scope === 'rust') {
    const [cargoManifest, cargoLock] = await Promise.all([
      read('packages/rust/Cargo.toml'),
      read('Cargo.lock'),
    ])
    data.cargoManifest = cargoManifest
    data.cargoLock = cargoLock
    data.cargoName = cargoManifest.match(/^name = "([^"]+)"$/m)?.[1]
    data.cargoVersion = cargoManifest.match(/^version = "([^"]+)"$/m)?.[1]
    data.cargoLockPackage = findLocalCargoPackage(cargoLock)
  }
  if (scope === 'all' || scope === 'non-rust') {
    const [packageJsonSource, pythonManifest, pythonVersionSource, goManifest,
      rubyManifest, rubyVersionSource, rubyLockSource] = await Promise.all([
      read('packages/typescript/package.json'),
      read('packages/python/pyproject.toml'),
      read('packages/python/src/erpc_sdk/__init__.py'),
      read('packages/go/go.mod'),
      read('packages/ruby/erpc-sdk.gemspec'),
      read('packages/ruby/lib/erpc_sdk/version.rb'),
      read('packages/ruby/Gemfile.lock'),
    ])
    data.packageJson = JSON.parse(packageJsonSource)
    data.pythonManifest = pythonManifest
    data.pythonName = pythonManifest.match(/^name = "([^"]+)"$/m)?.[1]
    data.pythonVersion = pythonManifest.match(/^version = "([^"]+)"$/m)?.[1]
    data.pythonRuntimeVersion = pythonVersionSource.match(
      /^__version__ = "([^"]+)"$/m,
    )?.[1]
    data.goManifest = goManifest
    data.goModule = goManifest.match(/^module (\S+)$/m)?.[1]
    data.rubyManifest = rubyManifest
    data.rubyName = rubyManifest.match(/^\s*spec\.name = "([^"]+)"$/m)?.[1]
    data.rubyVersion = rubyVersionSource.match(/^\s*VERSION = "([^"]+)"$/m)?.[1]
    data.rubyLockVersion = rubyLockVersion(rubyLockSource)
  }
  return data
}

const requireEqual = (actual, expected, message) => {
  if (actual !== expected) fail(message)
}

const validateRust = (data, expectedVersion) => {
  const cargoLockPackage = data.cargoLockPackage ?? findLocalCargoPackage(data.cargoLock)
  requireEqual(data.cargoName, CRATE_NAME, 'Unexpected crates.io package name')
  if (!STABLE_VERSION.test(data.cargoVersion ?? '')) {
    fail('Unexpected Rust crate version')
  }
  requireEqual(
    cargoLockPackage?.version,
    data.cargoVersion,
    'Cargo.lock local erpc-sdk version must match Cargo.toml',
  )
  if (expectedVersion !== undefined) {
    requireEqual(
      data.cargoVersion,
      expectedVersion,
      `Rust crate version ${data.cargoVersion} must match expected version ${expectedVersion}`,
    )
  }
  if (!/^publish = \["crates-io"\]$/m.test(data.cargoManifest)) {
    fail('The Rust crate must be restricted to crates.io')
  }
  if (!/^license = "MIT"$/m.test(data.cargoManifest)) {
    fail('Unexpected Rust crate license')
  }
  if (
    !/^repository = "https:\/\/github\.com\/elsoul\/erpc-sdk"$/m.test(
      data.cargoManifest,
    )
  ) {
    fail('Unexpected Rust crate repository')
  }
  if (!/^rust-version = "1\.85"$/m.test(data.cargoManifest)) {
    fail('Unexpected Rust MSRV')
  }
}

const validateNonRust = (data, expectedVersion) => {
  const packageVersion = data.packageJson.version
  requireEqual(
    data.packageJson.name,
    '@elsoul/erpc-sdk',
    'Unexpected npm package name',
  )
  requireEqual(data.pythonName, 'erpc-sdk', 'Unexpected PyPI package name')
  requireEqual(
    data.goModule,
    'github.com/elsoul/erpc-sdk/packages/go',
    'Unexpected Go module path',
  )
  requireEqual(data.rubyName, 'erpc-sdk', 'Unexpected RubyGems package name')
  requireEqual(data.packageJson.license, 'MIT', 'Unexpected npm package license')
  if (!STABLE_VERSION.test(packageVersion ?? '')) {
    fail('Unexpected npm package version')
  }
  if (expectedVersion !== undefined) {
    requireEqual(
      packageVersion,
      expectedVersion,
      `Non-Rust package version ${packageVersion} must match expected version ${expectedVersion}`,
    )
  }
  if (
    data.pythonVersion !== packageVersion ||
    data.pythonRuntimeVersion !== packageVersion ||
    data.rubyVersion !== packageVersion ||
    data.rubyLockVersion !== packageVersion
  ) {
    fail(
      `Non-Rust package versions differ: npm=${packageVersion}, ` +
        `PyPI=${data.pythonVersion}, Python runtime=${data.pythonRuntimeVersion}, ` +
        `RubyGems=${data.rubyVersion}, Ruby Gemfile.lock=${data.rubyLockVersion}`,
    )
  }
  if (data.packageJson.publishConfig?.access !== 'public') {
    fail('The npm package must publish with public access')
  }
  if (
    data.packageJson.publishConfig?.registry !== 'https://registry.npmjs.org/'
  ) {
    fail('Unexpected npm registry')
  }
  if (
    data.packageJson.repository?.url !==
    'git+https://github.com/elsoul/erpc-sdk.git'
  ) {
    fail('The repository URL must match the public GitHub repository')
  }
  if (data.packageJson.repository?.directory !== 'packages/typescript') {
    fail('Unexpected npm package repository directory')
  }
  if (!/^requires-python = ">=3\.11"$/m.test(data.pythonManifest)) {
    fail('Unexpected minimum Python version')
  }
  if (!/^license = \{ file = "LICENSE" \}$/m.test(data.pythonManifest)) {
    fail('Unexpected Python package license')
  }
  if (
    !/^Repository = "https:\/\/github\.com\/elsoul\/erpc-sdk"$/m.test(
      data.pythonManifest,
    )
  ) {
    fail('Unexpected Python package repository')
  }
  if (!/^go 1\.22$/m.test(data.goManifest)) {
    fail('Unexpected minimum Go version')
  }
  if (!/^\s*spec\.required_ruby_version = ">= 3\.1"$/m.test(data.rubyManifest)) {
    fail('Unexpected minimum Ruby version')
  }
  if (!/^\s*spec\.license = "MIT"$/m.test(data.rubyManifest)) {
    fail('Unexpected Ruby gem license')
  }
  if (
    !/^\s*"source_code_uri" => "https:\/\/github\.com\/elsoul\/erpc-sdk",$/m.test(
      data.rubyManifest,
    )
  ) {
    fail('Unexpected Ruby gem repository')
  }
  if (!/^\s*"rubygems_mfa_required" => "true"$/m.test(data.rubyManifest)) {
    fail('The Ruby gem must require MFA')
  }
}

/** Validate one of the three supported release cohorts. */
export function validateReleaseData(data, options = {}) {
  const { expectedVersion, scope = 'all', tag } = options
  if (!RELEASE_SCOPES.includes(scope)) fail(`Unknown release scope ${scope}`)
  if (expectedVersion !== undefined) {
    requireStableVersion(expectedVersion, 'Expected version')
  }
  if (tag !== undefined && scope !== 'all') {
    fail('An aggregate release tag cannot be combined with a split scope')
  }

  if (scope === 'rust') {
    validateRust(data, expectedVersion)
    return { scope, version: data.cargoVersion }
  }

  validateNonRust(data, expectedVersion)
  if (scope === 'non-rust') {
    return { scope, version: data.packageJson.version }
  }

  validateRust(data)
  const versions = [
    data.packageJson.version,
    data.cargoVersion,
    data.pythonVersion,
    data.pythonRuntimeVersion,
    data.rubyVersion,
    data.rubyLockVersion,
  ]
  if (new Set(versions).size !== 1) {
    fail(
      `Package versions differ: npm=${data.packageJson.version}, ` +
        `crates.io=${data.cargoVersion}, PyPI=${data.pythonVersion}, ` +
        `Python runtime=${data.pythonRuntimeVersion}, RubyGems=${data.rubyVersion}, ` +
        `Ruby Gemfile.lock=${data.rubyLockVersion}`,
    )
  }
  if (expectedVersion !== undefined) {
    requireEqual(
      data.packageJson.version,
      expectedVersion,
      `Aggregate package version ${data.packageJson.version} must match expected version ${expectedVersion}`,
    )
  }
  if (tag !== undefined) {
    requireEqual(
      tag,
      `v${data.packageJson.version}`,
      `Release tag ${tag} must match package version v${data.packageJson.version}`,
    )
  }
  return { scope, version: data.packageJson.version }
}

const artifactNameForKind = kind => {
  if (!FOUNDATION_ARTIFACT_KINDS.includes(kind)) fail(`Unknown foundation artifact kind ${kind}`)
  return kind
}

/** Validate one approved non-Rust artifact descriptor without reading local paths. */
export function validateFoundationArtifactDescriptor(descriptor) {
  const {
    kind,
    filename,
    name,
    version,
    sha256,
    files,
  } = descriptor ?? {}
  artifactNameForKind(kind)
  safeRelativePath(filename)
  requireFoundationVersion(version)
  requireArchiveSha(sha256, `${kind} artifact SHA-256`)
  if (!Array.isArray(files) || files.length === 0) fail(`${kind} artifact file list is empty`)
  const normalizedFiles = files.map(safeRelativePath)
  if (new Set(normalizedFiles).size !== normalizedFiles.length) {
    fail(`${kind} artifact file list contains duplicates`)
  }
  if (kind === 'npm') requireEqual(name, '@elsoul/erpc-sdk', 'Unexpected npm foundation artifact name')
  if (kind.startsWith('pypi')) requireEqual(name, 'erpc-sdk', 'Unexpected PyPI foundation artifact name')
  if (kind === 'rubygems') requireEqual(name, 'erpc-sdk', 'Unexpected RubyGems foundation artifact name')
  requireEqual(filename, FOUNDATION_ARTIFACT_FILENAMES[kind], `${kind} artifact basename is not canonical`)
  return { kind, filename, name, version, sha256, files: normalizedFiles }
}

const foundationArtifactMap = artifacts => {
  if (!Array.isArray(artifacts) || artifacts.length !== FOUNDATION_ARTIFACT_KINDS.length) {
    fail('Foundation plan must contain exactly npm, wheel, sdist, and gem artifacts')
  }
  const validated = artifacts.map(validateFoundationArtifactDescriptor)
  const kinds = new Set(validated.map(artifact => artifact.kind))
  if (kinds.size !== FOUNDATION_ARTIFACT_KINDS.length || FOUNDATION_ARTIFACT_KINDS.some(kind => !kinds.has(kind))) {
    fail('Foundation plan artifact kinds are incomplete or duplicated')
  }
  return Object.fromEntries(validated.map(artifact => [artifact.kind, artifact]))
}

const validateGoInventory = inventory => {
  if (!inventory || !Array.isArray(inventory.files) || inventory.files.length === 0) {
    fail('Go inventory is empty')
  }
  const files = inventory.files.map(file => ({
    path: safeRelativePath(file.path),
    sha256: requireArchiveSha(file.sha256, `Go inventory SHA-256 for ${file.path}`),
  }))
  if (new Set(files.map(file => file.path)).size !== files.length) fail('Go inventory contains duplicate paths')
  if (!files.some(file => file.path === 'go.mod') || !files.some(file => file.path === 'LICENSE')) {
    fail('Go inventory must include go.mod and LICENSE')
  }
  const inventoryDigest = sha256Hex(canonicalJson(files))
  if (inventory.inventorySha256 !== inventoryDigest) fail('Go inventory digest does not match its files')
  return { inventorySha256: inventoryDigest, files }
}

const foundationCapabilityStatement = [
  'Bitcoin Core HTTP JSON-RPC exists only in Rust 0.10.0.',
  'TypeScript, Python, Go, and Ruby 0.9.1 do not add Bitcoin support.',
  'Normal swap quote, route, and build behavior uses configured RPC and local logic; no hosted Jupiter or 0x dependency is added.',
  'Bridge functionality remains separately scoped and this proof release adds no bridge behavior.',
]

export function buildFoundationReleaseBody({ sourceSha, artifacts, rustReceipt, goTag = FOUNDATION_GO_TAG }) {
  requireSha(sourceSha, 'Foundation source commit')
  const byKind = foundationArtifactMap(artifacts)
  const rust = validateFoundationRustReceipt(rustReceipt)
  const rows = [
    ['npm', byKind.npm.name, byKind.npm.version, 'https://registry.npmjs.org/@elsoul/erpc-sdk', byKind.npm.sha256, 'exact tgz; registry/download proof required'],
    ['PyPI wheel', byKind['pypi-wheel'].name, byKind['pypi-wheel'].version, 'https://pypi.org/project/erpc-sdk/', byKind['pypi-wheel'].sha256, 'exact wheel; registry/download proof required'],
    ['PyPI sdist', byKind['pypi-sdist'].name, byKind['pypi-sdist'].version, 'https://pypi.org/project/erpc-sdk/', byKind['pypi-sdist'].sha256, 'exact sdist; registry/download proof required'],
    ['RubyGems', byKind.rubygems.name, byKind.rubygems.version, 'https://rubygems.org/gems/erpc-sdk', byKind.rubygems.sha256, 'exact gem; registry/download proof required'],
    ['Go', 'github.com/elsoul/erpc-sdk/packages/go', FOUNDATION_VERSION, 'https://proxy.golang.org/github.com/elsoul/erpc-sdk/packages/go/@v/v0.9.1.zip', goTag, 'tag/proxy/checksum proof required'],
    ['Rust', 'erpc-sdk', '0.10.0', rust.downloadUrl, rust.sha256, `pre-existing receipt from ${rust.sourceCommit}; verification only`],
  ]
  const table = [
    '| Artifact | Identity | Version | Registry/source URL | Digest/receipt | Proof |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
  return [
    `# ${FOUNDATION_RELEASE_TITLE}`,
    '',
    `Source commit: \`${sourceSha}\``,
    `New cohort tag: \`${FOUNDATION_TAG}\``,
    `Go module tag: \`${goTag}\``,
    '',
    table,
    '',
    ...foundationCapabilityStatement.map(statement => `- ${statement}`),
    '',
    'This release record combines one new non-Rust cohort with one pre-existing Rust receipt; it does not claim that all five artifacts came from one tag or one source archive.',
    '',
  ].join('\n')
}

export function validateFoundationRustReceipt(receipt) {
  if (!receipt || receipt.identity !== 'erpc-sdk') fail('Rust receipt identity is missing')
  requireEqual(receipt.version, '0.10.0', 'Rust receipt version must be 0.10.0')
  requireEqual(receipt.sourceCommit, FOUNDATION_RUST_SOURCE, 'Rust receipt source commit is not the approved published source')
  requireEqual(receipt.sha256, FOUNDATION_RUST_SHA256, 'Rust receipt checksum does not match the approved published artifact')
  requireEqual(receipt.yanked, false, 'Rust receipt must prove the crate is not yanked')
  requireEqual(
    receipt.downloadUrl,
    'https://crates.io/api/v1/crates/erpc-sdk/0.10.0/download',
    'Rust receipt download URL must identify the approved crates.io archive',
  )
  return {
    identity: receipt.identity,
    version: receipt.version,
    sourceCommit: receipt.sourceCommit,
    sha256: receipt.sha256,
    yanked: receipt.yanked,
    downloadUrl: receipt.downloadUrl,
  }
}

export function validateFoundationPlan(plan) {
  requireEqual(plan?.schemaVersion, 1, 'Unsupported foundation plan schema')
  requireEqual(plan?.kind, 'erpc-sdk-foundation-approval-plan', 'Unexpected foundation plan kind')
  requireEqual(plan?.repository, EXPECTED_REPOSITORY, 'Foundation plan repository mismatch')
  requireEqual(String(plan?.repositoryId), EXPECTED_REPOSITORY_ID, 'Foundation plan repository ID mismatch')
  requireEqual(plan?.workflowPath, FOUNDATION_WORKFLOW, 'Foundation plan workflow mismatch')
  requireSha(plan?.sourceCommit, 'Foundation plan source commit')
  requireEqual(plan?.workflowRevision, plan.sourceCommit, 'Foundation plan workflow revision must bind to source commit')
  requireFoundationVersion(plan?.version)
  requireEqual(plan?.cohort, 'non-rust-0.9.1', 'Unexpected foundation cohort')
  requireEqual(plan?.tags?.release, FOUNDATION_TAG, 'Unexpected foundation release tag')
  requireEqual(plan?.tags?.go, FOUNDATION_GO_TAG, 'Unexpected foundation Go tag')
  requireEqual(plan?.tags?.commit, plan.sourceCommit, 'Foundation tag target must match the source commit')
  if (canonicalJson(plan?.proofAssets) !== canonicalJson(FOUNDATION_PROOF_ASSETS)) fail('Foundation proof asset plan is not the approved set')
  const byKind = foundationArtifactMap(plan.artifacts)
  const go = validateGoInventory(plan.goInventory)
  requireEqual(plan.goInventory.inventorySha256, go.inventorySha256, 'Foundation Go inventory mismatch')
  const rust = validateFoundationRustReceipt(plan.rustReceipt)
  const expectedBundleFiles = [
    ...Object.values(byKind).map(artifact => artifact.filename),
    'artifact-metadata.json',
    'go-inventory.json',
    'rust-receipt.json',
    'preflight.json',
    'foundation-plan.json',
    'foundation-plan.sha256',
    'release-body.md',
    'checksums.txt',
  ]
  if (canonicalJson(plan?.bundleFiles) !== canonicalJson(expectedBundleFiles)) fail('Foundation bundle file set is not the approved set')
  if (!plan.sidecars || typeof plan.sidecars !== 'object') fail('Foundation sidecar digests are missing')
  for (const key of ['artifactMetadataSha256', 'goInventorySha256', 'rustReceiptSha256', 'preflightSha256', 'releaseBodySha256']) requireArchiveSha(plan.sidecars[key], `Foundation sidecar digest ${key}`)
  const body = plan.githubRelease?.body
  requireEqual(plan.githubRelease?.title, FOUNDATION_RELEASE_TITLE, 'Unexpected foundation release title')
  requireEqual(plan.githubRelease?.tag, FOUNDATION_TAG, 'Unexpected foundation release tag')
  if (typeof body !== 'string' || !body.includes('Rust 0.10.0') || !body.includes('non-Rust 0.9.1')) {
    fail('Foundation release body is incomplete')
  }
  if (foundationCapabilityStatement.some(statement => !body.includes(statement))) {
    fail('Foundation release body is missing a capability boundary')
  }
  if (body.match(/five-language BTC|all-language BTC|all five.*Bitcoin/i)) {
    fail('Foundation release body overclaims Bitcoin parity')
  }
  requireEqual(plan.githubRelease?.bodySha256, sha256Hex(body), 'Foundation release body digest mismatch')
  const requiredEffects = ['publish npm', 'publish PyPI', 'publish RubyGems', 'create tags', 'create GitHub Release']
  for (const effect of requiredEffects) if (!plan.authorizedEffects?.includes(effect)) fail(`Foundation plan is missing authorized effect ${effect}`)
  return { ...plan, artifacts: Object.values(byKind), goInventory: go, rustReceipt: rust }
}

export function buildFoundationPlan({ sourceSha, artifacts, goInventory, rustReceipt, registryPreflight }) {
  requireSha(sourceSha, 'Foundation source commit')
  const normalizedArtifacts = Object.values(foundationArtifactMap(artifacts))
  const normalizedGo = validateGoInventory(goInventory)
  const normalizedRust = validateFoundationRustReceipt(rustReceipt)
  const allowedPreflight = ['npm', 'pypi', 'rubygems', 'rust']
  if (!registryPreflight || allowedPreflight.some(registry => registryPreflight[registry] === undefined)) {
    fail('Foundation registry preflight must cover npm, PyPI, RubyGems, and Rust')
  }
  for (const registry of allowedPreflight) {
    const record = registryPreflight[registry]
    if (registry === 'rust') {
      requireEqual(record.state, 'match', 'Rust preflight must match the pinned receipt')
    } else {
      requireEqual(record.state, 'absent', `${registry} 0.9.1 must be absent before preparation`)
    }
    if (record.status !== 404 && registry !== 'rust') fail(`${registry} preflight absence must be an exact HTTP 404`)
  }
  const body = buildFoundationReleaseBody({ sourceSha, artifacts: normalizedArtifacts, rustReceipt: normalizedRust })
  const bundleFiles = [
    ...normalizedArtifacts.map(artifact => artifact.filename),
    'artifact-metadata.json',
    'go-inventory.json',
    'rust-receipt.json',
    'preflight.json',
    'foundation-plan.json',
    'foundation-plan.sha256',
    'release-body.md',
    'checksums.txt',
  ]
  const plan = {
    schemaVersion: 1,
    kind: 'erpc-sdk-foundation-approval-plan',
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    workflowPath: FOUNDATION_WORKFLOW,
    workflowRevision: sourceSha,
    cohort: 'non-rust-0.9.1',
    sourceCommit: sourceSha,
    version: FOUNDATION_VERSION,
    artifacts: normalizedArtifacts,
    goInventory: normalizedGo,
    rustReceipt: normalizedRust,
    registryPreflight,
    sidecars: {
      artifactMetadataSha256: sha256Hex(`${canonicalJson(normalizedArtifacts)}\n`),
      goInventorySha256: sha256Hex(`${canonicalJson(normalizedGo)}\n`),
      rustReceiptSha256: sha256Hex(`${canonicalJson(normalizedRust)}\n`),
      preflightSha256: sha256Hex(`${canonicalJson(registryPreflight)}\n`),
      releaseBodySha256: sha256Hex(body),
    },
    bundleFiles,
    proofAssets: FOUNDATION_PROOF_ASSETS,
    tags: { release: FOUNDATION_TAG, go: FOUNDATION_GO_TAG, commit: sourceSha },
    githubRelease: {
      title: FOUNDATION_RELEASE_TITLE,
      tag: FOUNDATION_TAG,
      body,
      bodySha256: sha256Hex(body),
    },
    authorizedEffects: ['publish npm', 'publish PyPI', 'publish RubyGems', 'create tags', 'create GitHub Release'],
  }
  validateFoundationPlan(plan)
  return plan
}

export async function sha256File(filePath) {
  return sha256Hex(await readFile(filePath))
}

const commandText = async (command, arguments_) => {
  const result = await execFile(command, arguments_, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  return result.stdout.trim()
}

const archiveInspectionScript = String.raw`
import json, stat, sys, tarfile, zipfile
path, kind = sys.argv[1:]
entries = []
if kind == 'zip':
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            mode = (info.external_attr >> 16) & 0o170000
            if info.is_dir(): entry_type = 'directory'
            elif stat.S_ISLNK(mode): entry_type = 'symlink'
            elif mode == 0 or stat.S_ISREG(mode): entry_type = 'file'
            else: entry_type = 'other'
            entries.append({'name': info.filename, 'type': entry_type})
else:
    with tarfile.open(path, 'r:*') as archive:
        for info in archive.getmembers():
            if info.isdir(): entry_type = 'directory'
            elif info.isfile(): entry_type = 'file'
            elif info.issym(): entry_type = 'symlink'
            elif info.islnk(): entry_type = 'hardlink'
            else: entry_type = 'other'
            entries.append({'name': info.name, 'type': entry_type})
print(json.dumps(entries))
`

const archiveEntries = async (filePath, kind) => {
  const raw = await commandText('python3', ['-c', archiveInspectionScript, filePath, kind])
  let records
  try { records = JSON.parse(raw) } catch { fail(`Archive inspection is malformed for ${filePath}`) }
  if (!Array.isArray(records) || records.length === 0) fail(`Archive ${filePath} is empty`)
  const names = []
  const seen = new Set()
  for (const record of records) {
    if (record?.type !== 'file' && record?.type !== 'directory') fail(`Archive ${filePath} contains a non-regular member`)
    if (typeof record?.name !== 'string' || record.name.length === 0) fail(`Archive ${filePath} contains an invalid member name`)
    const name = record.type === 'directory' ? record.name.replace(/\/$/, '') : record.name
    safeRelativePath(name)
    if (seen.has(name)) fail(`Archive ${filePath} contains duplicate member ${name}`)
    seen.add(name)
    names.push(name)
  }
  return names
}

const archiveFiles = async (filePath, kind = filePath.endsWith('.whl') ? 'zip' : 'tar') =>
  archiveEntries(filePath, kind)

const archiveText = async (filePath, member, wheel = false) => {
  const output = wheel
    ? await commandText('unzip', ['-p', filePath, member])
    : await commandText('tar', ['-xOf', filePath, member])
  return output
}

const metadataValue = (metadata, field) =>
  metadata.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))?.[1]?.trim()

export async function describeFoundationArtifacts(artifactDirectory) {
  const entries = await readdir(artifactDirectory, { withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name)
  const byKind = {
    npm: files.filter(file => file.endsWith('.tgz')),
    'pypi-wheel': files.filter(file => file.endsWith('.whl')),
    'pypi-sdist': files.filter(file => file.endsWith('.tar.gz')),
    rubygems: files.filter(file => file.endsWith('.gem')),
  }
  const descriptors = []
  for (const kind of FOUNDATION_ARTIFACT_KINDS) {
    if (byKind[kind].length !== 1) fail(`Expected exactly one ${kind} artifact, found ${byKind[kind].length}`)
    const filename = byKind[kind][0]
    const filePath = join(artifactDirectory, filename)
    const archiveKind = kind === 'pypi-wheel' ? 'zip' : 'tar'
    const filesInArchive = await archiveFiles(filePath, archiveKind)
    let name
    let version
    if (kind === 'npm') {
      const packageJsonPath = filesInArchive.find(file => file === 'package/package.json')
      if (!packageJsonPath) fail('npm artifact is missing package/package.json')
      const packageJson = JSON.parse(await archiveText(filePath, packageJsonPath))
      name = packageJson.name
      version = packageJson.version
      if (!filesInArchive.includes('package/LICENSE') || !filesInArchive.includes('package/README.md') || !filesInArchive.some(file => file.startsWith('package/dist/'))) fail('npm artifact is missing LICENSE, README, or dist files')
    } else if (kind === 'pypi-wheel') {
      const metadataPath = filesInArchive.find(file => /\.dist-info\/METADATA$/.test(file))
      if (!metadataPath) fail('PyPI wheel is missing dist-info/METADATA')
      const metadata = await archiveText(filePath, metadataPath, true)
      name = metadataValue(metadata, 'Name')
      version = metadataValue(metadata, 'Version')
      if (!filesInArchive.some(file => /\.dist-info\/(?:licenses\/)?LICENSE$/.test(file)) || !filesInArchive.some(file => /\.py$/.test(file))) fail('PyPI wheel is missing its LICENSE metadata or package code')
    } else if (kind === 'pypi-sdist') {
      const metadataPath = filesInArchive.find(file => /(?:^|\/)PKG-INFO$/.test(file))
      if (!metadataPath) fail('PyPI sdist is missing PKG-INFO')
      const metadata = await archiveText(filePath, metadataPath)
      name = metadataValue(metadata, 'Name')
      version = metadataValue(metadata, 'Version')
      if (!filesInArchive.some(file => /(?:^|\/)LICENSE$/.test(file)) || !filesInArchive.some(file => /\.py$/.test(file))) fail('PyPI sdist is missing LICENSE or package code')
    } else {
      const outerMembers = new Set(filesInArchive)
      const expectedOuterMembers = new Set(['metadata.gz', 'data.tar.gz', 'checksums.yaml.gz'])
      if (outerMembers.size !== expectedOuterMembers.size || [...expectedOuterMembers].some(member => !outerMembers.has(member))) fail('Ruby gem outer member set is invalid')
      const specification = JSON.parse(await commandText('ruby', [
        '-rrubygems/package',
        '-rjson',
        '-e',
        'spec = Gem::Package.new(ARGV.fetch(0)).spec; puts JSON.generate({"name" => spec.name, "version" => spec.version.to_s, "platform" => spec.platform.to_s, "files" => spec.files})',
        filePath,
      ]))
      name = specification.name
      version = specification.version
      if (specification.platform !== 'ruby') fail('Ruby gem platform must be ruby')
      const gemDataDirectory = await mkdtemp(join(tmpdir(), 'erpc-sdk-gem-data-'))
      try {
        const dataTar = await execFile('tar', ['-xOf', filePath, 'data.tar.gz'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
        const dataTarPath = join(gemDataDirectory, 'data.tar.gz')
        await writeFile(dataTarPath, dataTar.stdout)
        const dataFiles = await archiveFiles(dataTarPath, 'tar')
        if (canonicalJson([...specification.files].sort()) !== canonicalJson([...dataFiles].sort())) fail('Ruby gem specification file list does not match its data archive')
        filesInArchive.splice(0, filesInArchive.length, ...dataFiles)
      } finally {
        await rm(gemDataDirectory, { recursive: true, force: true })
      }
      if (!filesInArchive.some(file => /(?:^|\/)LICENSE$/.test(file))) fail('Ruby gem is missing LICENSE')
    }
    descriptors.push(validateFoundationArtifactDescriptor({
      kind,
      filename,
      name,
      version,
      sha256: await sha256File(filePath),
      files: filesInArchive,
    }))
  }
  return descriptors
}

const collectFiles = async (root, current = root) => {
  const entries = await readdir(current, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute))
    else if (entry.isFile()) files.push({ path: safeRelativePath(absolute.slice(root.length + 1)), sha256: await sha256File(absolute) })
    else fail(`Go inventory encountered a non-regular entry ${entry.name}`)
  }
  return files
}

export async function buildGoInventory(goRoot) {
  const files = (await collectFiles(resolve(goRoot))).sort((a, b) => a.path.localeCompare(b.path))
  return validateGoInventory({ files, inventorySha256: sha256Hex(canonicalJson(files)) })
}

export async function verifyFoundationBundle({ plan, artifactDirectory }) {
  const normalized = validateFoundationPlan(plan)
  const allowedFiles = new Set([
    ...normalized.artifacts.map(artifact => artifact.filename),
    'artifact-metadata.json',
    'go-inventory.json',
    'rust-receipt.json',
    'preflight.json',
    'foundation-plan.json',
    'foundation-plan.sha256',
    'release-body.md',
    'checksums.txt',
  ])
  const bundleEntries = await readdir(artifactDirectory, { withFileTypes: true })
  for (const entry of bundleEntries) {
    if (!entry.isFile() || !allowedFiles.has(entry.name)) fail(`Unexpected foundation bundle member ${entry.name}`)
  }
  const planBytes = await readFile(join(artifactDirectory, 'foundation-plan.json'), 'utf8')
  requireEqual(canonicalJson(JSON.parse(planBytes)), canonicalJson(normalized), 'Foundation plan bytes do not match the approved plan')
  requireEqual((await readFile(join(artifactDirectory, 'foundation-plan.sha256'), 'utf8')).trim(), sha256Hex(canonicalJson(normalized)), 'Foundation plan digest sidecar mismatch')
  requireEqual(await readFile(join(artifactDirectory, 'release-body.md'), 'utf8'), normalized.githubRelease.body, 'Foundation release body sidecar mismatch')
  requireEqual(sha256Hex(await readFile(join(artifactDirectory, 'release-body.md'))), normalized.sidecars.releaseBodySha256, 'Foundation release body digest mismatch')
  const artifactMetadata = JSON.parse(await readFile(join(artifactDirectory, 'artifact-metadata.json'), 'utf8'))
  requireEqual(canonicalJson(artifactMetadata), canonicalJson(normalized.artifacts), 'Foundation artifact metadata sidecar mismatch')
  requireEqual(sha256Hex(`${canonicalJson(artifactMetadata)}\n`), normalized.sidecars.artifactMetadataSha256, 'Foundation artifact metadata digest mismatch')
  const goInventory = JSON.parse(await readFile(join(artifactDirectory, 'go-inventory.json'), 'utf8'))
  requireEqual(canonicalJson(goInventory), canonicalJson(normalized.goInventory), 'Foundation Go inventory sidecar mismatch')
  requireEqual(sha256Hex(`${canonicalJson(goInventory)}\n`), normalized.sidecars.goInventorySha256, 'Foundation Go inventory digest mismatch')
  const rustReceipt = JSON.parse(await readFile(join(artifactDirectory, 'rust-receipt.json'), 'utf8'))
  requireEqual(canonicalJson(rustReceipt), canonicalJson(normalized.rustReceipt), 'Foundation Rust receipt sidecar mismatch')
  requireEqual(sha256Hex(`${canonicalJson(rustReceipt)}\n`), normalized.sidecars.rustReceiptSha256, 'Foundation Rust receipt digest mismatch')
  const preflight = JSON.parse(await readFile(join(artifactDirectory, 'preflight.json'), 'utf8'))
  requireEqual(canonicalJson(preflight), canonicalJson(normalized.registryPreflight), 'Foundation preflight sidecar mismatch')
  requireEqual(sha256Hex(`${canonicalJson(preflight)}\n`), normalized.sidecars.preflightSha256, 'Foundation preflight digest mismatch')
  const checksumLines = (await readFile(join(artifactDirectory, 'checksums.txt'), 'utf8')).trim().split(/\r?\n/).filter(Boolean)
  const checksumMap = new Map()
  for (const line of checksumLines) {
    const match = line.match(/^([0-9a-f]{64})\s+\.?\/?(.+)$/)
    if (!match) fail('Foundation checksum manifest is malformed')
    if (checksumMap.has(match[2])) fail(`Foundation checksum manifest duplicates ${match[2]}`)
    checksumMap.set(match[2], match[1])
  }
  const checksumExpected = normalized.bundleFiles.filter(file => file !== 'checksums.txt')
  if (checksumMap.size !== checksumExpected.length || checksumExpected.some(file => !checksumMap.has(file))) fail('Foundation checksum manifest file set mismatch')
  for (const file of checksumExpected) requireEqual(checksumMap.get(file), await sha256File(join(artifactDirectory, file)), `Foundation checksum mismatch for ${file}`)
  const files = []
  for (const artifact of normalized.artifacts) {
    const path = join(artifactDirectory, artifact.filename)
    if (!(await stat(path)).isFile()) fail(`Missing approved foundation artifact ${artifact.filename}`)
    const digest = await sha256File(path)
    requireEqual(digest, artifact.sha256, `Foundation artifact digest mismatch for ${artifact.filename}`)
    files.push(artifact.filename)
  }
  return { plan: normalized, files }
}

export function classifyFoundationRegistryResponse({
  registry,
  status,
  body,
  expectedVersion = FOUNDATION_VERSION,
  expectedArtifacts = [],
  expectedSha256,
}) {
  const numericStatus = Number(status)
  if (numericStatus === 404) return { state: 'absent', status: numericStatus }
  if (numericStatus !== 200) return { state: 'http-error', status: numericStatus }
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    return { state: 'malformed', status: numericStatus }
  }
  if (registry === 'npm') {
    // The exact-version npm endpoint returns one package-version object at
    // the JSON root.  A full package document with `versions` is a different
    // endpoint and must not be accepted as proof for this request.
    const metadata = payload
    if (!metadata || metadata.name !== '@elsoul/erpc-sdk' || metadata.version !== expectedVersion) return { state: 'malformed', status: numericStatus }
    const integrity = metadata.dist?.integrity
    const tarball = metadata.dist?.tarball
    const expectedTarball = `https://registry.npmjs.org/@elsoul/erpc-sdk/-/erpc-sdk-${expectedVersion}.tgz`
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) || tarball !== expectedTarball) return { state: 'malformed', status: numericStatus }
    return { state: 'match', status: numericStatus, integrity, tarball }
  }
  if (registry === 'pypi') {
    if (payload?.info?.name !== 'erpc-sdk' || payload.info.version !== expectedVersion || !Array.isArray(payload.urls)) return { state: 'malformed', status: numericStatus }
    const files = payload.urls.filter(file => expectedArtifacts.includes(file.filename))
    if (files.some(file => file.yanked !== false || file.packagetype !== (file.filename?.endsWith('.whl') ? 'bdist_wheel' : 'sdist') || typeof file.url !== 'string' || !file.url.startsWith('https://files.pythonhosted.org/') || !ARCHIVE_SHA256.test(file.digests?.sha256 ?? ''))) return { state: 'malformed', status: numericStatus }
    const unexpected = payload.urls.filter(file => !expectedArtifacts.includes(file.filename))
    if (unexpected.length > 0) return { state: 'conflict', status: numericStatus, unexpected: unexpected.map(file => file.filename) }
    if (files.length === 0) return { state: 'partial', status: numericStatus, files: [] }
    return { state: files.length === expectedArtifacts.length ? 'match' : 'partial', status: numericStatus, files: files.map(file => ({ filename: file.filename, sha256: file.digests.sha256, url: file.url, packagetype: file.packagetype, yanked: file.yanked === true })) }
  }
  if (registry === 'rubygems') {
    if (payload?.name !== 'erpc-sdk' || payload.version !== expectedVersion || payload.platform !== 'ruby' || typeof payload.sha !== 'string' || !ARCHIVE_SHA256.test(payload.sha)) return { state: 'malformed', status: numericStatus }
    if (expectedSha256 !== undefined && payload.sha !== expectedSha256) return { state: 'conflict', status: numericStatus, sha256: payload.sha }
    return { state: 'match', status: numericStatus, sha256: payload.sha, platform: payload.platform }
  }
  if (registry === 'rust') return classifyRegistryResponse({ status: numericStatus, body, expectedVersion: '0.10.0', expectedChecksum: FOUNDATION_RUST_SHA256 })
  return { state: 'malformed', status: numericStatus }
}

export function validateFoundationPyPIResponse({ body, expectedVersion, expectedFiles, expectedSha256 }) {
  let payload
  try { payload = JSON.parse(body) } catch { fail('PyPI response is malformed') }
  if (payload?.info?.name !== 'erpc-sdk' || payload.info.version !== expectedVersion || !Array.isArray(payload.urls)) fail('PyPI identity/version metadata mismatch')
  const expected = new Set(expectedFiles)
  const files = payload.urls.filter(file => expected.has(file.filename))
  if (files.length !== expected.size || new Set(files.map(file => file.filename)).size !== expected.size || payload.urls.length !== expected.size) fail('PyPI response contains missing or unexpected files')
  const downloads = []
  for (const file of files) {
    const expectedPackagetype = file.filename.endsWith('.whl') ? 'bdist_wheel' : 'sdist'
    if (file.yanked !== false || file.packagetype !== expectedPackagetype || typeof file.url !== 'string' || !file.url.startsWith('https://files.pythonhosted.org/') || file.digests?.sha256 !== expectedSha256[file.filename]) fail(`PyPI file proof mismatch for ${file.filename}`)
    downloads.push({ filename: file.filename, url: file.url, sha256: file.digests.sha256 })
  }
  return downloads.sort((a, b) => a.filename.localeCompare(b.filename))
}

export function validateFoundationBinding(binding, expected) {
  requireEqual(binding?.repository, EXPECTED_REPOSITORY, 'Prepared artifact repository binding mismatch')
  requireEqual(String(binding?.repositoryId), EXPECTED_REPOSITORY_ID, 'Prepared artifact repository ID binding mismatch')
  requireEqual(binding?.workflowPath, FOUNDATION_WORKFLOW, 'Prepared artifact workflow binding mismatch')
  requireEqual(binding?.sourceCommit, expected.sourceCommit, 'Prepared artifact source binding mismatch')
  requireStableVersion(binding?.version, 'Prepared artifact version')
  requireEqual(binding.version, FOUNDATION_VERSION, 'Prepared artifact version mismatch')
  if (!/^[1-9][0-9]*$/.test(String(binding?.runId))) fail('Prepared artifact run ID is invalid')
  if (!/^[1-9][0-9]*$/.test(String(binding?.runAttempt))) fail('Prepared artifact run attempt is invalid')
  if (!/^[1-9][0-9]*$/.test(String(binding?.artifactId))) fail('Prepared artifact ID is invalid')
  if (expected.runId !== undefined) requireEqual(String(binding.runId), String(expected.runId), 'Prepared run ID binding mismatch')
  if (expected.runAttempt !== undefined) requireEqual(String(binding.runAttempt), String(expected.runAttempt), 'Prepared run attempt binding mismatch')
  if (expected.artifactId !== undefined) requireEqual(String(binding.artifactId), String(expected.artifactId), 'Prepared artifact ID binding mismatch')
  requireEqual(binding?.planSha256, expected.planSha256, 'Prepared plan digest binding mismatch')
  return binding
}

const requirePositiveId = (value, label) => {
  if (!/^[1-9][0-9]*$/.test(String(value))) fail(`${label} must be a positive numeric ID`)
  return String(value)
}

/**
 * Validate the read-only GitHub API records for the immutable preparation run
 * and both artifacts consumed by publication. The binding JSON remains useful
 * as a plan digest, but it is not treated as evidence of run success.
 */
export function validateFoundationPreparationMetadata({ run, artifact, bindingArtifact, expected }) {
  const runId = requirePositiveId(expected?.runId, 'Prepared run ID')
  const runAttempt = requirePositiveId(expected?.runAttempt, 'Prepared run attempt')
  const artifactId = requirePositiveId(expected?.artifactId, 'Prepared artifact ID')
  const bindingArtifactId = requirePositiveId(expected?.bindingArtifactId, 'Prepared binding artifact ID')
  requireSha(expected?.sourceCommit, 'Prepared source commit')
  requireEqual(run?.id, Number(runId), 'Preparation run metadata ID mismatch')
  requireEqual(run?.run_attempt, Number(runAttempt), 'Preparation run attempt metadata mismatch')
  requireEqual(run?.status, 'completed', 'Preparation run is not completed')
  requireEqual(run?.conclusion, 'success', 'Preparation run did not succeed')
  requireEqual(run?.event, 'workflow_dispatch', 'Preparation run event mismatch')
  requireEqual(run?.head_branch, 'main', 'Preparation run branch mismatch')
  requireEqual(run?.head_sha, expected.sourceCommit, 'Preparation run source mismatch')
  requireEqual(run?.path, FOUNDATION_WORKFLOW, 'Preparation run workflow path mismatch')
  requireEqual(run?.name, 'Release SDK foundation', 'Preparation run workflow identity mismatch')
  requireEqual(run?.repository?.full_name, EXPECTED_REPOSITORY, 'Preparation run repository mismatch')
  requireEqual(String(run?.repository?.id), EXPECTED_REPOSITORY_ID, 'Preparation run repository ID mismatch')
  if (run?.workflow_id !== undefined) requirePositiveId(run.workflow_id, 'Preparation workflow ID')

  const validateArtifact = (record, expectedId, expectedName) => {
    requireEqual(record?.id, Number(expectedId), `${expectedName} metadata ID mismatch`)
    requireEqual(record?.name, expectedName, `${expectedName} metadata name mismatch`)
    requireEqual(record?.expired, false, `${expectedName} must not be expired`)
    if (!Number.isSafeInteger(record?.size_in_bytes) || record.size_in_bytes <= 0) fail(`${expectedName} metadata size is invalid`)
    requireEqual(record?.workflow_run?.id, Number(runId), `${expectedName} preparation run binding mismatch`)
    requireEqual(String(record?.workflow_run?.repository_id), EXPECTED_REPOSITORY_ID, `${expectedName} repository binding mismatch`)
    requireEqual(String(record?.workflow_run?.head_repository_id), EXPECTED_REPOSITORY_ID, `${expectedName} source repository binding mismatch`)
    requireEqual(record?.workflow_run?.head_sha, expected.sourceCommit, `${expectedName} source binding mismatch`)
    requireEqual(record?.workflow_run?.head_branch, 'main', `${expectedName} branch binding mismatch`)
    if (record?.workflow_run?.run_attempt !== undefined) requireEqual(record.workflow_run.run_attempt, Number(runAttempt), `${expectedName} attempt binding mismatch`)
    if (record?.workflow_run?.path !== undefined) requireEqual(record.workflow_run.path, FOUNDATION_WORKFLOW, `${expectedName} workflow binding mismatch`)
    if (record?.workflow_run?.repository_id !== undefined) requireEqual(String(record.workflow_run.repository_id), EXPECTED_REPOSITORY_ID, `${expectedName} repository binding mismatch`)
    if (record?.archive_download_url !== undefined && !String(record.archive_download_url).startsWith('https://api.github.com/')) fail(`${expectedName} archive URL is not a GitHub API URL`)
    return { id: Number(expectedId), name: expectedName, sizeInBytes: record.size_in_bytes }
  }

  return {
    runId: Number(runId),
    runAttempt: Number(runAttempt),
    artifact: validateArtifact(artifact, artifactId, `sdk-foundation-bundle-${expected.sourceCommit}`),
    bindingArtifact: validateArtifact(bindingArtifact, bindingArtifactId, `sdk-foundation-binding-${runId}-${runAttempt}`),
  }
}

const foundationProofCommon = (receipt, plan, expected, kind) => {
  requireEqual(receipt?.schemaVersion, 1, 'Foundation proof schema is unsupported')
  requireEqual(receipt?.repository, EXPECTED_REPOSITORY, 'Foundation proof repository mismatch')
  requireEqual(receipt?.sourceCommit, kind === 'rust' ? FOUNDATION_RUST_SOURCE : plan.sourceCommit, 'Foundation proof source mismatch')
  requireEqual(receipt?.planSha256, sha256Hex(canonicalJson(plan)), 'Foundation proof plan binding mismatch')
  requireEqual(receipt?.version, kind === 'rust' ? '0.10.0' : kind === 'go' ? 'v0.9.1' : FOUNDATION_VERSION, 'Foundation proof version mismatch')
  requirePositiveId(receipt?.preparedRunId, 'Foundation proof preparation run ID')
  requirePositiveId(receipt?.preparedRunAttempt, 'Foundation proof preparation run attempt')
  requirePositiveId(receipt?.preparedArtifactId, 'Foundation proof preparation artifact ID')
  requireEqual(String(receipt.preparedRunId), String(expected.runId), 'Foundation proof run binding mismatch')
  requireEqual(String(receipt.preparedRunAttempt), String(expected.runAttempt), 'Foundation proof attempt binding mismatch')
  requireEqual(String(receipt.preparedArtifactId), String(expected.artifactId), 'Foundation proof artifact binding mismatch')
  requirePositiveId(receipt?.observerRunId, 'Foundation proof observer run ID')
  requirePositiveId(receipt?.observerAttempt, 'Foundation proof observer attempt')
  if (typeof receipt.observedAt !== 'string' || Number.isNaN(Date.parse(receipt.observedAt))) fail('Foundation proof observation time is invalid')
}

export function validateFoundationProofReceipt(receipt, { plan, kind, expected }) {
  foundationProofCommon(receipt, plan, expected, kind)
  const artifact = plan.artifacts.find(item => item.kind === kind)
  if (kind === 'npm') {
    requireEqual(receipt.registry, 'npmjs.org', 'npm proof registry mismatch')
    requireEqual(receipt.identity, '@elsoul/erpc-sdk', 'npm proof identity mismatch')
    requireEqual(receipt.state === 'published' || receipt.state === 'reused', true, 'npm proof state is invalid')
    requireEqual(receipt.expectedSha256, artifact.sha256, 'npm proof expected digest mismatch')
    requireEqual(receipt.observedSha256, artifact.sha256, 'npm proof observed digest mismatch')
    requireEqual(receipt.version, artifact.version, 'npm proof version mismatch')
    if (typeof receipt.tarball !== 'string' || receipt.tarball !== 'https://registry.npmjs.org/@elsoul/erpc-sdk/-/erpc-sdk-0.9.1.tgz') fail('npm proof tarball URL is not canonical')
    if (typeof receipt.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(receipt.integrity)) fail('npm proof integrity is invalid')
    if (!receipt.provenance || typeof receipt.provenance !== 'object') fail('npm proof is missing observed provenance')
    if (receipt.state === 'published') {
      requireEqual(receipt.auth?.requested, true, 'npm proof lacks an observed publish credential request')
      requireEqual(receipt.auth?.uploadAttempted, true, 'npm proof lacks an observed upload attempt')
      if (!['success', 'failure', 'skipped'].includes(receipt.auth?.uploadOutcome)) fail('npm proof upload outcome is invalid')
    } else {
      requireEqual(receipt.auth?.requested, false, 'npm reuse proof cannot claim a new credential request')
      requireEqual(receipt.auth?.uploadAttempted, false, 'npm reuse proof cannot claim an upload attempt')
    }
    requireEqual(receipt.auth?.publicProvenanceObserved, true, 'npm proof lacks observed public provenance')
    const npmClaims = receipt.certificateClaims ?? {}
    const npmIssuerClaim = npmClaims['1.3.6.1.4.1.57264.1.8'] ?? npmClaims['1.3.6.1.4.1.57264.1.1']
    requireEqual(npmIssuerClaim, 'https://token.actions.githubusercontent.com', 'npm certificate issuer claim is invalid')
    for (const [key, value] of Object.entries({
      '1.3.6.1.4.1.57264.1.9': `https://github.com/${EXPECTED_REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
      '1.3.6.1.4.1.57264.1.13': plan.sourceCommit,
      '1.3.6.1.4.1.57264.1.14': 'refs/heads/main',
      '1.3.6.1.4.1.57264.1.19': plan.sourceCommit,
      '1.3.6.1.4.1.57264.1.15': EXPECTED_REPOSITORY_ID,
      '1.3.6.1.4.1.57264.1.18': `https://github.com/${EXPECTED_REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
      '1.3.6.1.4.1.57264.1.20': 'workflow_dispatch',
    })) requireEqual(npmClaims[key], value, `npm certificate claim ${key} is not bound to the approved source`)
    const provenanceText = JSON.stringify(receipt.provenance)
    for (const marker of [EXPECTED_REPOSITORY, FOUNDATION_WORKFLOW, plan.sourceCommit]) if (!provenanceText.includes(marker)) fail(`npm provenance is missing ${marker}`)
  } else if (kind === 'pypi') {
    requireEqual(receipt.registry, 'pypi.org', 'PyPI proof registry mismatch')
    requireEqual(receipt.identity, 'erpc-sdk', 'PyPI proof identity mismatch')
    requireEqual(receipt.state === 'published' || receipt.state === 'reused' || receipt.state === 'partial-resume', true, 'PyPI proof state is invalid')
    if (!Array.isArray(receipt.files) || receipt.files.length !== 2) fail('PyPI proof file set is incomplete')
    const expectedFiles = new Map(plan.artifacts.filter(item => item.kind.startsWith('pypi')).map(item => [item.filename, item.sha256]))
    const seen = new Set()
    for (const file of receipt.files) {
      if (seen.has(file.filename) || !expectedFiles.has(file.filename) || file.sha256 !== expectedFiles.get(file.filename) || file.yanked !== false || typeof file.url !== 'string' || !file.url.startsWith('https://files.pythonhosted.org/') || !Array.isArray(file.attestations) || file.attestations.length === 0 || file.certificateClaims?.['1.3.6.1.4.1.57264.1.8'] !== 'https://token.actions.githubusercontent.com' || file.certificateClaims?.['1.3.6.1.4.1.57264.1.9'] !== `https://github.com/${EXPECTED_REPOSITORY}/.github/workflows/release.yml@refs/heads/main` || file.certificateClaims?.['1.3.6.1.4.1.57264.1.12'] !== `https://github.com/${EXPECTED_REPOSITORY}` || file.certificateClaims?.['1.3.6.1.4.1.57264.1.13'] !== plan.sourceCommit || file.certificateClaims?.['1.3.6.1.4.1.57264.1.14'] !== 'refs/heads/main' || file.certificateClaims?.['1.3.6.1.4.1.57264.1.15'] !== EXPECTED_REPOSITORY_ID || file.certificateClaims?.['1.3.6.1.4.1.57264.1.18'] !== `https://github.com/${EXPECTED_REPOSITORY}/.github/workflows/release.yml@refs/heads/main` || file.certificateClaims?.['1.3.6.1.4.1.57264.1.19'] !== plan.sourceCommit || file.certificateClaims?.['1.3.6.1.4.1.57264.1.20'] !== 'workflow_dispatch') fail('PyPI proof file or attestation binding is invalid')
      seen.add(file.filename)
    }
    if (seen.size !== expectedFiles.size) fail('PyPI proof file set does not match the plan')
    if (receipt.state === 'reused') {
      requireEqual(receipt.auth?.requested, false, 'PyPI reuse proof cannot claim a new credential request')
      requireEqual(receipt.auth?.uploadAttempted, false, 'PyPI reuse proof cannot claim an upload attempt')
    } else {
      requireEqual(receipt.auth?.requested, true, 'PyPI proof lacks an observed credential request')
      requireEqual(receipt.auth?.uploadAttempted, true, 'PyPI proof lacks an observed upload attempt')
      if (!['success', 'failure', 'skipped'].includes(receipt.auth?.uploadOutcome)) fail('PyPI proof upload outcome is invalid')
    }
    requireEqual(receipt.auth?.attestationsVerified, true, 'PyPI proof lacks attestation verification evidence')
  } else if (kind === 'rubygems') {
    requireEqual(receipt.registry, 'rubygems.org', 'RubyGems proof registry mismatch')
    requireEqual(receipt.identity, 'erpc-sdk', 'RubyGems proof identity mismatch')
    requireEqual(receipt.state === 'published' || receipt.state === 'reused', true, 'RubyGems proof state is invalid')
    requireEqual(receipt.sha256, artifact.sha256, 'RubyGems proof digest mismatch')
    if (receipt.state === 'published') {
      requireEqual(receipt.auth?.requested, true, 'RubyGems proof lacks an observed credential request')
      requireEqual(receipt.auth?.uploadAttempted, true, 'RubyGems proof lacks an observed upload attempt')
      requireEqual(receipt.auth?.credentialObserved, true, 'RubyGems proof lacks observed credential material')
    } else {
      requireEqual(receipt.auth?.requested, false, 'RubyGems reuse proof cannot claim a new credential request')
      requireEqual(receipt.auth?.uploadAttempted, false, 'RubyGems reuse proof cannot claim an upload attempt')
      requireEqual(receipt.auth?.credentialObserved, false, 'RubyGems reuse proof cannot claim credential material')
    }
    requireEqual(receipt.credentialCleanup?.envCleared, true, 'RubyGems proof lacks environment cleanup evidence')
    requireEqual(receipt.credentialCleanup?.filesCleared, true, 'RubyGems proof lacks file cleanup evidence')
    requireEqual(receipt.consumer?.installed, true, 'RubyGems proof lacks post-cleanup consumer evidence')
  } else if (kind === 'rust') {
    requireEqual(receipt.registry, 'crates.io', 'Rust proof registry mismatch')
    requireEqual(receipt.identity, 'erpc-sdk', 'Rust proof identity mismatch')
    requireEqual(receipt.version, '0.10.0', 'Rust proof version mismatch')
    requireEqual(receipt.sourceCommit, FOUNDATION_RUST_SOURCE, 'Rust proof source mismatch')
    requireEqual(receipt.foundationSourceCommit, plan.sourceCommit, 'Rust proof foundation source mismatch')
    requireEqual(receipt.sha256, FOUNDATION_RUST_SHA256, 'Rust proof digest mismatch')
    requireEqual(receipt.registryStatus, 200, 'Rust proof registry status is not 200')
    requireEqual(receipt.yanked, false, 'Rust proof must observe an unyanked crate')
    requireEqual(receipt.downloadStatus, 200, 'Rust proof download status is not 200')
    requireEqual(receipt.auth?.requested, false, 'Rust proof cannot request credentials')
    requireEqual(receipt.auth?.uploadAttempted, false, 'Rust proof cannot upload')
  } else if (kind === 'tags') {
    requireEqual(receipt.registry, 'github.com', 'Tag proof source mismatch')
    requireEqual(receipt.tags?.release?.sha, plan.sourceCommit, 'Release tag proof target mismatch')
    requireEqual(receipt.tags?.go?.sha, plan.sourceCommit, 'Go tag proof target mismatch')
    requireEqual(receipt.tags?.release?.ref, `refs/tags/${FOUNDATION_TAG}`, 'Release tag proof ref mismatch')
    requireEqual(receipt.tags?.go?.ref, `refs/tags/${FOUNDATION_GO_TAG}`, 'Go tag proof ref mismatch')
    requireEqual(receipt.auth?.requested, true, 'Tag proof lacks an observed write credential request')
    requireEqual(receipt.auth?.writeObserved, true, 'Tag proof lacks an observed ref write/read outcome')
  } else if (kind === 'go') {
    requireEqual(receipt.registry, 'proxy.golang.org', 'Go proof registry mismatch')
    requireEqual(receipt.module, 'github.com/elsoul/erpc-sdk/packages/go', 'Go proof module mismatch')
    requireEqual(receipt.version, 'v0.9.1', 'Go proof version mismatch')
    requireEqual(receipt.originHash, plan.sourceCommit, 'Go proof proxy origin mismatch')
    requireEqual(receipt.directOriginHash, plan.sourceCommit, 'Go proof direct origin mismatch')
    requireEqual(receipt.originSubdir, 'packages/go', 'Go proof proxy subdirectory mismatch')
    requireEqual(receipt.directOriginSubdir, 'packages/go', 'Go proof direct subdirectory mismatch')
    if (!/^h1:[A-Za-z0-9+/]{43}=?$/.test(receipt.sum) || !/^h1:[A-Za-z0-9+/]{43}=?$/.test(receipt.goModSum)) fail('Go proof checksum receipt is malformed')
    requireArchiveSha(receipt.zipSha256, 'Go proof zip digest')
    requireEqual(receipt.auth?.requested, false, 'Go proof cannot request publication credentials')
    requireEqual(receipt.auth?.uploadAttempted, false, 'Go proof cannot upload')
  } else {
    fail(`Unknown foundation proof kind ${kind}`)
  }
  return receipt
}

export async function verifyFoundationProofSet({ plan, proofDirectory, manifestFile, expected }) {
  const normalized = validateFoundationPlan(plan)
  const required = ['npm-proof.json', 'pypi-proof.json', 'rubygems-proof.json', 'rust-proof.json', 'tag-proof.json', 'go-proof.json']
  const entries = await readdir(proofDirectory, { withFileTypes: true })
  if (entries.some(entry => !entry.isFile())) fail('Foundation proof directory contains a non-file member')
  const names = entries.filter(entry => entry.isFile()).map(entry => entry.name).sort()
  const allowedNames = [...required, 'foundation-proof-manifest.json'].sort()
  if (names.some(name => !allowedNames.includes(name)) || names.filter(name => required.includes(name)).length !== required.length) fail('Foundation proof receipt set is incomplete or has extras')
  let priorReceiptArtifactId
  const receipts = {}
  for (const [file, kind] of Object.entries({ 'npm-proof.json': 'npm', 'pypi-proof.json': 'pypi', 'rubygems-proof.json': 'rubygems', 'rust-proof.json': 'rust', 'tag-proof.json': 'tags', 'go-proof.json': 'go' })) {
    receipts[file] = validateFoundationProofReceipt(JSON.parse(await readFile(join(proofDirectory, file), 'utf8')), { plan: normalized, kind, expected })
  }
  const receiptDigests = {}
  for (const file of Object.keys(receipts)) receiptDigests[file] = sha256Hex(await readFile(join(proofDirectory, file)))
  if (names.includes('foundation-proof-manifest.json')) {
    const priorManifest = JSON.parse(await readFile(join(proofDirectory, 'foundation-proof-manifest.json'), 'utf8'))
    requireEqual(priorManifest?.kind, 'erpc-sdk-foundation-proof-manifest', 'Foundation proof manifest kind mismatch')
    requireEqual(priorManifest?.planSha256, sha256Hex(canonicalJson(normalized)), 'Foundation proof manifest plan mismatch')
    requireEqual(priorManifest?.sourceCommit, normalized.sourceCommit, 'Foundation proof manifest source mismatch')
    requireEqual(canonicalJson(priorManifest?.receipts), canonicalJson(receiptDigests), 'Foundation proof manifest receipt bytes mismatch')
    if (priorManifest?.proofReceiptsArtifactId !== undefined) priorReceiptArtifactId = requirePositiveId(priorManifest.proofReceiptsArtifactId, 'Foundation proof receipts artifact ID')
    if (expected.receiptArtifactId !== undefined && priorManifest?.proofReceiptsArtifactId !== undefined) requireEqual(String(priorManifest.proofReceiptsArtifactId), String(expected.receiptArtifactId), 'Foundation proof receipts artifact binding mismatch')
  }
  const receiptArtifactId = expected.receiptArtifactId === undefined ? priorReceiptArtifactId : requirePositiveId(expected.receiptArtifactId, 'Foundation proof receipts artifact ID')
  const manifest = {
    schemaVersion: 1,
    kind: 'erpc-sdk-foundation-proof-manifest',
    repository: EXPECTED_REPOSITORY,
    sourceCommit: normalized.sourceCommit,
    version: FOUNDATION_VERSION,
    planSha256: sha256Hex(canonicalJson(normalized)),
    preparedRunId: String(expected.runId),
    preparedRunAttempt: String(expected.runAttempt),
    preparedArtifactId: String(expected.artifactId),
    ...(receiptArtifactId === undefined ? {} : { proofReceiptsArtifactId: String(receiptArtifactId) }),
    receipts: receiptDigests,
    proofAssets: FOUNDATION_PROOF_ASSETS,
    state: 'complete',
  }
  await writeFile(manifestFile, `${canonicalJson(manifest)}\n`)
  return manifest
}

/**
 * Validate the exact event/source binding shared by the Rust workflow jobs.
 * This is intentionally pure so tests can exercise hostile event fixtures.
 */
export function validateWorkflowContext(context) {
  const {
    repository,
    repositoryId,
    eventName,
    eventRef,
    eventSha,
    expectedCommit,
    checkoutHead,
    expectedVersion,
    publish,
    approvedSha256,
  } = context
  requireEqual(repository, EXPECTED_REPOSITORY, 'Unexpected repository')
  requireEqual(
    String(repositoryId),
    EXPECTED_REPOSITORY_ID,
    'Unexpected repository ID',
  )
  requireEqual(eventName, 'workflow_dispatch', 'Rust release must be manually dispatched')
  requireEqual(eventRef, 'refs/heads/main', 'Rust release must run from main')
  requireSha(expectedCommit, 'Expected commit')
  requireSha(eventSha, 'Event commit')
  requireSha(checkoutHead, 'Checkout HEAD')
  requireEqual(expectedCommit, eventSha, 'Expected commit must match event commit')
  requireEqual(expectedCommit, checkoutHead, 'Checkout HEAD must match expected commit')
  requireStableVersion(expectedVersion, 'Expected version')

  const publishValue = publish === true || publish === 'true'
    ? true
    : publish === false || publish === 'false'
      ? false
      : fail('Publish input must be a boolean')
  if (approvedSha256 !== undefined && approvedSha256 !== '') {
    requireArchiveSha(approvedSha256, 'Approved crate hash')
  }
  if (publishValue && !approvedSha256) {
    fail('Publish requires a nonempty approved crate hash')
  }
  return { expectedCommit, expectedVersion, publish: publishValue, approvedSha256 }
}

export function validateFoundationWorkflowContext(context) {
  const {
    repository,
    repositoryId,
    eventName,
    eventRef,
    eventSha,
    expectedCommit,
    checkoutHead,
    checkoutStatus,
    expectedVersion,
    mode,
    workflowRef,
    workflowSha,
  } = context
  requireEqual(repository, EXPECTED_REPOSITORY, 'Unexpected repository')
  requireEqual(String(repositoryId), EXPECTED_REPOSITORY_ID, 'Unexpected repository ID')
  requireEqual(eventName, 'workflow_dispatch', 'Foundation release must be manually dispatched')
  requireEqual(eventRef, 'refs/heads/main', 'Foundation release must run from main')
  requireSha(expectedCommit, 'Expected foundation commit')
  requireSha(eventSha, 'Foundation event commit')
  requireSha(checkoutHead, 'Foundation checkout HEAD')
  requireEqual(expectedCommit, eventSha, 'Foundation expected commit must match event commit')
  requireEqual(expectedCommit, checkoutHead, 'Foundation checkout HEAD must match expected commit')
  requireEqual(checkoutStatus, '', 'Foundation checkout must be clean')
  requireEqual(workflowRef, `${EXPECTED_REPOSITORY}/${FOUNDATION_WORKFLOW}@refs/heads/main`, 'Foundation workflow identity must bind to the approved main ref')
  requireEqual(workflowSha, expectedCommit, 'Foundation workflow definition must bind to the approved source')
  requireFoundationVersion(expectedVersion)
  if (mode !== 'prepare' && mode !== 'publish') fail('Foundation mode must be prepare or publish')
  return { expectedCommit, expectedVersion, mode }
}

const foundationCIRunIsEligible = (run, expected) =>
  run?.workflow_id === expected.workflowId &&
  run?.path === FOUNDATION_CI_WORKFLOW &&
  run?.head_sha === expected.sourceCommit &&
  run?.head_branch === 'main' &&
  (run?.event === 'push' || run?.event === 'workflow_dispatch') &&
  String(run?.repository?.id ?? run?.repository_id) === EXPECTED_REPOSITORY_ID &&
  (run?.repository?.full_name === undefined || run.repository.full_name === EXPECTED_REPOSITORY) &&
  (run?.head_repository?.id === undefined || String(run.head_repository.id) === EXPECTED_REPOSITORY_ID) &&
  (run?.head_repository?.full_name === undefined || run.head_repository.full_name === EXPECTED_REPOSITORY)

export function selectFoundationCIRun({ workflow, runs, expected }) {
  requirePositiveId(workflow?.id, 'CI workflow ID')
  requireEqual(workflow?.path, FOUNDATION_CI_WORKFLOW, 'CI workflow path mismatch')
  if (workflow?.url !== undefined && workflow.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/workflows/${workflow.id}`) fail('CI workflow URL is not bound to the expected repository and workflow ID')
  if (!Array.isArray(runs?.workflow_runs) || !Number.isSafeInteger(runs?.total_count) || runs.total_count !== runs.workflow_runs.length || runs.total_count > 100) {
    fail('CI workflow run enumeration is missing, truncated, or malformed')
  }
  const runIds = new Set()
  for (const run of runs.workflow_runs) {
    const id = requirePositiveId(run?.id, 'CI workflow run ID')
    if (runIds.has(id)) fail('CI workflow run enumeration contains duplicate run identities')
    runIds.add(id)
  }
  const sourceRuns = runs.workflow_runs.filter(run => run?.head_sha === expected.sourceCommit && String(run?.repository?.id ?? run?.repository_id) === EXPECTED_REPOSITORY_ID)
  if (sourceRuns.some(run => run?.workflow_id === workflow.id && (run?.event === 'pull_request' || run?.head_branch !== 'main' || run?.path !== FOUNDATION_CI_WORKFLOW))) {
    fail('CI proof includes an ineligible pull-request, branch, or workflow run for the release source')
  }
  const eligible = runs.workflow_runs.filter(run => foundationCIRunIsEligible(run, { ...expected, workflowId: workflow.id }))
  if (eligible.length === 0) fail('No eligible main CI run exists for the exact release source')
  eligible.sort((left, right) => {
    const created = String(right.created_at ?? '').localeCompare(String(left.created_at ?? ''))
    if (created !== 0) return created
    const number = Number(right.run_number ?? right.id) - Number(left.run_number ?? left.id)
    return Number.isNaN(number) ? 0 : number
  })
  const selected = eligible[0]
  requirePositiveId(selected.id, 'Selected CI run ID')
  requirePositiveId(selected.run_attempt, 'Selected CI run attempt')
  return {
    id: Number(selected.id),
    runAttempt: Number(selected.run_attempt),
    workflowId: Number(workflow.id),
    sourceCommit: selected.head_sha,
    event: selected.event,
    headBranch: selected.head_branch,
    createdAt: selected.created_at,
  }
}

export function validateFoundationCIProof({ workflow, runs, selection, recheck, jobs, expected }) {
  const selected = selectFoundationCIRun({ workflow, runs, expected })
  requireEqual(selection?.id, selected.id, 'CI selected run binding mismatch')
  requireEqual(selection?.runAttempt, selected.runAttempt, 'CI selected attempt binding mismatch')
  const selectedRun = runs.workflow_runs.find(run => Number(run.id) === selected.id)
  requireEqual(selectedRun?.status, 'completed', 'Selected CI run is not completed')
  requireEqual(selectedRun?.conclusion, 'success', 'Selected CI run did not succeed')
  requireEqual(recheck?.id, selected.id, 'CI run changed while proof was fetched')
  requireEqual(recheck?.run_attempt, selected.runAttempt, 'CI run attempt changed while proof was fetched')
  requireEqual(recheck?.head_sha, expected.sourceCommit, 'CI recheck source mismatch')
  requireEqual(recheck?.head_branch, 'main', 'CI recheck branch mismatch')
  requireEqual(recheck?.status, 'completed', 'CI recheck is not completed')
  requireEqual(recheck?.conclusion, 'success', 'CI recheck did not succeed')
  if (!Array.isArray(jobs?.jobs) || !Number.isSafeInteger(jobs?.total_count) || jobs.total_count !== jobs.jobs.length || jobs.total_count > 100) fail('CI job enumeration is missing, truncated, or malformed')
  const requiredJobs = jobs.jobs.filter(job => job?.name === FOUNDATION_CI_JOB)
  if (requiredJobs.length !== 1) fail('CI proof must contain exactly one required-ci job')
  const job = requiredJobs[0]
  requirePositiveId(job.id, 'required-ci job ID')
  requireEqual(job.status, 'completed', 'required-ci job is not completed')
  requireEqual(job.conclusion, 'success', 'required-ci job did not succeed')
  requireEqual(job.run_id, selected.id, 'required-ci run binding mismatch')
  if (job.run_attempt !== undefined) requireEqual(job.run_attempt, selected.runAttempt, 'required-ci attempt binding mismatch')
  requireEqual(job.head_sha, expected.sourceCommit, 'required-ci source binding mismatch')
  if (job.repository_id !== undefined) requireEqual(String(job.repository_id), EXPECTED_REPOSITORY_ID, 'required-ci repository binding mismatch')
  return { ...selected, requiredJobId: job.id, requiredJobName: job.name, requiredJobStatus: job.status, requiredJobConclusion: job.conclusion }
}

/** Classify the fixed crates.io API response before any authentication. */
export function classifyRegistryResponse({
  status,
  body,
  expectedVersion,
  expectedChecksum,
}) {
  const numericStatus = Number(status)
  if (numericStatus === 404) return { state: 'absent' }
  if (numericStatus !== 200) {
    return { state: 'http-error', status: numericStatus }
  }

  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    return { state: 'malformed' }
  }
  const version = payload?.version
  if (
    version === null ||
    typeof version !== 'object' ||
    Array.isArray(version) ||
    version.crate !== CRATE_NAME ||
    version.num !== expectedVersion ||
    typeof version.checksum !== 'string' ||
    !ARCHIVE_SHA256.test(version.checksum) ||
    typeof version.yanked !== 'boolean'
  ) {
    return { state: 'malformed' }
  }
  if (version.yanked !== false) return { state: 'yanked' }
  if (expectedChecksum !== undefined && version.checksum !== expectedChecksum) {
    return { state: 'conflict', checksum: version.checksum }
  }
  return { state: 'match', checksum: version.checksum }
}

/** Verify crate archive paths and Cargo's source provenance marker. */
export function verifyArchiveContents({
  fileList,
  manifest,
  vcsInfo,
  expectedVersion,
  expectedCommit,
}) {
  const entries = String(fileList)
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => entry.replace(/\/$/, ''))
  if (entries.length === 0) fail('Crate archive is empty')
  if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) {
    fail('Crate archive contains an unsafe path')
  }
  const roots = new Set(entries.map(entry => entry.split('/')[0]))
  const expectedRoot = `${CRATE_NAME}-${expectedVersion}`
  if (roots.size !== 1 || !roots.has(expectedRoot)) {
    fail(`Crate archive must contain only the ${expectedRoot} root`)
  }
  const requiredPaths = [
    `${expectedRoot}/Cargo.toml`,
    `${expectedRoot}/LICENSE`,
    `${expectedRoot}/README.md`,
    `${expectedRoot}/src/bitcoin.rs`,
    `${expectedRoot}/tests/bitcoin.rs`,
    `${expectedRoot}/.cargo_vcs_info.json`,
  ]
  for (const requiredPath of requiredPaths) {
    if (!entries.includes(requiredPath)) {
      fail(`Crate archive is missing ${requiredPath}`)
    }
  }

  if (manifest !== undefined) {
    const packageName = manifest.match(/^name = "([^"]+)"$/m)?.[1]
    const packageVersion = manifest.match(/^version = "([^"]+)"$/m)?.[1]
    if (packageName !== CRATE_NAME || packageVersion !== expectedVersion) {
      fail('Crate Cargo.toml package name/version does not match the expected artifact')
    }
  }

  let parsedVcs
  try {
    parsedVcs = JSON.parse(vcsInfo)
  } catch {
    fail('Crate .cargo_vcs_info.json is malformed')
  }
  const commit = parsedVcs?.git?.sha1 ?? parsedVcs?.git?.commit
  if (commit !== expectedCommit) {
    fail('Crate .cargo_vcs_info.json commit does not match the validated source')
  }
  if (parsedVcs?.git?.dirty !== undefined && parsedVcs.git.dirty !== false) {
    fail('Crate .cargo_vcs_info.json must prove a clean source tree')
  }
  if (parsedVcs?.path_in_vcs !== 'packages/rust') {
    fail('Crate .cargo_vcs_info.json has an unexpected path_in_vcs')
  }
  return { root: expectedRoot, commit, pathInVcs: parsedVcs.path_in_vcs }
}

/**
 * Select exactly one Cargo archive for the expected crate version. Cargo has
 * historically emitted both hyphenated and underscore spellings in different
 * contexts; a release must reject zero or multiple exact-version candidates.
 */
export async function selectArchive(archiveDirectory, expectedVersion) {
  requireStableVersion(expectedVersion, 'Expected version')
  const candidates = [
    join(archiveDirectory, `${CRATE_NAME}-${expectedVersion}.crate`),
    join(archiveDirectory, `${CRATE_NAME.replaceAll('-', '_')}-${expectedVersion}.crate`),
  ]
  const existing = []
  for (const candidate of candidates) {
    try {
      if ((await lstat(candidate)).isFile()) existing.push(resolve(candidate))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (existing.length !== 1) {
    fail(
      `Expected exactly one ${CRATE_NAME} ${expectedVersion} archive; ` +
        `found ${existing.length}`,
    )
  }
  return existing[0]
}

const env = name => {
  const value = process.env[name]
  if (value === undefined) fail(`Missing ${name}`)
  return value
}

const requireExactInternalMode = (arguments_, mode) => {
  if (arguments_.length !== 1 || arguments_[0] !== mode) {
    fail(`${mode} accepts exactly one mode argument`)
  }
}

const run = async arguments_ => {
  if (arguments_[0] === '--foundation-guard') {
    requireExactInternalMode(arguments_, '--foundation-guard')
    validateFoundationWorkflowContext({
      repository: env('REPOSITORY'),
      repositoryId: env('REPOSITORY_ID'),
      eventName: env('EVENT_NAME'),
      eventRef: env('EVENT_REF'),
      eventSha: env('EVENT_SHA'),
      expectedCommit: env('EXPECTED_COMMIT'),
      checkoutHead: env('CHECKOUT_HEAD'),
      checkoutStatus: env('CHECKOUT_STATUS'),
      expectedVersion: env('EXPECTED_VERSION'),
      mode: env('FOUNDATION_MODE'),
      workflowRef: env('WORKFLOW_REF'),
      workflowSha: env('WORKFLOW_SHA'),
    })
    console.log('foundation-source-guard-passed')
    return
  }

  if (arguments_[0] === '--foundation-describe-artifacts') {
    requireExactInternalMode(arguments_, '--foundation-describe-artifacts')
    const descriptors = await describeFoundationArtifacts(env('FOUNDATION_ARTIFACT_DIR'))
    await writeFile(env('FOUNDATION_ARTIFACT_METADATA_FILE'), `${canonicalJson(descriptors)}\n`)
    console.log('foundation-artifacts-described')
    return
  }

  if (arguments_[0] === '--foundation-go-inventory') {
    requireExactInternalMode(arguments_, '--foundation-go-inventory')
    const inventory = await buildGoInventory(env('FOUNDATION_GO_ROOT'))
    await writeFile(env('FOUNDATION_GO_INVENTORY_FILE'), `${canonicalJson(inventory)}\n`)
    console.log('foundation-go-inventory-built')
    return
  }

  if (arguments_[0] === '--foundation-plan') {
    requireExactInternalMode(arguments_, '--foundation-plan')
    const plan = buildFoundationPlan({
      sourceSha: env('FOUNDATION_SOURCE_SHA'),
      artifacts: JSON.parse(await readFile(env('FOUNDATION_ARTIFACT_METADATA_FILE'), 'utf8')),
      goInventory: JSON.parse(await readFile(env('FOUNDATION_GO_INVENTORY_FILE'), 'utf8')),
      rustReceipt: JSON.parse(await readFile(env('FOUNDATION_RUST_RECEIPT_FILE'), 'utf8')),
      registryPreflight: JSON.parse(await readFile(env('FOUNDATION_PREFLIGHT_FILE'), 'utf8')),
    })
    const planText = `${canonicalJson(plan)}\n`
    await writeFile(env('FOUNDATION_PLAN_FILE'), planText)
    await writeFile(env('FOUNDATION_BODY_FILE'), plan.githubRelease.body)
    await writeFile(env('FOUNDATION_PLAN_DIGEST_FILE'), `${sha256Hex(canonicalJson(plan))}\n`)
    console.log(`foundation-plan=${sha256Hex(canonicalJson(plan))}`)
    return
  }

  if (arguments_[0] === '--foundation-ci-select') {
    requireExactInternalMode(arguments_, '--foundation-ci-select')
    const workflow = JSON.parse(await readFile(env('FOUNDATION_CI_WORKFLOW_FILE'), 'utf8'))
    const runs = JSON.parse(await readFile(env('FOUNDATION_CI_RUNS_FILE'), 'utf8'))
    const selection = selectFoundationCIRun({ workflow, runs, expected: { sourceCommit: env('FOUNDATION_SOURCE_SHA') } })
    await writeFile(env('FOUNDATION_CI_SELECTION_FILE'), `${canonicalJson(selection)}\n`)
    console.log(`foundation-ci-selection=${canonicalJson(selection)}`)
    return
  }

  if (arguments_[0] === '--foundation-ci-proof') {
    requireExactInternalMode(arguments_, '--foundation-ci-proof')
    const evidence = validateFoundationCIProof({
      workflow: JSON.parse(await readFile(env('FOUNDATION_CI_WORKFLOW_FILE'), 'utf8')),
      runs: JSON.parse(await readFile(env('FOUNDATION_CI_RUNS_FILE'), 'utf8')),
      selection: JSON.parse(await readFile(env('FOUNDATION_CI_SELECTION_FILE'), 'utf8')),
      recheck: JSON.parse(await readFile(env('FOUNDATION_CI_RECHECK_FILE'), 'utf8')),
      jobs: JSON.parse(await readFile(env('FOUNDATION_CI_JOBS_FILE'), 'utf8')),
      expected: { sourceCommit: env('FOUNDATION_SOURCE_SHA') },
    })
    await writeFile(env('FOUNDATION_CI_EVIDENCE_FILE'), `${canonicalJson(evidence)}\n`)
    console.log(`foundation-ci-proof=${canonicalJson(evidence)}`)
    return
  }

  if (arguments_[0] === '--foundation-preparation') {
    requireExactInternalMode(arguments_, '--foundation-preparation')
    const observed = validateFoundationPreparationMetadata({
      run: JSON.parse(await readFile(env('FOUNDATION_PREPARATION_RUN_FILE'), 'utf8')),
      artifact: JSON.parse(await readFile(env('FOUNDATION_PREPARATION_ARTIFACT_FILE'), 'utf8')),
      bindingArtifact: JSON.parse(await readFile(env('FOUNDATION_PREPARATION_BINDING_ARTIFACT_FILE'), 'utf8')),
      expected: {
        runId: env('FOUNDATION_PREPARED_RUN_ID'),
        runAttempt: env('FOUNDATION_PREPARED_RUN_ATTEMPT'),
        artifactId: env('FOUNDATION_PREPARED_ARTIFACT_ID'),
        bindingArtifactId: env('FOUNDATION_PREPARED_BINDING_ARTIFACT_ID'),
        sourceCommit: env('FOUNDATION_SOURCE_SHA'),
      },
    })
    console.log(`foundation-preparation=${canonicalJson(observed)}`)
    return
  }

  if (arguments_[0] === '--foundation-verify') {
    requireExactInternalMode(arguments_, '--foundation-verify')
    const plan = JSON.parse(await readFile(env('FOUNDATION_PLAN_FILE'), 'utf8'))
    const normalized = validateFoundationPlan(plan)
    requireEqual(normalized.sourceCommit, env('FOUNDATION_SOURCE_SHA'), 'Foundation plan source does not match this checkout')
    const planDigest = sha256Hex(canonicalJson(normalized))
    requireEqual(planDigest, env('FOUNDATION_PLAN_SHA256'), 'Foundation plan digest does not match approval input')
    const binding = JSON.parse(await readFile(env('FOUNDATION_BINDING_FILE'), 'utf8'))
    validateFoundationBinding(binding, {
      sourceCommit: normalized.sourceCommit,
      planSha256: planDigest,
      runId: process.env.FOUNDATION_PREPARED_RUN_ID,
      runAttempt: process.env.FOUNDATION_PREPARED_RUN_ATTEMPT,
      artifactId: process.env.FOUNDATION_PREPARED_ARTIFACT_ID,
    })
    await verifyFoundationBundle({ plan: normalized, artifactDirectory: env('FOUNDATION_ARTIFACT_DIR') })
    console.log('foundation-bundle-verified')
    return
  }

  if (arguments_[0] === '--foundation-proof-verify') {
    requireExactInternalMode(arguments_, '--foundation-proof-verify')
    const plan = JSON.parse(await readFile(env('FOUNDATION_PLAN_FILE'), 'utf8'))
    const manifest = await verifyFoundationProofSet({
      plan,
      proofDirectory: env('FOUNDATION_PROOF_DIR'),
      manifestFile: env('FOUNDATION_PROOF_MANIFEST_FILE'),
      expected: {
        runId: env('FOUNDATION_PREPARED_RUN_ID'),
        runAttempt: env('FOUNDATION_PREPARED_RUN_ATTEMPT'),
        artifactId: env('FOUNDATION_PREPARED_ARTIFACT_ID'),
        receiptArtifactId: process.env.FOUNDATION_PROOF_RECEIPTS_ARTIFACT_ID || undefined,
      },
    })
    console.log(`foundation-proofs=${sha256Hex(canonicalJson(manifest))}`)
    return
  }

  if (arguments_[0] === '--foundation-registry') {
    requireExactInternalMode(arguments_, '--foundation-registry')
    const result = classifyFoundationRegistryResponse({
      registry: env('FOUNDATION_REGISTRY'),
      status: env('REGISTRY_STATUS'),
      body: await readFile(env('REGISTRY_RESPONSE_FILE'), 'utf8'),
      expectedVersion: process.env.EXPECTED_VERSION ?? FOUNDATION_VERSION,
      expectedArtifacts: process.env.EXPECTED_ARTIFACTS ? JSON.parse(process.env.EXPECTED_ARTIFACTS) : [],
      expectedSha256: process.env.EXPECTED_SHA256 || undefined,
    })
    console.log(result.state)
    if (process.env.FOUNDATION_REGISTRY === 'rust' && result.state !== 'match') fail(`Rust reuse registry check stopped in ${result.state} state`)
    if (!['absent', 'match', 'partial'].includes(result.state)) fail(`Foundation registry check stopped in ${result.state} state`)
    return
  }

  if (arguments_[0] === '--foundation-pypi-proof') {
    requireExactInternalMode(arguments_, '--foundation-pypi-proof')
    const downloads = validateFoundationPyPIResponse({
      body: await readFile(env('REGISTRY_RESPONSE_FILE'), 'utf8'),
      expectedVersion: env('EXPECTED_VERSION'),
      expectedFiles: JSON.parse(env('EXPECTED_ARTIFACTS')),
      expectedSha256: JSON.parse(env('EXPECTED_SHA256S')),
    })
    await writeFile(env('FOUNDATION_DOWNLOADS_FILE'), `${downloads.map(file => `${file.filename}\t${file.url}\t${file.sha256}`).join('\n')}\n`)
    console.log('foundation-pypi-proof-passed')
    return
  }

  if (arguments_[0] === '--workflow-guard') {
    requireExactInternalMode(arguments_, '--workflow-guard')
    validateWorkflowContext({
      repository: env('REPOSITORY'),
      repositoryId: env('REPOSITORY_ID'),
      eventName: env('EVENT_NAME'),
      eventRef: env('EVENT_REF'),
      eventSha: env('EVENT_SHA'),
      expectedCommit: env('EXPECTED_COMMIT'),
      checkoutHead: env('CHECKOUT_HEAD'),
      expectedVersion: env('EXPECTED_VERSION'),
      publish: env('PUBLISH'),
      approvedSha256: process.env.APPROVED_SHA256 ?? '',
    })
    console.log('Rust release source and input guard passed.')
    return
  }

  if (arguments_[0] === '--registry-check') {
    requireExactInternalMode(arguments_, '--registry-check')
    const result = classifyRegistryResponse({
      status: env('REGISTRY_STATUS'),
      body: await readFile(env('REGISTRY_RESPONSE_FILE'), 'utf8'),
      expectedVersion: env('EXPECTED_VERSION'),
      expectedChecksum: process.env.APPROVED_SHA256 || undefined,
    })
    console.log(`${result.state}${result.checksum ? `:${result.checksum}` : ''}`)
    if (result.state !== 'absent' && result.state !== 'match') {
      fail(`Registry check stopped in ${result.state} state`)
    }
    return
  }

  if (arguments_[0] === '--archive-check') {
    requireExactInternalMode(arguments_, '--archive-check')
    verifyArchiveContents({
      fileList: await readFile(env('ARCHIVE_LIST_FILE'), 'utf8'),
      manifest: await readFile(env('MANIFEST_FILE'), 'utf8'),
      vcsInfo: await readFile(env('VCS_INFO_FILE'), 'utf8'),
      expectedVersion: env('EXPECTED_VERSION'),
      expectedCommit: env('EXPECTED_COMMIT'),
    })
    console.log('Published crate archive provenance and required files passed.')
    return
  }

  if (arguments_[0] === '--select-archive') {
    requireExactInternalMode(arguments_, '--select-archive')
    const archivePath = await selectArchive(
      env('ARCHIVE_DIR'),
      env('EXPECTED_VERSION'),
    )
    console.log(archivePath)
    return
  }

  const options = parseReleaseArguments(arguments_)
  const data = await readReleaseData(REPOSITORY_ROOT, options.scope)
  const result = validateReleaseData(data, options)
  const label = result.scope === 'rust'
    ? 'Rust crate'
    : result.scope === 'non-rust'
      ? 'Non-Rust packages'
      : 'All package cohorts'
  console.log(`${label} validated at version ${result.version}${options.tag ? ` (${options.tag})` : ''}.`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath !== null && import.meta.url === invokedPath) {
  run(process.argv.slice(2)).catch(error => {
    process.stderr.write(`verify-release: ${error.message}\n`)
    process.exitCode = 1
  })
}
