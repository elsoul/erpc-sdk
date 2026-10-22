import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { rubyLockVersion } from '../registry/ruby-lockfile.mjs'

export const REPOSITORY_ROOT = resolve(new URL('../', import.meta.url).pathname)
export const RELEASE_SCOPES = Object.freeze(['all', 'rust', 'non-rust'])
export const RUST_VERSION = '0.10.0'
export const RUST_TOOLCHAIN = '1.85.0'
export const CRATE_NAME = 'erpc-sdk'
export const EXPECTED_REPOSITORY = 'elsoul/erpc-sdk'
export const EXPECTED_REPOSITORY_ID = '1429568627'

const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const ARCHIVE_SHA256 = /^[0-9a-f]{64}$/

const fail = message => {
  throw new Error(message)
}

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
  if (parsedVcs?.git?.dirty !== false) {
    fail('Crate .cargo_vcs_info.json must prove a clean source tree')
  }
  if (parsedVcs?.path_in_vcs !== 'packages/rust') {
    fail('Crate .cargo_vcs_info.json has an unexpected path_in_vcs')
  }
  return { root: expectedRoot, commit, pathInVcs: parsedVcs.path_in_vcs }
}

const env = name => {
  const value = process.env[name]
  if (value === undefined) fail(`Missing ${name}`)
  return value
}

const run = async arguments_ => {
  if (arguments_[0] === '--workflow-guard') {
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
