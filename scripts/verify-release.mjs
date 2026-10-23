import { createHash } from 'node:crypto'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
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

// Future release-set preparation is intentionally separate from foundation v1.
// A plan describes approved inputs and prepared bytes; it never stands in for
// a public registry or GitHub observation.
export const RELEASE_SET_SCHEMA_VERSION = 2
export const RELEASE_SET_KIND = 'erpc-sdk-release-set-approval-plan'
export const RELEASE_SET_BINDING_KIND = 'erpc-sdk-release-set-preparation-binding'
export const RELEASE_SET_WORKFLOW = '.github/workflows/release.yml'
export const RELEASE_SET_CI_WORKFLOW = '.github/workflows/ci.yml'
export const RELEASE_SET_ARTIFACT_KINDS = Object.freeze([
  'npm',
  'pypi-wheel',
  'pypi-sdist',
  'rubygems',
])
export const RELEASE_SET_RUST_MODES = Object.freeze(['reuse', 'publish'])
export const RELEASE_SET_PUBLIC_ASSET_ROLES = Object.freeze([
  'npm',
  'pypi-wheel',
  'pypi-sdist',
  'rubygems',
  'go-proof',
  'npm-proof',
  'pypi-proof',
  'rubygems-proof',
  'rust-proof',
  'tag-proof',
  'release-set-proof-manifest',
  'release-body',
  'go-inventory',
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

const commandText = async (command, arguments_, execution = {}) => {
  const executor = execution.execFile ?? execFile
  const resolvedCommand = execution.commandMap?.[command] ?? command
  const result = await executor(resolvedCommand, arguments_, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...(execution.execOptions ?? {}) })
  return result.stdout.trim()
}

const commandBuffer = async (command, arguments_, execution = {}) => {
  const executor = execution.execFile ?? execFile
  const resolvedCommand = execution.commandMap?.[command] ?? command
  const result = await executor(resolvedCommand, arguments_, { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, ...(execution.execOptions ?? {}) })
  return result.stdout
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

const archiveEntries = async (filePath, kind, execution = {}) => {
  const raw = await commandText('python3', ['-c', archiveInspectionScript, filePath, kind], execution)
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

const archiveFiles = async (filePath, kind = filePath.endsWith('.whl') ? 'zip' : 'tar', execution = {}) =>
  archiveEntries(filePath, kind, execution)

const archiveText = async (filePath, member, wheel = false, execution = {}) => {
  const output = wheel
    ? await commandText('unzip', ['-p', filePath, member], execution)
    : await commandText('tar', ['-xOf', filePath, member], execution)
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

const releaseSetObject = (value, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

const releaseSetKeys = (value, keys, label) => {
  releaseSetObject(value, label)
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} contains unknown field ${key}`)
  return value
}

const releaseSetString = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is missing`)
  return value
}

const releaseSetVersion = (value, label) => requireStableVersion(value, label)

const releaseSetArtifactFilename = (kind, version) => ({
  npm: `elsoul-erpc-sdk-${version}.tgz`,
  'pypi-wheel': `erpc_sdk-${version}-py3-none-any.whl`,
  'pypi-sdist': `erpc_sdk-${version}.tar.gz`,
  rubygems: `erpc-sdk-${version}.gem`,
}[kind])

const releaseSetArtifactName = kind => kind === 'npm' ? '@elsoul/erpc-sdk' : 'erpc-sdk'

const releaseSetAssetFilename = role => ({
  'go-proof': 'go-proof.json',
  'npm-proof': 'npm-proof.json',
  'pypi-proof': 'pypi-proof.json',
  'rubygems-proof': 'rubygems-proof.json',
  'rust-proof': 'rust-proof.json',
  'tag-proof': 'tag-proof.json',
  'release-set-proof-manifest': 'release-set-proof-manifest.json',
  'release-body': 'release-body.md',
  'go-inventory': 'go-inventory.json',
}[role])

const releaseSetExpectedBundleFiles = plan => [
  ...plan.artifacts.map(artifact => artifact.filename),
  ...(plan.rust.mode === 'publish' ? [plan.rust.archive.filename] : []),
  'release-set-plan.json',
  'release-set-plan.sha256',
  'release-body.md',
  'go-inventory.json',
  'checksums.txt',
]

const releaseSetNormalizeChecksumPath = value => {
  if (typeof value !== 'string') fail('Release-set checksum filename is missing')
  let normalized = value.trim()
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  safeRelativePath(normalized)
  return normalized
}

export function parseReleaseSetChecksums(source) {
  const records = String(source).split(/\r?\n/).filter(Boolean)
  if (records.length === 0) fail('Release-set checksum manifest is empty')
  const checksums = new Map()
  for (const line of records) {
    const match = line.match(/^([0-9a-f]{64})\s+(?:\*?)(.+)$/)
    if (!match) fail('Release-set checksum manifest has a malformed line')
    const filename = releaseSetNormalizeChecksumPath(match[2])
    if (checksums.has(filename)) fail(`Release-set checksum manifest duplicates ${filename}`)
    checksums.set(filename, match[1])
  }
  return checksums
}

const releaseSetValidateArtifact = (descriptor, expectedVersion) => {
  releaseSetKeys(descriptor, ['kind', 'filename', 'name', 'version', 'sha256', 'files'], 'Release-set artifact')
  if (!RELEASE_SET_ARTIFACT_KINDS.includes(descriptor.kind)) fail(`Unknown release-set artifact kind ${descriptor.kind}`)
  releaseSetVersion(expectedVersion, 'Release-set non-Rust version')
  requireEqual(descriptor.version, expectedVersion, `${descriptor.kind} release-set version mismatch`)
  requireEqual(descriptor.filename, releaseSetArtifactFilename(descriptor.kind, expectedVersion), `${descriptor.kind} release-set filename mismatch`)
  requireEqual(descriptor.name, releaseSetArtifactName(descriptor.kind), `${descriptor.kind} release-set identity mismatch`)
  requireArchiveSha(descriptor.sha256, `${descriptor.kind} release-set archive SHA-256`)
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0) fail(`${descriptor.kind} release-set member list is empty`)
  const files = descriptor.files.map(member => safeRelativePath(member))
  if (new Set(files).size !== files.length) fail(`${descriptor.kind} release-set member list contains duplicates`)
  return { ...descriptor, files }
}

const releaseSetValidateRust = (rust, planSourceCommit) => {
  releaseSetKeys(rust, ['mode', 'version', 'sourceCommit', 'sha256', 'archive', 'reuse', 'prepared'], 'Release-set Rust descriptor')
  if (!RELEASE_SET_RUST_MODES.includes(rust.mode)) fail('Release-set Rust mode is invalid')
  releaseSetVersion(rust.version, 'Release-set Rust version')
  requireArchiveSha(rust.sha256, 'Release-set Rust archive SHA-256')
  if (rust.mode === 'reuse') {
    if (rust.prepared !== undefined || rust.archive !== undefined) fail('Rust reuse cannot include prepared archive fields')
    requireSha(rust.sourceCommit, 'Rust reuse source commit')
    requireEqual(rust.sourceCommit, rust.reuse?.sourceCommit, 'Rust reuse top-level/source intent mismatch')
    requireEqual(rust.sha256, rust.reuse?.sha256, 'Rust reuse top-level/checksum intent mismatch')
    releaseSetKeys(rust.reuse, ['registry', 'downloadUrl', 'sourceCommit', 'sha256', 'yanked'], 'Rust reuse intent')
    requireEqual(rust.reuse.registry, 'crates.io', 'Rust reuse registry mismatch')
    requireEqual(rust.reuse.downloadUrl, `https://crates.io/api/v1/crates/${CRATE_NAME}/${rust.version}/download`, 'Rust reuse download URL mismatch')
    requireSha(rust.reuse.sourceCommit, 'Rust reuse source commit')
    requireArchiveSha(rust.reuse.sha256, 'Rust reuse checksum')
    requireEqual(rust.reuse.sha256, rust.sha256, 'Rust reuse checksum mismatch')
    requireEqual(rust.reuse.yanked, false, 'Rust reuse must prove an unyanked intent')
    if (rust.version === RUST_VERSION) {
      requireEqual(rust.reuse.sourceCommit, FOUNDATION_RUST_SOURCE, 'Historical Rust reuse source mismatch')
      requireEqual(rust.reuse.sha256, FOUNDATION_RUST_SHA256, 'Historical Rust reuse checksum mismatch')
    }
    return { ...rust }
  }
  if (rust.version === RUST_VERSION) fail('Rust 0.10 cannot be a future publish candidate')
  if (rust.reuse !== undefined) fail('Rust publish cannot include a reuse intent')
  requireEqual(rust.sourceCommit, planSourceCommit, 'Prepared Rust source must bind to the plan source')
  releaseSetKeys(rust.archive, ['filename', 'sha256'], 'Prepared Rust archive')
  requireEqual(rust.archive.filename, `${CRATE_NAME}-${rust.version}.crate`, 'Prepared Rust archive filename mismatch')
  requireEqual(rust.archive.sha256, rust.sha256, 'Prepared Rust archive checksum mismatch')
  releaseSetKeys(rust.prepared, ['runId', 'runAttempt', 'artifactId', 'bindingArtifactId', 'sourceCommit', 'archiveSha256', 'licenseProfile'], 'Prepared Rust binding')
  requireEqual(rust.prepared.licenseProfile, 'MIT AND Apache-2.0', 'Prepared Rust license profile is not the approved named profile')
  for (const [value, label] of [[rust.prepared.runId, 'Rust preparation run ID'], [rust.prepared.runAttempt, 'Rust preparation attempt'], [rust.prepared.artifactId, 'Rust preparation artifact ID'], [rust.prepared.bindingArtifactId, 'Rust preparation binding artifact ID']]) requirePositiveId(value, label)
  requireEqual(rust.prepared.sourceCommit, rust.sourceCommit, 'Prepared Rust binding source mismatch')
  requireEqual(rust.prepared.archiveSha256, rust.sha256, 'Prepared Rust binding checksum mismatch')
  return { ...rust }
}

/** Validate only stable approved content. No public observation or mutation is performed here. */
export function validateReleaseSetPlan(plan) {
  releaseSetKeys(plan, [
    'schemaVersion', 'kind', 'repository', 'repositoryId', 'workflowPath', 'ciWorkflowPath',
    'sourceCommit', 'controlCommit', 'workflowRevision', 'event', 'checkoutHead', 'checkoutStatus',
    'versions', 'artifacts', 'go', 'rust', 'ciProof', 'tags', 'githubRelease', 'approval',
    'licenseProfile', 'toolchain',
  ], 'Release-set plan')
  requireEqual(plan.schemaVersion, RELEASE_SET_SCHEMA_VERSION, 'Unsupported release-set schema')
  requireEqual(plan.kind, RELEASE_SET_KIND, 'Unexpected release-set kind')
  requireEqual(plan.repository, EXPECTED_REPOSITORY, 'Release-set repository mismatch')
  requireEqual(String(plan.repositoryId), EXPECTED_REPOSITORY_ID, 'Release-set repository ID mismatch')
  requireEqual(plan.workflowPath, RELEASE_SET_WORKFLOW, 'Release-set workflow mismatch')
  requireEqual(plan.ciWorkflowPath, RELEASE_SET_CI_WORKFLOW, 'Release-set CI workflow mismatch')
  requireSha(plan.sourceCommit, 'Release-set source commit')
  requireEqual(plan.controlCommit, plan.sourceCommit, 'Release-set control commit mismatch')
  requireEqual(plan.workflowRevision, plan.sourceCommit, 'Release-set workflow revision mismatch')
  requireEqual(plan.checkoutHead, plan.sourceCommit, 'Release-set checkout head mismatch')
  requireEqual(plan.checkoutStatus, '', 'Release-set checkout must be clean')
  releaseSetKeys(plan.event, ['name', 'ref', 'sha'], 'Release-set event')
  requireEqual(plan.event.name, 'workflow_dispatch', 'Release-set event must be workflow_dispatch')
  requireEqual(plan.event.ref, 'refs/heads/main', 'Release-set event must run on main')
  requireEqual(plan.event.sha, plan.sourceCommit, 'Release-set event SHA mismatch')
  releaseSetKeys(plan.versions, ['nonRustVersion', 'rustVersion'], 'Release-set versions')
  releaseSetVersion(plan.versions.nonRustVersion, 'Release-set non-Rust version')
  releaseSetVersion(plan.versions.rustVersion, 'Release-set Rust version')
  if (plan.versions.nonRustVersion === FOUNDATION_VERSION) fail('Completed foundation non-Rust version cannot be a future target')
  const artifactMap = new Map()
  if (!Array.isArray(plan.artifacts) || plan.artifacts.length !== RELEASE_SET_ARTIFACT_KINDS.length) fail('Release-set artifact set is incomplete')
  for (const descriptor of plan.artifacts) {
    const normalized = releaseSetValidateArtifact(descriptor, plan.versions.nonRustVersion)
    if (artifactMap.has(normalized.kind)) fail('Release-set artifact roles are duplicated')
    artifactMap.set(normalized.kind, normalized)
  }
  if (artifactMap.size !== RELEASE_SET_ARTIFACT_KINDS.length || RELEASE_SET_ARTIFACT_KINDS.some(kind => !artifactMap.has(kind))) fail('Release-set artifact roles are incomplete')
  releaseSetKeys(plan.go, ['module', 'version', 'tag', 'sourceCommit', 'inventory'], 'Release-set Go descriptor')
  requireEqual(plan.go.module, 'github.com/elsoul/erpc-sdk/packages/go', 'Release-set Go module mismatch')
  requireEqual(plan.go.version, `v${plan.versions.nonRustVersion}`, 'Release-set Go version mismatch')
  requireEqual(plan.go.tag, `packages/go/v${plan.versions.nonRustVersion}`, 'Release-set Go tag mismatch')
  requireEqual(plan.go.sourceCommit, plan.sourceCommit, 'Release-set Go source mismatch')
  const goInventory = validateGoInventory(plan.go.inventory)
  const rust = releaseSetValidateRust(plan.rust, plan.sourceCommit)
  requireEqual(rust.version, plan.versions.rustVersion, 'Release-set Rust version mismatch')
  releaseSetKeys(plan.ciProof, ['workflowPath', 'sourceCommit', 'runId', 'runAttempt', 'jobId', 'requiredJob', 'event', 'headBranch', 'status', 'conclusion'], 'Release-set CI proof')
  requireEqual(plan.ciProof.workflowPath, RELEASE_SET_CI_WORKFLOW, 'Release-set CI proof workflow mismatch')
  requireEqual(plan.ciProof.sourceCommit, plan.sourceCommit, 'Release-set CI proof source mismatch')
  for (const [value, label] of [[plan.ciProof.runId, 'Release-set CI run ID'], [plan.ciProof.runAttempt, 'Release-set CI attempt'], [plan.ciProof.jobId, 'Release-set CI job ID']]) requirePositiveId(value, label)
  requireEqual(plan.ciProof.requiredJob, FOUNDATION_CI_JOB, 'Release-set CI job mismatch')
  requireEqual(plan.ciProof.event, 'push', 'Release-set CI event mismatch')
  requireEqual(plan.ciProof.headBranch, 'main', 'Release-set CI branch mismatch')
  requireEqual(plan.ciProof.status, 'completed', 'Release-set CI status mismatch')
  requireEqual(plan.ciProof.conclusion, 'success', 'Release-set CI conclusion mismatch')
  releaseSetKeys(plan.tags, ['release', 'go', 'commit'], 'Release-set tags')
  requireEqual(plan.tags.release, `non-rust-v${plan.versions.nonRustVersion}`, 'Release-set release tag mismatch')
  requireEqual(plan.tags.go, `packages/go/v${plan.versions.nonRustVersion}`, 'Release-set Go tag mismatch')
  requireEqual(plan.tags.commit, plan.sourceCommit, 'Release-set tag source mismatch')
  releaseSetKeys(plan.githubRelease, ['title', 'tag', 'body', 'bodySha256'], 'Release-set Release descriptor')
  requireEqual(plan.githubRelease.title, `SDK release set: non-Rust ${plan.versions.nonRustVersion} / Rust ${plan.versions.rustVersion}`, 'Release-set Release title mismatch')
  requireEqual(plan.githubRelease.tag, plan.tags.release, 'Release-set Release tag mismatch')
  releaseSetString(plan.githubRelease.body, 'Release-set Release body')
  requireEqual(plan.githubRelease.bodySha256, sha256Hex(plan.githubRelease.body), 'Release-set Release body hash mismatch')
  releaseSetKeys(plan.licenseProfile, ['nonRust', 'rust'], 'Release-set license profile')
  requireEqual(plan.licenseProfile.nonRust, 'MIT', 'Release-set non-Rust license mismatch')
  releaseSetString(plan.licenseProfile.rust, 'Release-set Rust license profile')
  requireEqual(plan.licenseProfile.rust, rust.mode === 'reuse' ? 'MIT' : 'MIT AND Apache-2.0', 'Release-set Rust license profile does not match mode')
  releaseSetKeys(plan.toolchain, ['node', 'python', 'go', 'ruby', 'rust'], 'Release-set toolchain')
  const requiredToolchain = { node: '24', python: '3.12', go: '1.22', ruby: '3.1', rust: '1.85.0' }
  for (const [tool, value] of Object.entries(requiredToolchain)) requireEqual(plan.toolchain[tool], value, `Release-set ${tool} toolchain mismatch`)
  releaseSetKeys(plan.approval, ['environments', 'effects', 'publicAssets', 'bundleFiles'], 'Release-set approval')
  releaseSetKeys(plan.approval.environments, ['npm', 'pypi', 'rubygems', 'cratesIo'], 'Release-set environments')
  const requiredEnvironments = { npm: 'npm', pypi: 'pypi', rubygems: 'rubygems', cratesIo: 'crates-io' }
  for (const [name, environment] of Object.entries(requiredEnvironments)) {
    releaseSetString(plan.approval.environments[name], `Release-set ${name} environment`)
    requireEqual(plan.approval.environments[name], environment, `Release-set ${name} environment mismatch`)
  }
  const allowedEffects = new Set(['publish npm', 'publish PyPI', 'publish RubyGems', 'create tags', 'create GitHub Release'])
  if (!Array.isArray(plan.approval.effects) || plan.approval.effects.length !== allowedEffects.size || plan.approval.effects.some(effect => !allowedEffects.has(effect)) || new Set(plan.approval.effects).size !== plan.approval.effects.length) fail('Release-set effects are not the approved closed set')
  if (!Array.isArray(plan.approval.publicAssets) || plan.approval.publicAssets.length !== RELEASE_SET_PUBLIC_ASSET_ROLES.length + (rust.mode === 'publish' ? 1 : 0)) fail('Release-set public asset roles are incomplete')
  const publicRoles = new Set()
  for (const asset of plan.approval.publicAssets) {
    releaseSetKeys(asset, ['role', 'filename'], 'Release-set public asset')
    if (!RELEASE_SET_PUBLIC_ASSET_ROLES.includes(asset.role) && !(rust.mode === 'publish' && asset.role === 'rust-crate')) fail(`Unknown Release-set public asset role ${asset.role}`)
    if (publicRoles.has(asset.role)) fail('Release-set public asset roles are duplicated')
    publicRoles.add(asset.role)
    const expectedFilename = RELEASE_SET_ARTIFACT_KINDS.includes(asset.role) ? artifactMap.get(asset.role).filename : asset.role === 'rust-crate' ? rust.archive.filename : releaseSetAssetFilename(asset.role)
    requireEqual(asset.filename, expectedFilename, `Release-set public asset filename mismatch for ${asset.role}`)
    safeRelativePath(asset.filename)
  }
  const expectedRoles = [...RELEASE_SET_PUBLIC_ASSET_ROLES, ...(rust.mode === 'publish' ? ['rust-crate'] : [])]
  if (publicRoles.size !== expectedRoles.length || expectedRoles.some(role => !publicRoles.has(role))) fail('Release-set public asset roles are incomplete')
  const expectedBundle = [
    ...RELEASE_SET_ARTIFACT_KINDS.map(kind => artifactMap.get(kind).filename),
    ...(rust.mode === 'publish' ? [rust.archive.filename] : []),
    'release-set-plan.json', 'release-set-plan.sha256', 'release-body.md', 'go-inventory.json', 'checksums.txt',
  ]
  if (!Array.isArray(plan.approval.bundleFiles) || canonicalJson(plan.approval.bundleFiles) !== canonicalJson(expectedBundle)) fail('Release-set preparation bundle file set is not canonical')
  return { ...plan, artifacts: [...artifactMap.values()], go: { ...plan.go, inventory: goInventory }, rust }
}

export function buildReleaseSetPlan(input) {
  releaseSetObject(input, 'Release-set plan input')
  return validateReleaseSetPlan({ ...input, schemaVersion: RELEASE_SET_SCHEMA_VERSION, kind: RELEASE_SET_KIND })
}

export const releaseSetPlanDigest = plan => sha256Hex(canonicalJson(validateReleaseSetPlan(plan)))

/** Bind runtime event/checkout identity to an already validated stable plan. */
export function validateReleaseSetContext(context, plan) {
  const normalized = validateReleaseSetPlan(plan)
  releaseSetKeys(context, ['repository', 'repositoryId', 'eventName', 'eventRef', 'eventSha', 'expectedCommit', 'checkoutHead', 'checkoutStatus', 'workflowRef', 'workflowSha'], 'Release-set execution context')
  requireEqual(context.repository, EXPECTED_REPOSITORY, 'Release-set execution repository mismatch')
  requireEqual(String(context.repositoryId), EXPECTED_REPOSITORY_ID, 'Release-set execution repository ID mismatch')
  requireEqual(context.eventName, 'workflow_dispatch', 'Release-set execution must be manually dispatched')
  requireEqual(context.eventRef, 'refs/heads/main', 'Release-set execution must run on main')
  requireEqual(context.expectedCommit, normalized.sourceCommit, 'Release-set execution expected commit mismatch')
  requireEqual(context.eventSha, normalized.sourceCommit, 'Release-set execution event SHA mismatch')
  requireEqual(context.checkoutHead, normalized.sourceCommit, 'Release-set execution checkout mismatch')
  requireEqual(context.checkoutStatus, '', 'Release-set execution checkout must be clean')
  requireEqual(context.workflowRef, `${EXPECTED_REPOSITORY}/${RELEASE_SET_WORKFLOW}@refs/heads/main`, 'Release-set execution workflow ref mismatch')
  requireEqual(context.workflowSha, normalized.sourceCommit, 'Release-set execution workflow SHA mismatch')
  return { sourceCommit: normalized.sourceCommit }
}

export function validateReleaseSetPreparationBinding(binding, { plan, expected = {} }) {
  const normalized = validateReleaseSetPlan(plan)
  releaseSetKeys(binding, ['schemaVersion', 'kind', 'repository', 'repositoryId', 'workflowPath', 'sourceCommit', 'versions', 'runId', 'runAttempt', 'artifactId', 'bindingArtifactId', 'planSha256'], 'Release-set preparation binding')
  requireEqual(binding.schemaVersion, RELEASE_SET_SCHEMA_VERSION, 'Release-set binding schema mismatch')
  requireEqual(binding.kind, RELEASE_SET_BINDING_KIND, 'Release-set binding kind mismatch')
  requireEqual(binding.repository, EXPECTED_REPOSITORY, 'Release-set binding repository mismatch')
  requireEqual(String(binding.repositoryId), EXPECTED_REPOSITORY_ID, 'Release-set binding repository ID mismatch')
  requireEqual(binding.workflowPath, RELEASE_SET_WORKFLOW, 'Release-set binding workflow mismatch')
  requireEqual(binding.sourceCommit, normalized.sourceCommit, 'Release-set binding source mismatch')
  releaseSetKeys(binding.versions, ['nonRustVersion', 'rustVersion'], 'Release-set binding versions')
  requireEqual(binding.versions.nonRustVersion, normalized.versions.nonRustVersion, 'Release-set binding non-Rust version mismatch')
  requireEqual(binding.versions.rustVersion, normalized.versions.rustVersion, 'Release-set binding Rust version mismatch')
  for (const [value, label] of [[binding.runId, 'Release-set binding run ID'], [binding.runAttempt, 'Release-set binding attempt'], [binding.artifactId, 'Release-set binding artifact ID'], [binding.bindingArtifactId, 'Release-set binding artifact ID']]) requirePositiveId(value, label)
  requireArchiveSha(binding.planSha256, 'Release-set binding plan hash')
  requireEqual(binding.planSha256, releaseSetPlanDigest(normalized), 'Release-set binding plan hash mismatch')
  for (const key of ['runId', 'runAttempt', 'artifactId', 'bindingArtifactId']) if (expected[key] !== undefined) requireEqual(String(binding[key]), String(expected[key]), `Release-set binding ${key} mismatch`)
  return binding
}

const releaseSetMemberSet = (left, right, label) => {
  if (canonicalJson([...left].sort()) !== canonicalJson([...right].sort())) fail(`${label} member set mismatch`)
}

const releaseSetReadMetadata = async (filePath, kind, version, name, execution = {}) => {
  const members = await archiveEntries(filePath, kind === 'pypi-wheel' ? 'zip' : 'tar', execution)
  if (kind === 'npm') {
    const metadataPath = 'package/package.json'
    if (!members.includes(metadataPath)) fail('npm archive is missing package/package.json')
    const metadata = JSON.parse(await archiveText(filePath, metadataPath, false, execution))
    if (metadata.name !== name || metadata.version !== version) fail('npm archive identity/version mismatch')
    if (!members.includes('package/LICENSE') || !members.includes('package/README.md') || !members.some(member => member.startsWith('package/dist/'))) fail('npm archive is missing required package files')
  } else if (kind === 'pypi-wheel' || kind === 'pypi-sdist') {
    const metadataPath = members.find(member => kind === 'pypi-wheel' ? /\.dist-info\/METADATA$/.test(member) : /(?:^|\/)PKG-INFO$/.test(member))
    if (!metadataPath) fail(`${kind} archive metadata is missing`)
    const metadata = await archiveText(filePath, metadataPath, kind === 'pypi-wheel', execution)
    if (metadataValue(metadata, 'Name') !== name || metadataValue(metadata, 'Version') !== version) fail(`${kind} archive identity/version mismatch`)
  } else if (kind === 'rubygems') {
    const specification = JSON.parse(await commandText('ruby', ['-rrubygems/package', '-rjson', '-e', 'spec = Gem::Package.new(ARGV.fetch(0)).spec; puts JSON.generate({"name" => spec.name, "version" => spec.version.to_s, "platform" => spec.platform.to_s, "files" => spec.files})', filePath], execution))
    if (specification.name !== name || specification.version !== version || specification.platform !== 'ruby') fail('Ruby gem identity/version/platform mismatch')
    const outerMembers = new Set(members)
    const expectedOuterMembers = new Set(['metadata.gz', 'data.tar.gz', 'checksums.yaml.gz'])
    if (outerMembers.size !== expectedOuterMembers.size || [...expectedOuterMembers].some(member => !outerMembers.has(member))) fail('Ruby gem outer member set mismatch')
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'erpc-sdk-release-set-gem-'))
    try {
      const dataTar = await commandBuffer('tar', ['-xOf', filePath, 'data.tar.gz'], execution)
      const dataPath = join(temporaryDirectory, 'data.tar.gz')
      await writeFile(dataPath, dataTar)
      const dataMembers = await archiveEntries(dataPath, 'tar', execution)
      releaseSetMemberSet(dataMembers, specification.files, 'Ruby gem specification/data')
      return dataMembers
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
  return members
}

const releaseSetInspectRustArchive = async (filePath, version, expectedCommit) => {
  const members = await archiveEntries(filePath, 'tar')
  const root = `${CRATE_NAME}-${version}`
  const roots = new Set(members.map(member => member.split('/')[0]))
  if (roots.size !== 1 || !roots.has(root)) fail(`Rust archive must contain exactly one ${root} root`)
  const required = [`${root}/Cargo.toml`, `${root}/LICENSE`, `${root}/README.md`, `${root}/.cargo_vcs_info.json`]
  for (const member of required) if (!members.includes(member)) fail(`Rust archive is missing ${member}`)
  const manifest = await archiveText(filePath, `${root}/Cargo.toml`)
  const packageSections = manifest.match(/^\[package\]\s*$/gm) ?? []
  if (packageSections.length !== 1) fail('Rust archive Cargo.toml must contain exactly one [package] table')
  const packageBody = manifest.split(/^\[package\]\s*$/m)[1]?.split(/^\[[^\]]+\]\s*$/m)[0] ?? ''
  if (packageBody.match(/^name\s*=\s*"([^"]+)"$/m)?.[1] !== CRATE_NAME || packageBody.match(/^version\s*=\s*"([^"]+)"$/m)?.[1] !== version) fail('Rust archive [package] identity/version mismatch')
  let vcs
  try { vcs = JSON.parse(await archiveText(filePath, `${root}/.cargo_vcs_info.json`)) } catch { fail('Rust archive VCS metadata is malformed') }
  if ((vcs.git?.sha1 ?? vcs.git?.commit) !== expectedCommit || (vcs.git?.dirty !== undefined && vcs.git.dirty !== false) || vcs.path_in_vcs !== 'packages/rust') fail('Rust archive VCS provenance mismatch')
  return members
}

export async function inspectReleaseSetRustArchiveBytes({ filePath, version, sourceCommit }) {
  return releaseSetInspectRustArchive(filePath, version, sourceCommit)
}

export async function inspectReleaseSetRubyGemBytes({ filePath, name, version }) {
  return releaseSetReadMetadata(filePath, 'rubygems', version, name)
}

/** Read and validate genuine prepared archive bytes; plaintext files fail closed. */
export async function inspectReleaseSetArtifactBytes(descriptor, filePath, expectedSourceCommit, execution = {}) {
  if (await sha256File(filePath) !== descriptor.sha256) fail(`Prepared artifact bytes do not match ${descriptor.filename}`)
  const members = await releaseSetReadMetadata(filePath, descriptor.kind, descriptor.version, descriptor.name, execution)
  releaseSetMemberSet(members, descriptor.files, descriptor.kind)
  return { filename: descriptor.filename, sha256: descriptor.sha256, members }
}

/** Verify the complete prepared bundle and return prepared-byte evidence only. */
export async function ingestReleaseSetBundle({ plan, artifactDirectory }) {
  const normalized = validateReleaseSetPlan(plan)
  const expectedFiles = releaseSetExpectedBundleFiles(normalized)
  const entries = await readdir(artifactDirectory, { withFileTypes: true })
  if (entries.length !== expectedFiles.length || entries.some(entry => !entry.isFile() || !expectedFiles.includes(entry.name))) fail('Release-set bundle has missing, extra, or non-file members')
  const planBytes = JSON.parse(await readFile(join(artifactDirectory, 'release-set-plan.json'), 'utf8'))
  requireEqual(canonicalJson(planBytes), canonicalJson(normalized), 'Release-set plan sidecar mismatch')
  requireEqual((await readFile(join(artifactDirectory, 'release-set-plan.sha256'), 'utf8')).trim(), releaseSetPlanDigest(normalized), 'Release-set plan digest sidecar mismatch')
  requireEqual(await readFile(join(artifactDirectory, 'release-body.md'), 'utf8'), normalized.githubRelease.body, 'Release-set body sidecar mismatch')
  requireEqual(canonicalJson(JSON.parse(await readFile(join(artifactDirectory, 'go-inventory.json'), 'utf8'))), canonicalJson(normalized.go.inventory), 'Release-set Go inventory sidecar mismatch')
  const checksums = parseReleaseSetChecksums(await readFile(join(artifactDirectory, 'checksums.txt'), 'utf8'))
  const checksumExpected = expectedFiles.filter(file => file !== 'checksums.txt')
  if (checksums.size !== checksumExpected.length || checksumExpected.some(file => !checksums.has(file))) fail('Release-set checksum manifest file set mismatch')
  for (const filename of checksumExpected) requireEqual(checksums.get(filename), await sha256File(join(artifactDirectory, filename)), `Release-set checksum mismatch for ${filename}`)
  const prepared = []
  for (const artifact of normalized.artifacts) prepared.push(await inspectReleaseSetArtifactBytes(artifact, join(artifactDirectory, artifact.filename), normalized.sourceCommit))
  if (normalized.rust.mode === 'publish') {
    const rustPath = join(artifactDirectory, normalized.rust.archive.filename)
    requireEqual(await sha256File(rustPath), normalized.rust.sha256, 'Prepared Rust archive bytes do not match')
    prepared.push({ filename: normalized.rust.archive.filename, sha256: normalized.rust.sha256, members: await releaseSetInspectRustArchive(rustPath, normalized.rust.version, normalized.rust.sourceCommit) })
  }
  return { plan: normalized, prepared }
}

const releaseSetZipFileMembers = async zipFile => {
  await archiveEntries(zipFile, 'zip')
  const names = (await commandText('unzip', ['-Z1', zipFile])).split(/\r?\n/).filter(Boolean)
  const files = []
  const seen = new Set()
  for (const raw of names) {
    const name = raw.endsWith('/') ? raw.slice(0, -1) : raw
    safeRelativePath(name)
    if (seen.has(name)) fail(`Release-set ZIP contains duplicate member ${name}`)
    seen.add(name)
    if (!raw.endsWith('/')) files.push(name)
  }
  return files
}

/** Bind an Actions artifact API record to the exact downloaded ZIP and consumed files. */
export async function verifyReleaseSetArtifactZip({ zipFile, metadata, expectedId, consumedDirectory, expectedName }) {
  const id = requirePositiveId(expectedId, 'Release-set ZIP artifact ID')
  requireEqual(metadata?.id, Number(id), 'Release-set ZIP metadata ID mismatch')
  if (expectedName !== undefined) requireEqual(metadata?.name, expectedName, 'Release-set ZIP metadata name mismatch')
  requireEqual(metadata?.expired, false, 'Release-set ZIP artifact is expired')
  const bytes = await readFile(zipFile)
  requireEqual(metadata?.size_in_bytes, bytes.length, 'Release-set ZIP size mismatch')
  requireEqual(metadata?.digest, `sha256:${sha256Hex(bytes)}`, 'Release-set ZIP API digest mismatch')
  requireEqual(metadata?.archive_download_url, `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/artifacts/${id}/zip`, 'Release-set ZIP URL mismatch')
  const zipMembers = await releaseSetZipFileMembers(zipFile)
  const consumedEntries = await readdir(consumedDirectory, { withFileTypes: true })
  if (consumedEntries.some(entry => !entry.isFile())) fail('Release-set consumed artifact directory contains a non-file member')
  const consumedNames = consumedEntries.map(entry => entry.name).sort()
  if (canonicalJson(zipMembers.slice().sort()) !== canonicalJson(consumedNames)) fail('Release-set ZIP members do not equal consumed files')
  for (const name of zipMembers) {
    const extracted = await execFile('unzip', ['-p', zipFile, name], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
    const consumed = await readFile(join(consumedDirectory, name))
    if (!Buffer.from(extracted.stdout).equals(consumed)) fail(`Release-set ZIP member bytes differ for ${name}`)
  }
  return { id: Number(id), name: metadata.name, sizeInBytes: bytes.length, digest: sha256Hex(bytes), members: zipMembers }
}

/** Full authenticated verification: context, API metadata, raw ZIPs, and consumed bytes are mandatory. */
export async function verifyReleaseSetPreparation({ plan, context, run, artifact, bindingArtifact, binding, bundleZip, bindingZip, artifactDirectory, bindingDirectory, expected }) {
  const normalized = validateReleaseSetPlan(plan)
  validateReleaseSetContext(context, normalized)
  const metadata = validateReleaseSetPreparationMetadata({ plan: normalized, run, artifact, bindingArtifact, expected })
  validateReleaseSetPreparationBinding(binding, { plan: normalized, expected })
  const bundleZipEvidence = await verifyReleaseSetArtifactZip({ zipFile: bundleZip, metadata: artifact, expectedId: expected.artifactId, consumedDirectory: artifactDirectory, expectedName: expected.bundleName })
  const bindingZipEvidence = await verifyReleaseSetArtifactZip({ zipFile: bindingZip, metadata: bindingArtifact, expectedId: expected.bindingArtifactId, consumedDirectory: bindingDirectory, expectedName: expected.bindingName })
  const bindingEntries = await readdir(bindingDirectory, { withFileTypes: true })
  if (bindingEntries.length !== 1 || !bindingEntries[0].isFile() || bindingEntries[0].name !== 'release-set-binding.json') fail('Release-set binding directory must contain exactly release-set-binding.json')
  requireEqual(canonicalJson(JSON.parse(await readFile(join(bindingDirectory, 'release-set-binding.json'), 'utf8'))), canonicalJson(binding), 'Release-set binding ZIP/consumed binding mismatch')
  const prepared = await ingestReleaseSetBundle({ plan: normalized, artifactDirectory })
  return { context: { sourceCommit: normalized.sourceCommit }, metadata, bundleZip: bundleZipEvidence, bindingZip: bindingZipEvidence, prepared }
}

const npmRegistryOrigin = 'https://registry.npmjs.org'
const npmRegistryExactUrl = version => `https://registry.npmjs.org/%40elsoul%2Ferpc-sdk/${version}`
const npmTarballUrl = version => `https://registry.npmjs.org/@elsoul/erpc-sdk/-/erpc-sdk-${version}.tgz`

const npmCanonicalRegistry = value => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) return null
    return npmRegistryOrigin
  } catch {
    return null
  }
}

const npmResponseBody = response => Buffer.isBuffer(response?.body) ? response.body : Buffer.from(response?.body ?? '')

const npmRequireRunSuccess = (result, stage) => {
  if (!result || result.exitCode !== 0) fail(`npm-observe-${stage}-failed`)
  return result
}

const npmDefaultRequest = async (url, options = {}) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
  try {
    const response = await fetch(url, { headers: options.headers ?? {}, redirect: 'manual', signal: controller.signal })
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) }
  } catch {
    fail('npm-observe-http-failed')
  } finally {
    clearTimeout(timer)
  }
}

const npmSpawnProcess = (command, arguments_, options = {}) => new Promise(resolve_ => {
  let child
  try {
    child = spawn(command, arguments_, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    resolve_({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(error?.message ?? error)), signal: null, timedOut: false })
    return
  }
  const stdout = []
  const stderr = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let timedOut = false
  let settled = false
  let timeoutTimer
  let killTimer
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024
  const terminate = () => {
    if (settled) return
    try { child.kill(options.killSignal ?? 'SIGTERM') } catch {}
    killTimer = setTimeout(() => {
      if (!settled) {
        try { child.kill('SIGKILL') } catch {}
      }
    }, 100)
  }
  const finish = (exitCode, signal) => {
    if (settled) return
    settled = true
    clearTimeout(timeoutTimer)
    clearTimeout(killTimer)
    resolve_({ exitCode: Number.isInteger(exitCode) ? exitCode : 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), signal, timedOut })
  }
  child.stdout.on('data', chunk => {
    const buffer = Buffer.from(chunk)
    stdoutBytes += buffer.length
    if (stdoutBytes <= maxBuffer) stdout.push(buffer)
    else terminate()
  })
  child.stderr.on('data', chunk => {
    const buffer = Buffer.from(chunk)
    stderrBytes += buffer.length
    if (stderrBytes <= maxBuffer) stderr.push(buffer)
    else terminate()
  })
  child.once('error', error => {
    if (!settled) resolve_({ exitCode: 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat([...stderr, Buffer.from(String(error?.message ?? error))]), signal: null, timedOut })
    settled = true
    clearTimeout(timeoutTimer)
    clearTimeout(killTimer)
  })
  child.once('close', finish)
  if (options.timeout !== undefined) {
    timeoutTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, Math.max(1, options.timeout))
  }
})

const npmBoundedExecFile = async (command, arguments_, options = {}) => {
  const result = await npmSpawnProcess(command, arguments_, options)
  const encoding = options.encoding === 'buffer' ? 'buffer' : options.encoding ?? 'utf8'
  const stdout = encoding === 'buffer' ? result.stdout : result.stdout.toString(encoding)
  const stderr = encoding === 'buffer' ? result.stderr : result.stderr.toString(encoding)
  if (result.exitCode !== 0) {
    const error = new Error(`Command failed: ${command}`)
    error.code = result.exitCode
    error.stdout = stdout
    error.stderr = stderr
    throw error
  }
  return { stdout, stderr }
}

const npmDefaultRun = async (command, arguments_, options = {}) => {
  try {
    const result = await npmBoundedExecFile(command, arguments_, { ...options, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return { exitCode: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch (error) {
    return { exitCode: Number.isInteger(error?.code) ? error.code : 1, stdout: error?.stdout ?? '', stderr: error?.stderr ?? '' }
  }
}

const npmSafePath = (path, label) => {
  if (typeof path !== 'string' || path.length === 0) fail(`${label} is required`)
  const resolved = resolve(path)
  const root = `${REPOSITORY_ROOT}${sep}`
  if (!resolved.startsWith('/') || resolved === REPOSITORY_ROOT || resolved.startsWith(root)) fail(`${label} must be outside the repository`)
  return resolved
}

const npmInvalidateOutput = async (path, workPath, label) => {
  const workDir = npmSafePath(workPath, 'npm observer work directory')
  const workStat = await lstat(workDir)
  if (!workStat.isDirectory()) fail('npm observer work directory must be a directory')
  const repositoryRoot = await realpath(REPOSITORY_ROOT)
  const canonicalWorkDir = await realpath(workDir)
  const insideRepository = value => value === repositoryRoot || value.startsWith(`${repositoryRoot}${sep}`)
  if (insideRepository(canonicalWorkDir)) fail('npm observer work directory must be outside the repository')
  const workParent = await realpath(resolve(canonicalWorkDir, '..'))
  const outputFile = npmSafePath(path, label)
  const outputParent = await realpath(resolve(outputFile, '..'))
  if (insideRepository(outputParent)) fail(`${label} must be outside the repository`)
  if (outputParent !== workParent) fail(`${label} must share the external work root`)
  try {
    const existingOutput = await lstat(outputFile)
    if (!existingOutput.isFile() && !existingOutput.isSymbolicLink()) fail(`${label} must be a file path`)
    let priorReceipt
    try { priorReceipt = JSON.parse(await readFile(outputFile, 'utf8')) } catch { fail(`${label} is not a prior npm observation receipt`) }
    if (priorReceipt?.schemaVersion !== 1 || priorReceipt?.kind !== 'npm-public-observation' || priorReceipt?.state !== 'observed') fail(`${label} is not a prior npm observation receipt`)
    await rm(outputFile)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return outputFile
}

const npmDeadlineRemaining = (now, deadline) => {
  const remaining = deadline - now()
  if (!(remaining > 0)) fail('npm-observe-deadline-exceeded')
  return Math.max(1, Math.ceil(remaining))
}

const npmCheckDeadline = (now, deadline) => {
  if (now() >= deadline) fail('npm-observe-deadline-exceeded')
}

const npmChildEnvironment = ({ workDir, emptyUserConfig, emptyGlobalConfig }) => ({
  PATH: process.env.PATH ?? '',
  TMPDIR: workDir,
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  NPM_CONFIG_USERCONFIG: emptyUserConfig,
  NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig,
  NPM_CONFIG_CACHE: join(workDir, 'npm-cache'),
  NPM_CONFIG_PREFIX: join(workDir, 'npm-prefix'),
  NPM_CONFIG_REGISTRY: npmRegistryOrigin,
  npm_config_registry: npmRegistryOrigin,
  NODE_OPTIONS: '',
  NODE_PATH: '',
})

const npmClaimsPython = String.raw`
import base64, json, sys
from cryptography import x509
from cryptography.hazmat.primitives import serialization

raw = base64.b64decode(json.load(open(sys.argv[1]))['rawBytes'])
cert = x509.load_der_x509_certificate(raw)
claims = {}
for extension in cert.extensions:
    oid = extension.oid.dotted_string
    if not oid.startswith('1.3.6.1.4.1.57264.'):
        continue
    value = getattr(extension.value, 'value', b'')
    if value[:1] == b'\x0c':
        length = value[1]
        offset = 2
        if length & 0x80:
            count = length & 0x7f
            length = int.from_bytes(value[offset:offset + count], 'big')
            offset += count
        value = value[offset:offset + length]
    try:
        claims[oid] = value.decode('utf-8')
    except UnicodeDecodeError:
        continue
print(json.dumps(claims, sort_keys=True))
`

const npmRequireClaim = (claims, keys, expected, label) => {
  const present = keys.filter(key => claims[key] !== undefined)
  if (present.length === 0 || present.some(key => claims[key] !== expected)) fail(`npm-observe-${label}-claim-failed`)
  return claims[present[0]]
}

const npmInvoke = async (run, command, arguments_, options, stage, deadlineControl) => {
  const boundedOptions = deadlineControl === undefined
    ? options
    : {
        ...options,
        timeout: Math.min(options.timeout ?? Number.POSITIVE_INFINITY, npmDeadlineRemaining(deadlineControl.now, deadlineControl.deadline)),
        killSignal: 'SIGTERM',
      }
  const result = npmRequireRunSuccess(await run(command, arguments_, boundedOptions), stage)
  if (deadlineControl !== undefined) npmCheckDeadline(deadlineControl.now, deadlineControl.deadline)
  return result
}

const npmStrictInput = input => {
  releaseSetKeys(input, ['descriptor', 'planSha256', 'preparation', 'publisher', 'observer', 'workDir', 'outputFile', 'toolPaths'], 'npm observer input')
  releaseSetKeys(input.descriptor, ['kind', 'filename', 'name', 'version', 'sha256', 'files'], 'npm observer descriptor')
  requireEqual(input.descriptor.kind, 'npm', 'npm observer descriptor kind mismatch')
  requireEqual(input.descriptor.name, '@elsoul/erpc-sdk', 'npm observer package identity mismatch')
  releaseSetVersion(input.descriptor.version, 'npm observer version')
  requireEqual(input.descriptor.filename, releaseSetArtifactFilename('npm', input.descriptor.version), 'npm observer archive filename mismatch')
  requireArchiveSha(input.descriptor.sha256, 'npm observer descriptor SHA-256')
  requireArchiveSha(input.planSha256, 'npm observer plan SHA-256')
  releaseSetKeys(input.preparation, ['sourceCommit', 'runId', 'runAttempt', 'artifactId', 'bindingArtifactId', 'planSha256'], 'npm observer preparation')
  requireSha(input.preparation.sourceCommit, 'npm observer preparation source')
  requireArchiveSha(input.preparation.planSha256, 'npm observer preparation plan SHA-256')
  requireEqual(input.preparation.planSha256, input.planSha256, 'npm observer preparation plan mismatch')
  for (const [value, label] of [[input.preparation.runId, 'npm observer preparation run ID'], [input.preparation.runAttempt, 'npm observer preparation attempt'], [input.preparation.artifactId, 'npm observer preparation artifact ID'], [input.preparation.bindingArtifactId, 'npm observer preparation binding artifact ID']]) requirePositiveId(value, label)
  releaseSetKeys(input.publisher, ['repository', 'repositoryId', 'sourceCommit', 'workflowPath', 'ref', 'event', 'environment', 'publisherRunId', 'publisherAttempt'], 'npm observer publisher')
  requireEqual(input.publisher.repository, EXPECTED_REPOSITORY, 'npm observer publisher repository mismatch')
  requireEqual(String(input.publisher.repositoryId), EXPECTED_REPOSITORY_ID, 'npm observer publisher repository ID mismatch')
  requireEqual(input.publisher.sourceCommit, input.preparation.sourceCommit, 'npm observer publisher source mismatch')
  requireEqual(input.publisher.workflowPath, RELEASE_SET_WORKFLOW, 'npm observer publisher workflow mismatch')
  requireEqual(input.publisher.ref, 'refs/heads/main', 'npm observer publisher ref mismatch')
  requireEqual(input.publisher.event, 'workflow_dispatch', 'npm observer publisher event mismatch')
  requireEqual(input.publisher.environment, 'npm', 'npm observer publisher environment mismatch')
  requirePositiveId(input.publisher.publisherRunId, 'npm observer publisher run ID')
  requirePositiveId(input.publisher.publisherAttempt, 'npm observer publisher attempt')
  releaseSetKeys(input.observer, ['runId', 'runAttempt', 'workflowPath', 'sourceCommit'], 'npm observer context')
  requirePositiveId(input.observer.runId, 'npm observer run ID')
  requirePositiveId(input.observer.runAttempt, 'npm observer attempt')
  requireEqual(input.observer.workflowPath, RELEASE_SET_WORKFLOW, 'npm observer workflow mismatch')
  requireSha(input.observer.sourceCommit, 'npm observer source')
  releaseSetKeys(input.toolPaths, ['node', 'npmCli', 'python'], 'npm observer tool paths')
  for (const [name, value] of Object.entries(input.toolPaths)) npmSafePath(value, `npm observer ${name} path`)
  return input
}

/**
 * Execute the real read-only npm observation operation. Adapters are limited
 * to raw HTTP, subprocess, monotonic clock, and sleep; they cannot return a
 * trusted receipt or bypass any verification stage.
 */
export async function observeNpmRelease(input, adapters = {}) {
  const outputFile = await npmInvalidateOutput(input?.outputFile, input?.workDir, 'npm observer output file')
  npmStrictInput(input)
  const request = adapters.request ?? npmDefaultRequest
  const run = adapters.run ?? npmDefaultRun
  const now = adapters.now ?? (() => performance.now())
  const sleep = adapters.sleep ?? (milliseconds => new Promise(resolve_ => setTimeout(resolve_, milliseconds)))
  const workDir = npmSafePath(input.workDir, 'npm observer work directory')
  const workEntries = await readdir(workDir, { withFileTypes: true })
  if (workEntries.length !== 0) fail('npm-observe-work-directory-not-fresh')
  const started = now()
  const deadline = started + 600_000
  const deadlineControl = { now, deadline }
  const headers = { 'user-agent': RELEASE_USER_AGENT, accept: 'application/json' }
  const get = async (url, timeoutMs) => {
    const remaining = npmDeadlineRemaining(now, deadline)
    try {
      const response = await request(url, { headers, timeoutMs: Math.min(timeoutMs, remaining), deadline })
      npmCheckDeadline(now, deadline)
      return response
    } catch (error) {
      if (error?.message === 'npm-observe-deadline-exceeded') throw error
      fail('npm-observe-http-failed')
    }
  }
  const version = input.descriptor.version
  const exactUrl = npmRegistryExactUrl(version)
  const fullUrl = `${npmRegistryOrigin}/%40elsoul%2Ferpc-sdk`
  let exactResponse
  let fullResponse
  let exactPayload
  let exact404 = false
  while (true) {
    exactResponse = await get(exactUrl, 20_000)
    const exactBody = npmResponseBody(exactResponse)
    if (exactResponse.status === 200) {
      try { exactPayload = JSON.parse(exactBody.toString('utf8')) } catch { fail('npm-observe-exact-json-invalid') }
      exact404 = false
      break
    }
    if (exactResponse.status !== 404) fail(`npm-observe-exact-http-${exactResponse.status}`)
    exact404 = true
    const candidateFullResponse = await get(fullUrl, 20_000)
    if (candidateFullResponse.status === 200) {
      let candidateFullPayload
      try { candidateFullPayload = JSON.parse(npmResponseBody(candidateFullResponse).toString('utf8')) } catch { fail('npm-observe-full-json-invalid') }
      if (candidateFullPayload.name === '@elsoul/erpc-sdk' && candidateFullPayload.versions?.[version]) {
        fullResponse = candidateFullResponse
        break
      }
    } else if (candidateFullResponse.status !== 404) {
      fail(`npm-observe-full-http-${candidateFullResponse.status}`)
    }
    npmCheckDeadline(now, deadline)
    const remaining = npmDeadlineRemaining(now, deadline)
    await sleep(Math.min(30_000, remaining))
    npmCheckDeadline(now, deadline)
  }
  // A full-packument response from a prior exact-version 404 is never reused
  // after the exact endpoint becomes visible. Fetch the current packument.
  if (!fullResponse || exactResponse.status === 200) fullResponse = await get(fullUrl, 20_000)
  const fullBody = npmResponseBody(fullResponse)
  if (fullResponse.status !== 200) fail(`npm-observe-full-http-${fullResponse.status}`)
  let fullPayload
  try { fullPayload = JSON.parse(fullBody.toString('utf8')) } catch { fail('npm-observe-full-json-invalid') }
  if (fullPayload.name !== '@elsoul/erpc-sdk' || !fullPayload.versions?.[version]) fail('npm-observe-full-selected-version-missing')
  const selected = fullPayload.versions[version]
  const comparable = metadata => ({ name: metadata?.name, version: metadata?.version, tarball: metadata?.dist?.tarball, integrity: metadata?.dist?.integrity })
  if (!exact404 && canonicalJson(comparable(exactPayload)) !== canonicalJson(comparable(selected))) fail('npm-observe-exact-full-conflict')
  const metadata = selected
  if (metadata.name !== '@elsoul/erpc-sdk' || metadata.version !== version) fail('npm-observe-metadata-identity-failed')
  const canonicalUrl = npmTarballUrl(version)
  if (metadata.dist?.tarball !== canonicalUrl || typeof metadata.dist?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist.integrity)) fail('npm-observe-metadata-integrity-failed')
  const archiveResponse = await get(canonicalUrl, 60_000)
  if (archiveResponse.status !== 200) fail(`npm-observe-archive-http-${archiveResponse.status}`)
  const archiveBytes = npmResponseBody(archiveResponse)
  npmCheckDeadline(now, deadline)
  const archivePath = join(workDir, input.descriptor.filename)
  await writeFile(archivePath, archiveBytes)
  const observedSha256 = sha256Hex(archiveBytes)
  const observedSha512 = createHash('sha512').update(archiveBytes).digest('hex')
  const observedSRI = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`
  requireEqual(observedSha256, input.descriptor.sha256, 'npm-observe archive SHA-256 mismatch')
  requireEqual(observedSRI, metadata.dist.integrity, 'npm-observe archive SRI mismatch')
  const emptyUserConfig = join(workDir, 'empty-npmrc')
  const emptyGlobalConfig = join(workDir, 'empty-global-npmrc')
  await writeFile(emptyUserConfig, '')
  await writeFile(emptyGlobalConfig, '')
  const isolatedEnv = npmChildEnvironment({ workDir, emptyUserConfig, emptyGlobalConfig })
  const archiveExecutor = async (command, arguments_, options = {}) => {
    const remaining = npmDeadlineRemaining(now, deadline)
    const result = await npmBoundedExecFile(command, arguments_, {
      ...options,
      cwd: options.cwd ?? workDir,
      env: isolatedEnv,
      timeout: Math.min(options.timeout ?? Number.POSITIVE_INFINITY, remaining),
      killSignal: 'SIGTERM',
    })
    npmCheckDeadline(now, deadline)
    return result
  }
  await inspectReleaseSetArtifactBytes(input.descriptor, archivePath, input.publisher.sourceCommit, {
    execFile: archiveExecutor,
    commandMap: { python3: input.toolPaths.python },
  })

  const auditDirectory = await mkdtemp(join(workDir, 'audit-consumer-'))
  const smokeDirectory = await mkdtemp(join(workDir, 'smoke-consumer-'))
  const nodeVersion = await npmInvoke(run, input.toolPaths.node, ['--version'], { cwd: workDir, env: isolatedEnv }, 'node-version', deadlineControl)
  const npmVersion = await npmInvoke(run, input.toolPaths.node, [input.toolPaths.npmCli, '--version'], { cwd: workDir, env: isolatedEnv }, 'npm-version', deadlineControl)
  if (!/^v24\./.test(String(nodeVersion.stdout).trim()) || String(npmVersion.stdout).trim() !== '11.19.1') fail('npm-observe-tool-version-mismatch')
  const pythonVersion = await npmInvoke(run, input.toolPaths.python, ['-c', 'import sys, cryptography; print(sys.version.split()[0]); print(cryptography.__version__)'], { cwd: workDir, env: isolatedEnv }, 'python-version', deadlineControl)
  if (!/^3\.12\./m.test(pythonVersion.stdout) || !/^46\.0\.3$/m.test(pythonVersion.stdout)) fail('npm-observe-python-tool-version-mismatch')
  const install = await npmInvoke(run, input.toolPaths.node, [input.toolPaths.npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', auditDirectory, `@elsoul/erpc-sdk@${version}`, `--registry=${npmRegistryOrigin}`], { cwd: auditDirectory, env: isolatedEnv }, 'audit-install', deadlineControl)
  const lockFile = join(auditDirectory, 'package-lock.json')
  const lock = JSON.parse(await readFile(lockFile, 'utf8'))
  const lockMatches = Object.entries(lock.packages ?? {}).filter(([key]) => key === 'node_modules/@elsoul/erpc-sdk' || key.endsWith('/node_modules/@elsoul/erpc-sdk'))
  if (lockMatches.length !== 1) fail('npm-observe-audit-lock-target-ambiguous')
  const lockPackage = lockMatches[0][1]
  if (lockPackage.version !== version || lockPackage.resolved !== canonicalUrl || lockPackage.integrity !== metadata.dist.integrity) fail('npm-observe-audit-lock-binding-failed')
  const audit = await npmInvoke(run, input.toolPaths.node, [input.toolPaths.npmCli, 'audit', 'signatures', '--json', '--include-attestations', '--prefix', auditDirectory], { cwd: auditDirectory, env: isolatedEnv }, 'audit-signatures', deadlineControl)
  let auditPayload
  try { auditPayload = JSON.parse(audit.stdout) } catch { fail('npm-observe-audit-json-invalid') }
  if (!Array.isArray(auditPayload.invalid) || auditPayload.invalid.length !== 0 || !Array.isArray(auditPayload.missing) || auditPayload.missing.length !== 0 || !Array.isArray(auditPayload.verified)) fail('npm-observe-audit-result-invalid')
  const targets = auditPayload.verified.filter(item => item.name === '@elsoul/erpc-sdk' && item.version === version && npmCanonicalRegistry(item.registry) === npmRegistryOrigin)
  if (targets.length !== 1) fail('npm-observe-audit-target-ambiguous')
  const slsaBundles = (targets[0].attestationBundles ?? []).filter(bundle => bundle.predicateType === 'https://slsa.dev/provenance/v1' && bundle.bundle?.verificationMaterial?.certificate?.rawBytes && bundle.bundle?.dsseEnvelope?.payload)
  if (slsaBundles.length !== 1) fail('npm-observe-slsa-bundle-ambiguous')
  const slsa = slsaBundles[0].bundle
  const certificateFile = join(workDir, 'npm-certificate.json')
  await writeFile(certificateFile, JSON.stringify({ rawBytes: slsa.verificationMaterial.certificate.rawBytes }))
  const claimsResult = await npmInvoke(run, input.toolPaths.python, ['-c', npmClaimsPython, certificateFile], { cwd: workDir, env: isolatedEnv }, 'certificate-claims', deadlineControl)
  let claims
  try { claims = JSON.parse(claimsResult.stdout) } catch { fail('npm-observe-certificate-claims-invalid') }
  const expectedInvocation = `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/${input.publisher.publisherRunId}/attempts/${input.publisher.publisherAttempt}`
  npmRequireClaim(claims, ['1.3.6.1.4.1.57264.1.8', '1.3.6.1.4.1.57264.1.1'], 'https://token.actions.githubusercontent.com', 'issuer')
  for (const [key, expected, label] of [
    ['1.3.6.1.4.1.57264.1.9', `https://github.com/${EXPECTED_REPOSITORY}/${RELEASE_SET_WORKFLOW}@refs/heads/main`, 'workflow-legacy'],
    ['1.3.6.1.4.1.57264.1.18', `https://github.com/${EXPECTED_REPOSITORY}/${RELEASE_SET_WORKFLOW}@refs/heads/main`, 'workflow'],
    ['1.3.6.1.4.1.57264.1.10', input.publisher.sourceCommit, 'source-legacy'],
    ['1.3.6.1.4.1.57264.1.13', input.publisher.sourceCommit, 'source'],
    ['1.3.6.1.4.1.57264.1.19', input.publisher.sourceCommit, 'source-workflow'],
    ['1.3.6.1.4.1.57264.1.12', `https://github.com/${EXPECTED_REPOSITORY}`, 'repository'],
    ['1.3.6.1.4.1.57264.1.14', 'refs/heads/main', 'ref'],
    ['1.3.6.1.4.1.57264.1.15', EXPECTED_REPOSITORY_ID, 'repository-id'],
    ['1.3.6.1.4.1.57264.1.20', 'workflow_dispatch', 'event'],
    ['1.3.6.1.4.1.57264.1.21', expectedInvocation, 'invocation'],
  ]) npmRequireClaim(claims, [key], expected, label)
  if (claims['1.3.6.1.4.1.57264.1.23'] !== undefined) requireEqual(claims['1.3.6.1.4.1.57264.1.23'], 'npm', 'npm-observe environment claim mismatch')
  if (claims['1.3.6.1.4.1.57264.1.24'] !== undefined) requireEqual(claims['1.3.6.1.4.1.57264.1.24'], `repo:elsoul@42315168/erpc-sdk@${EXPECTED_REPOSITORY_ID}:environment:npm`, 'npm-observe environment identity claim mismatch')
  let provenance
  try { provenance = JSON.parse(Buffer.from(slsa.dsseEnvelope.payload, 'base64').toString('utf8')) } catch { fail('npm-observe-slsa-payload-invalid') }
  const subject = provenance.subject?.filter(item => item.name === `pkg:npm/%40elsoul/erpc-sdk@${version}`)
  if (subject?.length !== 1 || subject[0].digest?.sha512 !== observedSha512) fail('npm-observe-slsa-subject-mismatch')
  const predicate = provenance.predicate
  const workflow = predicate?.buildDefinition?.externalParameters?.workflow
  const github = predicate?.buildDefinition?.internalParameters?.github
  const dependencies = predicate?.buildDefinition?.resolvedDependencies ?? []
  if (provenance.predicateType !== 'https://slsa.dev/provenance/v1' || workflow?.repository !== `https://github.com/${EXPECTED_REPOSITORY}` || workflow?.path !== RELEASE_SET_WORKFLOW || workflow?.ref !== 'refs/heads/main' || String(github?.repository_id) !== EXPECTED_REPOSITORY_ID || github?.event_name !== 'workflow_dispatch' || !dependencies.some(item => item.digest?.gitCommit === input.publisher.sourceCommit)) fail('npm-observe-slsa-build-binding-failed')
  if (predicate.runDetails?.metadata?.invocationId !== expectedInvocation) fail('npm-observe-slsa-invocation-mismatch')
  const smokeInstall = await npmInvoke(run, input.toolPaths.node, [input.toolPaths.npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', smokeDirectory, archivePath, `--registry=${npmRegistryOrigin}`], { cwd: smokeDirectory, env: isolatedEnv }, 'smoke-install', deadlineControl)
  const smokePackage = resolve(smokeDirectory, 'node_modules/@elsoul/erpc-sdk')
  const smokeMetadata = JSON.parse(await readFile(join(smokePackage, 'package.json'), 'utf8'))
  if (smokeMetadata.name !== '@elsoul/erpc-sdk' || smokeMetadata.version !== version || !smokePackage.startsWith(`${resolve(smokeDirectory)}${sep}`)) fail('npm-observe-smoke-identity-failed')
  const smokeRequire = await npmInvoke(run, input.toolPaths.node, ['-e', 'const fs=require("node:fs"); const path=require("node:path"); const root=fs.realpathSync(process.env.ERPC_EXPECTED_ROOT); const p=fs.realpathSync(require.resolve("@elsoul/erpc-sdk")); if (!p.startsWith(root + path.sep)) process.exit(2); require("@elsoul/erpc-sdk")'], { cwd: smokeDirectory, env: { ...isolatedEnv, ERPC_EXPECTED_ROOT: join(smokeDirectory, 'node_modules', '@elsoul', 'erpc-sdk') } }, 'smoke-require', deadlineControl)
  const smokeImport = await npmInvoke(run, input.toolPaths.node, ['--input-type=module', '-e', 'import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; const root=fs.realpathSync(process.env.ERPC_EXPECTED_ROOT); const p=await import.meta.resolve("@elsoul/erpc-sdk"); if (!p.startsWith("file://") || !fs.realpathSync(fileURLToPath(p)).startsWith(root + path.sep)) process.exit(2); await import("@elsoul/erpc-sdk")'], { cwd: smokeDirectory, env: { ...isolatedEnv, ERPC_EXPECTED_ROOT: join(smokeDirectory, 'node_modules', '@elsoul', 'erpc-sdk') } }, 'smoke-import', deadlineControl)
  npmCheckDeadline(now, deadline)
  const receipt = {
    schemaVersion: 1, kind: 'npm-public-observation', state: 'observed', repository: EXPECTED_REPOSITORY, repositoryId: EXPECTED_REPOSITORY_ID,
    planSha256: input.planSha256, preparation: input.preparation, descriptor: { kind: 'npm', name: '@elsoul/erpc-sdk', version, filename: input.descriptor.filename, expectedSha256: input.descriptor.sha256, observedSha256, observedSRI },
    registry: { exactUrl, fullUrl, exactStatus: exactResponse.status, fullStatus: fullResponse.status, exactBodySha256: sha256Hex(npmResponseBody(exactResponse)), fullBodySha256: sha256Hex(fullBody), tarballUrl: canonicalUrl },
    publisher: { ...input.publisher, invocation: expectedInvocation }, observer: input.observer, provenance: { certificateClaims: claims, subject: subject[0], workflow, invocation: predicate.runDetails.metadata.invocationId },
    toolVersions: { node: String(nodeVersion.stdout).trim(), npm: String(npmVersion.stdout).trim(), python: String(pythonVersion.stdout).trim() },
    consumer: { audit: { exitCode: audit.exitCode, invalid: auditPayload.invalid.length, missing: auditPayload.missing.length, verifiedTargetCount: targets.length }, smoke: { exitCodes: { install: smokeInstall.exitCode, require: smokeRequire.exitCode, import: smokeImport.exitCode }, packageRoot: 'external-consumer/node_modules/@elsoul/erpc-sdk' } },
    auth: { requested: false, uploadAttempted: false }, observedAt: new Date().toISOString(),
  }
  const temporaryOutput = `${outputFile}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporaryOutput, `${canonicalJson(receipt)}\n`, { flag: 'wx' })
  await rename(temporaryOutput, outputFile)
  try {
    npmCheckDeadline(now, deadline)
  } catch (error) {
    await rm(outputFile, { force: true })
    throw error
  }
  return receipt
}

/** Authenticate Actions run/artifact metadata before any later bundle use. */
export function validateReleaseSetPreparationMetadata({ plan, run, artifact, bindingArtifact, expected }) {
  const normalized = validateReleaseSetPlan(plan)
  const runId = requirePositiveId(expected.runId, 'Release-set preparation run ID')
  const runAttempt = requirePositiveId(expected.runAttempt, 'Release-set preparation attempt')
  const artifactId = requirePositiveId(expected.artifactId, 'Release-set preparation artifact ID')
  const bindingArtifactId = requirePositiveId(expected.bindingArtifactId, 'Release-set binding artifact ID')
  requireSha(expected.sourceCommit, 'Release-set preparation source')
  requireEqual(expected.sourceCommit, normalized.sourceCommit, 'Release-set preparation source does not match the plan')
  requireEqual(run?.id, Number(runId), 'Release-set preparation run ID mismatch')
  requireEqual(run?.run_attempt, Number(runAttempt), 'Release-set preparation attempt mismatch')
  requireEqual(run?.status, 'completed', 'Release-set preparation run is not complete')
  requireEqual(run?.conclusion, 'success', 'Release-set preparation run did not succeed')
  requireEqual(run?.event, 'workflow_dispatch', 'Release-set preparation event mismatch')
  requireEqual(run?.head_branch, 'main', 'Release-set preparation branch mismatch')
  requireEqual(run?.head_sha, normalized.sourceCommit, 'Release-set preparation source mismatch')
  requireEqual(run?.path, RELEASE_SET_WORKFLOW, 'Release-set preparation workflow mismatch')
  requireEqual(run?.repository?.full_name, EXPECTED_REPOSITORY, 'Release-set preparation repository mismatch')
  requireEqual(String(run?.repository?.id), EXPECTED_REPOSITORY_ID, 'Release-set preparation repository ID mismatch')
  const checkArtifact = (record, id, label) => {
    requireEqual(record?.id, Number(id), `${label} ID mismatch`)
    requireEqual(record?.expired, false, `${label} is expired`)
    if (!Number.isSafeInteger(record?.size_in_bytes) || record.size_in_bytes <= 0) fail(`${label} size is invalid`)
    releaseSetString(record?.name, `${label} name`)
    requireEqual(record?.workflow_run?.id, Number(runId), `${label} run binding mismatch`)
    requireEqual(String(record?.workflow_run?.repository_id), EXPECTED_REPOSITORY_ID, `${label} repository binding mismatch`)
    if (record?.workflow_run?.head_repository_id !== undefined) requireEqual(String(record.workflow_run.head_repository_id), EXPECTED_REPOSITORY_ID, `${label} source repository binding mismatch`)
    requireEqual(record?.workflow_run?.head_sha, normalized.sourceCommit, `${label} source binding mismatch`)
    requireEqual(record?.workflow_run?.head_branch, 'main', `${label} branch binding mismatch`)
    if (record?.workflow_run?.run_attempt !== undefined) requireEqual(record.workflow_run.run_attempt, Number(runAttempt), `${label} attempt binding mismatch`)
    if (record?.workflow_run?.path !== undefined) requireEqual(record.workflow_run.path, RELEASE_SET_WORKFLOW, `${label} workflow binding mismatch`)
    if (record?.archive_download_url !== undefined) {
      const expectedUrl = `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/artifacts/${id}/zip`
      requireEqual(record.archive_download_url, expectedUrl, `${label} archive URL is not canonical`)
    }
    if (typeof record?.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.digest)) fail(`${label} metadata digest is missing or malformed`)
  }
  if (expected.bundleName !== undefined) requireEqual(artifact.name, expected.bundleName, 'Release-set bundle artifact name mismatch')
  if (expected.bindingName !== undefined) requireEqual(bindingArtifact.name, expected.bindingName, 'Release-set binding artifact name mismatch')
  checkArtifact(artifact, artifactId, 'Release-set bundle artifact')
  checkArtifact(bindingArtifact, bindingArtifactId, 'Release-set binding artifact')
  return { runId: Number(runId), runAttempt: Number(runAttempt), artifactId: Number(artifactId), bindingArtifactId: Number(bindingArtifactId), sourceCommit: normalized.sourceCommit }
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
  if (arguments_[0] === '--release-set-context') {
    requireExactInternalMode(arguments_, '--release-set-context')
    const plan = JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8'))
    validateReleaseSetContext({
      repository: env('REPOSITORY'),
      repositoryId: env('REPOSITORY_ID'),
      eventName: env('EVENT_NAME'),
      eventRef: env('EVENT_REF'),
      eventSha: env('EVENT_SHA'),
      expectedCommit: env('EXPECTED_COMMIT'),
      checkoutHead: env('CHECKOUT_HEAD'),
      checkoutStatus: env('CHECKOUT_STATUS'),
      workflowRef: env('WORKFLOW_REF'),
      workflowSha: env('WORKFLOW_SHA'),
    }, plan)
    console.log('release-set-context-passed')
    return
  }

  if (arguments_[0] === '--release-set-validate') {
    requireExactInternalMode(arguments_, '--release-set-validate')
    const plan = JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8'))
    console.log(`release-set-plan=${releaseSetPlanDigest(plan)}`)
    return
  }

  if (arguments_[0] === '--release-set-ingest') {
    requireExactInternalMode(arguments_, '--release-set-ingest')
    const plan = JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8'))
    const normalized = validateReleaseSetPlan(plan)
    requireEqual(releaseSetPlanDigest(normalized), env('RELEASE_SET_PLAN_SHA256'), 'Release-set plan digest mismatch')
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    validateReleaseSetPreparationBinding(binding, {
      plan: normalized,
      expected: {
        runId: process.env.RELEASE_SET_PREPARED_RUN_ID,
        runAttempt: process.env.RELEASE_SET_PREPARED_RUN_ATTEMPT,
        artifactId: process.env.RELEASE_SET_PREPARED_ARTIFACT_ID,
        bindingArtifactId: process.env.RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID,
      },
    })
    const result = await ingestReleaseSetBundle({ plan: normalized, artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR') })
    if (process.env.RELEASE_SET_PREPARED_EVIDENCE_FILE) await writeFile(process.env.RELEASE_SET_PREPARED_EVIDENCE_FILE, `${canonicalJson(result)}\n`)
    console.log('release-set-prepared-bytes-verified')
    return
  }

  if (arguments_[0] === '--release-set-verify') {
    requireExactInternalMode(arguments_, '--release-set-verify')
    const plan = JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8'))
    const normalized = validateReleaseSetPlan(plan)
    const planDigest = releaseSetPlanDigest(normalized)
    requireEqual(planDigest, env('RELEASE_SET_PLAN_SHA256'), 'Release-set plan digest mismatch')
    const expected = {
      runId: env('RELEASE_SET_PREPARED_RUN_ID'),
      runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'),
      artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'),
      bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'),
      sourceCommit: normalized.sourceCommit,
      bundleName: `release-set-bundle-${normalized.sourceCommit}`,
      bindingName: `release-set-binding-${env('RELEASE_SET_PREPARED_RUN_ID')}-${env('RELEASE_SET_PREPARED_RUN_ATTEMPT')}`,
    }
    const result = await verifyReleaseSetPreparation({
      plan: normalized,
      context: {
        repository: env('REPOSITORY'), repositoryId: env('REPOSITORY_ID'), eventName: env('EVENT_NAME'), eventRef: env('EVENT_REF'),
        eventSha: env('EVENT_SHA'), expectedCommit: env('EXPECTED_COMMIT'), checkoutHead: env('CHECKOUT_HEAD'), checkoutStatus: env('CHECKOUT_STATUS'),
        workflowRef: env('WORKFLOW_REF'), workflowSha: env('WORKFLOW_SHA'),
      },
      run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')),
      artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')),
      bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')),
      binding: JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8')),
      bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'),
      bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'),
      artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'),
      bindingDirectory: env('RELEASE_SET_BINDING_DIR'),
      expected,
    })
    if (process.env.RELEASE_SET_PREPARED_EVIDENCE_FILE) await writeFile(process.env.RELEASE_SET_PREPARED_EVIDENCE_FILE, `${canonicalJson(result)}\n`)
    console.log('release-set-authenticated-preparation-verified')
    return
  }

  if (arguments_[0] === '--release-set-observe') {
    requireExactInternalMode(arguments_, '--release-set-observe')
    fail('Future public observation remains unavailable until checkpoint B')
  }

  if (arguments_[0] === '--release-set-npm-observe') {
    const outputFile = await npmInvalidateOutput(process.env.RELEASE_SET_NPM_OUTPUT_FILE, process.env.RELEASE_SET_NPM_WORK_DIR, 'npm observer output file')
    requireExactInternalMode(arguments_, '--release-set-npm-observe')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const planSha256 = env('RELEASE_SET_PLAN_SHA256')
    requireEqual(releaseSetPlanDigest(plan), planSha256, 'npm observer plan digest mismatch')
    const context = {
      repository: env('REPOSITORY'), repositoryId: env('REPOSITORY_ID'), eventName: env('EVENT_NAME'), eventRef: env('EVENT_REF'),
      eventSha: env('EVENT_SHA'), expectedCommit: env('EXPECTED_COMMIT'), checkoutHead: env('CHECKOUT_HEAD'), checkoutStatus: env('CHECKOUT_STATUS'),
      workflowRef: env('WORKFLOW_REF'), workflowSha: env('WORKFLOW_SHA'),
    }
    validateReleaseSetContext(context, plan)
    const preparedExpected = {
      runId: env('RELEASE_SET_PREPARED_RUN_ID'),
      runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'),
      artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'),
      bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'),
      sourceCommit: plan.sourceCommit,
      bundleName: `release-set-bundle-${plan.sourceCommit}`,
      bindingName: `release-set-binding-${env('RELEASE_SET_PREPARED_RUN_ID')}-${env('RELEASE_SET_PREPARED_RUN_ATTEMPT')}`,
    }
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    const preparation = await verifyReleaseSetPreparation({
      plan,
      context,
      run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')),
      artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')),
      bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')),
      binding,
      bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'),
      bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'),
      artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'),
      bindingDirectory: env('RELEASE_SET_BINDING_DIR'),
      expected: preparedExpected,
    })
    const observerSource = env('RELEASE_SET_NPM_OBSERVER_SOURCE')
    requireEqual(observerSource, context.eventSha, 'npm observer source must bind to execution context')
    const publisher = JSON.parse(await readFile(env('RELEASE_SET_NPM_PUBLISHER_FILE'), 'utf8'))
    const receipt = await observeNpmRelease({
      descriptor: plan.artifacts.find(artifact => artifact.kind === 'npm'),
      planSha256,
      preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: binding.bindingArtifactId, planSha256: binding.planSha256 },
      publisher,
      observer: { runId: env('RELEASE_SET_NPM_OBSERVER_RUN_ID'), runAttempt: env('RELEASE_SET_NPM_OBSERVER_ATTEMPT'), workflowPath: env('RELEASE_SET_NPM_OBSERVER_WORKFLOW'), sourceCommit: observerSource },
      workDir: env('RELEASE_SET_NPM_WORK_DIR'), outputFile,
      toolPaths: { node: env('RELEASE_SET_NPM_NODE'), npmCli: env('RELEASE_SET_NPM_CLI'), python: env('RELEASE_SET_NPM_PYTHON') },
    })
    console.log(`npm-public-observation=${sha256Hex(canonicalJson(receipt))}`)
    return
  }

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
