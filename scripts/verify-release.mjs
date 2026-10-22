import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { lstat, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
export const FOUNDATION_ARTIFACT_KINDS = Object.freeze([
  'npm',
  'pypi-wheel',
  'pypi-sdist',
  'rubygems',
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
  if (kind === 'npm' && !filename.endsWith('.tgz')) fail('npm foundation artifact must be a tgz')
  if (kind === 'pypi-wheel' && !filename.endsWith('.whl')) fail('PyPI wheel foundation artifact must be a wheel')
  if (kind === 'pypi-sdist' && !filename.endsWith('.tar.gz')) fail('PyPI sdist foundation artifact must be a tarball')
  if (kind === 'rubygems' && !filename.endsWith('.gem')) fail('RubyGems foundation artifact must be a gem')
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
  if (typeof receipt.downloadUrl !== 'string' || !receipt.downloadUrl.startsWith('https://crates.io/')) {
    fail('Rust receipt download URL must be a public crates.io URL')
  }
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
  const byKind = foundationArtifactMap(plan.artifacts)
  const go = validateGoInventory(plan.goInventory)
  requireEqual(plan.goInventory.inventorySha256, go.inventorySha256, 'Foundation Go inventory mismatch')
  const rust = validateFoundationRustReceipt(plan.rustReceipt)
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

const archiveFiles = async filePath => {
  const command = filePath.endsWith('.whl') ? 'unzip' : 'tar'
  const arguments_ = filePath.endsWith('.whl')
    ? ['-Z1', filePath]
    : ['-tzf', filePath]
  return (await commandText(command, arguments_)).split(/\r?\n/).filter(Boolean).map(safeRelativePath)
}

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
    const filesInArchive = await archiveFiles(filePath)
    let name
    let version
    if (kind === 'npm') {
      const packageJsonPath = filesInArchive.find(file => file === 'package/package.json')
      if (!packageJsonPath) fail('npm artifact is missing package/package.json')
      const packageJson = JSON.parse(await archiveText(filePath, packageJsonPath))
      name = packageJson.name
      version = packageJson.version
      if (!filesInArchive.includes('package/LICENSE') || !filesInArchive.some(file => file.startsWith('package/dist/'))) fail('npm artifact is missing LICENSE or dist files')
    } else if (kind === 'pypi-wheel') {
      const metadataPath = filesInArchive.find(file => /\.dist-info\/METADATA$/.test(file))
      if (!metadataPath) fail('PyPI wheel is missing dist-info/METADATA')
      const metadata = await archiveText(filePath, metadataPath, true)
      name = metadataValue(metadata, 'Name')
      version = metadataValue(metadata, 'Version')
      if (!filesInArchive.some(file => /\.dist-info\/(?:licenses\/)?LICENSE$/.test(file))) fail('PyPI wheel is missing its LICENSE metadata')
    } else if (kind === 'pypi-sdist') {
      const metadataPath = filesInArchive.find(file => /(?:^|\/)PKG-INFO$/.test(file))
      if (!metadataPath) fail('PyPI sdist is missing PKG-INFO')
      const metadata = await archiveText(filePath, metadataPath)
      name = metadataValue(metadata, 'Name')
      version = metadataValue(metadata, 'Version')
      if (!filesInArchive.some(file => /(?:^|\/)LICENSE$/.test(file))) fail('PyPI sdist is missing LICENSE')
    } else {
      name = 'erpc-sdk'
      version = filename.match(/^erpc-sdk-(\d+\.\d+\.\d+)\.gem$/)?.[1]
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
    'erpc-sdk-0.10.0.crate',
  ])
  const bundleEntries = await readdir(artifactDirectory, { withFileTypes: true })
  for (const entry of bundleEntries) {
    if (!entry.isFile() || !allowedFiles.has(entry.name)) fail(`Unexpected foundation bundle member ${entry.name}`)
  }
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
    const metadata = payload?.versions?.[expectedVersion]
    if (!metadata || metadata.name !== '@elsoul/erpc-sdk' || metadata.version !== expectedVersion) return { state: 'malformed', status: numericStatus }
    const integrity = metadata.dist?.integrity
    const tarball = metadata.dist?.tarball
    if (typeof integrity !== 'string' || !integrity.startsWith('sha512-') || typeof tarball !== 'string' || !tarball.startsWith('https://registry.npmjs.org/')) return { state: 'malformed', status: numericStatus }
    return { state: 'match', status: numericStatus, integrity, tarball }
  }
  if (registry === 'pypi') {
    if (payload?.info?.name !== 'erpc-sdk' || payload.info.version !== expectedVersion || !Array.isArray(payload.urls)) return { state: 'malformed', status: numericStatus }
    const files = payload.urls.filter(file => expectedArtifacts.includes(file.filename))
    if (files.some(file => file.yanked === true || file.packagetype === undefined || file.digests?.sha256 === undefined)) return { state: 'malformed', status: numericStatus }
    const unexpected = payload.urls.filter(file => !expectedArtifacts.includes(file.filename))
    if (unexpected.length > 0) return { state: 'conflict', status: numericStatus, unexpected: unexpected.map(file => file.filename) }
    if (files.length === 0) return { state: 'partial', status: numericStatus, files: [] }
    return { state: files.length === expectedArtifacts.length ? 'match' : 'partial', status: numericStatus, files: files.map(file => ({ filename: file.filename, sha256: file.digests.sha256, url: file.url, packagetype: file.packagetype, yanked: file.yanked === true })) }
  }
  if (registry === 'rubygems') {
    if (payload?.name !== 'erpc-sdk' || payload.version !== expectedVersion || typeof payload.sha !== 'string' || !ARCHIVE_SHA256.test(payload.sha)) return { state: 'malformed', status: numericStatus }
    if (expectedSha256 !== undefined && payload.sha !== expectedSha256) return { state: 'conflict', status: numericStatus, sha256: payload.sha }
    return { state: 'match', status: numericStatus, sha256: payload.sha, platform: payload.platform ?? 'ruby' }
  }
  if (registry === 'rust') return classifyRegistryResponse({ status: numericStatus, body, expectedVersion: '0.10.0', expectedChecksum: FOUNDATION_RUST_SHA256 })
  return { state: 'malformed', status: numericStatus }
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
    expectedVersion,
    mode,
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
  requireFoundationVersion(expectedVersion)
  if (mode !== 'prepare' && mode !== 'publish') fail('Foundation mode must be prepare or publish')
  return { expectedCommit, expectedVersion, mode }
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
      expectedVersion: env('EXPECTED_VERSION'),
      mode: env('FOUNDATION_MODE'),
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
    if (!['absent', 'match', 'partial'].includes(result.state)) fail(`Foundation registry check stopped in ${result.state} state`)
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
