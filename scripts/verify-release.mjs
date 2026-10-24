import { createHash } from 'node:crypto'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { closeSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { rubyLockVersion } from '../registry/ruby-lockfile.mjs'

export const REPOSITORY_ROOT = resolve(new URL('../', import.meta.url).pathname)
export const RELEASE_SCOPES = Object.freeze(['all', 'rust', 'non-rust'])
export const RUST_VERSION = '0.10.0'
export const CURRENT_RUST_VERSION = '0.11.0'
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

// The Rust 0.11 crate has an intentionally narrow distribution profile.  The
// historical 0.10 receipt above remains MIT-only and is validated by its own
// immutable helpers; these constants apply only to the current 0.11 source
// and archive checks.
export const RUST_011_LICENSE_PROFILE = 'MIT AND Apache-2.0'
export const RUST_011_REUSE_SOURCE = '4877b32a32ffb6b82a6620040fe77fc2e73f4386'
export const RUST_011_REUSE_SHA256 = 'fe3e0e224a60921531d09442ecbe68ab9a34ae3ebed7821ab02a309b8b66f7f6'
export const RUST_011_REUSE_SIZE = 254463
export const RELEASE_SET_NON_RUST_LICENSE_PROFILE = 'MIT AND Apache-2.0 AND BSD-3-Clause'
export const RELEASE_SET_NON_RUST_PROFILE = 'future-non-rust'
export const RELEASE_SET_NON_RUST_LICENSE_FILES = Object.freeze([
  'LICENSE',
  'LICENSES/Apache-2.0.txt',
  'LICENSES/BSD-3-Clause-Google-Protobuf.txt',
  'THIRD_PARTY_NOTICES.md',
])
const RELEASE_SET_PROFILE_SOURCE_FILES = Object.freeze({
  npm: Object.freeze({
    license: 'packages/typescript/LICENSE',
    apache: 'packages/typescript/LICENSES/Apache-2.0.txt',
    bsd: 'packages/typescript/LICENSES/BSD-3-Clause-Google-Protobuf.txt',
    notice: 'packages/typescript/THIRD_PARTY_NOTICES.md',
  }),
  pypi: Object.freeze({
    license: 'packages/python/LICENSE',
    apache: 'packages/python/LICENSES/Apache-2.0.txt',
    bsd: 'packages/python/LICENSES/BSD-3-Clause-Google-Protobuf.txt',
    notice: 'packages/python/THIRD_PARTY_NOTICES.md',
  }),
  rubygems: Object.freeze({
    license: 'packages/ruby/LICENSE',
    apache: 'packages/ruby/LICENSES/Apache-2.0.txt',
    bsd: 'packages/ruby/LICENSES/BSD-3-Clause-Google-Protobuf.txt',
    notice: 'packages/ruby/THIRD_PARTY_NOTICES.md',
  }),
  go: Object.freeze({
    license: 'packages/go/LICENSE',
    apache: 'packages/go/LICENSES/Apache-2.0.txt',
    bsd: 'packages/go/LICENSES/BSD-3-Clause-Google-Protobuf.txt',
    notice: 'packages/go/THIRD_PARTY_NOTICES.md',
    goMod: 'packages/go/go.mod',
  }),
})
export const RUST_011_LICENSE_HASHES = Object.freeze({
  'LICENSE': 'c58b88798da8b5b47cec99517d7f7ae22864ea48dba348754f4eae7edd00da6c',
  'LICENSES/Apache-2.0.txt': 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  'THIRD_PARTY_NOTICES.md': 'ea9d61aa598c0a9d08946ec6be9bcc26aa9119047d2e506bab1bc9dc0205e9e9',
  'src/sui_proto.rs': '33ee488df64c00654a504a2124a98c32615be65ec37b9272e368d9a20aad020c',
})
export const RUST_011_CLIENT_MODULES = Object.freeze([
  'solana',
  'ethereum',
  'avalanche',
  'bitcoin',
  'base',
  'arbitrum',
  'polygon',
  'bsc',
  'optimism',
  'kaia',
  'soneium',
  'monad',
  'hyperliquid',
  'arc',
  'robinhood',
  'near',
  'tron',
  'sui',
])
export const RUST_011_SUI_MEMBERS = Object.freeze([
  'src/sui_grpc_web.rs',
  'src/sui_proto.rs',
])
export const RUST_011_REQUIRED_SOURCE_FILES = Object.freeze([
  'src/account.rs',
  'src/arbitrum.rs',
  'src/arc.rs',
  'src/avalanche.rs',
  'src/base.rs',
  'src/bitcoin.rs',
  'src/bridge.rs',
  'src/bridge_local.rs',
  'src/bsc.rs',
  'src/cloud.rs',
  'src/config.rs',
  'src/dex_catalog.rs',
  'src/error.rs',
  'src/ethereum.rs',
  'src/generated/bridge_capabilities.rs',
  'src/generated/dex_catalog.rs',
  'src/generated/mod.rs',
  'src/generated/swap_execution_capabilities.rs',
  'src/generated/token_catalog.rs',
  'src/generated/token_rankings.rs',
  'src/hyperliquid.rs',
  'src/kaia.rs',
  'src/lib.rs',
  'src/monad.rs',
  'src/near.rs',
  'src/optimism.rs',
  'src/polygon.rs',
  'src/price.rs',
  'src/rest.rs',
  'src/robinhood.rs',
  'src/rpc.rs',
  'src/solana.rs',
  'src/soneium.rs',
  'src/subscriptions.rs',
  'src/sui.rs',
  'src/sui_grpc_web.rs',
  'src/sui_proto.rs',
  'src/swap.rs',
  'src/token_catalog.rs',
  'src/token_rankings.rs',
  'src/tron.rs',
  'src/usage.rs',
])
export const RUST_011_REQUIRED_EXAMPLES = Object.freeze(['examples/basic.rs'])
export const RUST_011_REQUIRED_TESTS = Object.freeze([
  'tests/arbitrum.rs',
  'tests/arc.rs',
  'tests/base.rs',
  'tests/bitcoin.rs',
  'tests/bridge.rs',
  'tests/bridge_local.rs',
  'tests/bsc.rs',
  'tests/client.rs',
  'tests/dex_catalog.rs',
  'tests/evm_batch1.rs',
  'tests/evm_batch2.rs',
  'tests/evm_batch3.rs',
  'tests/hyperliquid.rs',
  'tests/kaia.rs',
  'tests/monad.rs',
  'tests/near.rs',
  'tests/non_evm_batch4.rs',
  'tests/optimism.rs',
  'tests/polygon.rs',
  'tests/rest.rs',
  'tests/robinhood.rs',
  'tests/soneium.rs',
  'tests/sui.rs',
  'tests/support/mod.rs',
  'tests/swap.rs',
  'tests/swap_execution.rs',
  'tests/token_catalog.rs',
  'tests/token_rankings.rs',
  'tests/tron.rs',
  'tests/websocket.rs',
])
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
export const RELEASE_SET_RECEIPT_FILENAMES = Object.freeze([
  'npm-proof.json', 'pypi-proof.json', 'rubygems-proof.json',
  'rust-proof.json', 'tag-proof.json', 'go-proof.json',
])
export const RELEASE_SET_RECEIPT_ARTIFACT_ROLES = Object.freeze({
  'npm-proof.json': 'npm-proof', 'pypi-proof.json': 'pypi-proof',
  'rubygems-proof.json': 'rubygems-proof', 'rust-proof.json': 'rust-proof',
  'tag-proof.json': 'tag-proof', 'go-proof.json': 'go-proof',
})

// One-cohort publication recovery is deliberately a separate, finite
// contract.  The package/preparation identity (M) stays immutable while the
// controller that performs the recovery (C) is authenticated independently.
// These values are frozen from the reviewed preparation/publication evidence;
// they must not be inferred from a dispatch input or a rebuilt archive.
export const PUBLICATION_RECOVERY_MODE = 'recover-0.11.0'
export const PUBLICATION_RECOVERY_VERSION = '0.11.0'
export const PUBLICATION_RECOVERY_SOURCE_M = '00343b27668122cffd6d5b2b7517eda96f109d5f'
export const PUBLICATION_RECOVERY_PLAN_SHA256 = 'b8775c0335289ffaf21eb272e3464cbfcbafb737994d805ca46f8c9652b52cd8'
export const PUBLICATION_RECOVERY_PREPARED_RUN_ID = '40116157011'
export const PUBLICATION_RECOVERY_PREPARED_RUN_ATTEMPT = '1'
export const PUBLICATION_RECOVERY_BUNDLE_ARTIFACT_ID = '12567863653'
export const PUBLICATION_RECOVERY_BINDING_ARTIFACT_ID = '12568401850'
export const PUBLICATION_RECOVERY_ORIGINAL_RUBYGEMS_RECEIPT_ARTIFACT_ID = '12569655440'
export const PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ID = '40116597887'
export const PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ATTEMPT = '1'
export const PUBLICATION_RECOVERY_ORIGINAL_NPM_JOB_ID = '120939149010'
export const PUBLICATION_RECOVERY_ORIGINAL_PYPI_JOB_ID = '120939149000'
export const PUBLICATION_RECOVERY_ORIGINAL_RUBYGEMS_JOB_ID = '120939148972'
export const PUBLICATION_RECOVERY_NPM_SHA256 = '50c6ad17e24050eb6e5a5752b6cfc9d4e5c85d1c3e01e7db03bd2aa45754325a'
export const PUBLICATION_RECOVERY_RUBYGEMS_SHA256 = '957aab0bb58254b1cdd8d53d7540216f8d3eea2d30ce058b089c0f3d0eed02ef'
export const PUBLICATION_RECOVERY_PYPI_WHEEL_SHA256 = 'aa60375f9e37dabb1aa798c4da59c1f5ce558125f952bf52b43f2ab460f7c02e'
export const PUBLICATION_RECOVERY_PYPI_SDIST_SHA256 = 'ca9f1b2eedd6e6163ae5b7470e7588bd96e49e06de067c42256203ce6edfa2d2'
export const PUBLICATION_RECOVERY_BUNDLE_ZIP_SHA256 = '01ba51df046f11323197d013ae79f28b7eaa3949287c356036e0243eca38e0bb'
export const PUBLICATION_RECOVERY_BINDING_ZIP_SHA256 = '4ea1f1b78ac8f7df2711953ac7c2415155affc8c1cd9b864554b4bb11a2566b9'
export const PUBLICATION_RECOVERY_ALLOWED_DELTA = Object.freeze([
  '.github/workflows/release.yml',
  'docs/RELEASING.md',
  'scripts/verify-release.mjs',
  'scripts/verify-release.test.mjs',
])
export const PUBLICATION_RECOVERY_BUNDLE_FILES = Object.freeze([
  'elsoul-erpc-sdk-0.11.0.tgz',
  'erpc_sdk-0.11.0-py3-none-any.whl',
  'erpc_sdk-0.11.0.tar.gz',
  'erpc-sdk-0.11.0.gem',
  'release-set-plan.json',
  'release-set-plan.sha256',
  'release-body.md',
  'go-inventory.json',
  'checksums.txt',
])
export const PUBLICATION_RECOVERY_ARCHIVE_SHA256 = Object.freeze({
  'elsoul-erpc-sdk-0.11.0.tgz': PUBLICATION_RECOVERY_NPM_SHA256,
  'erpc_sdk-0.11.0-py3-none-any.whl': PUBLICATION_RECOVERY_PYPI_WHEEL_SHA256,
  'erpc_sdk-0.11.0.tar.gz': PUBLICATION_RECOVERY_PYPI_SDIST_SHA256,
  'erpc-sdk-0.11.0.gem': PUBLICATION_RECOVERY_RUBYGEMS_SHA256,
})
export const PUBLICATION_RECOVERY_TOOLCHAIN = Object.freeze({
  python: '3.12.15',
  build: '1.6.0',
  pypiAttestations: '0.0.30',
  sigstore: '4.5.1',
  cryptography: '50.0.2',
})

// Short aliases keep the recovery tests and operator packet readable while
// retaining the explicit publication namespace above.
export const RECOVERY_SOURCE_M = PUBLICATION_RECOVERY_SOURCE_M
export const RECOVERY_PLAN_SHA256 = PUBLICATION_RECOVERY_PLAN_SHA256
export const RECOVERY_PREPARED_RUN_ID = PUBLICATION_RECOVERY_PREPARED_RUN_ID
export const RECOVERY_PREPARED_ARTIFACT_ID = PUBLICATION_RECOVERY_BUNDLE_ARTIFACT_ID
export const RECOVERY_PREPARED_BINDING_ARTIFACT_ID = PUBLICATION_RECOVERY_BINDING_ARTIFACT_ID
export const RECOVERY_ORIGINAL_PUBLICATION_RUN_ID = PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ID
export const RECOVERY_BUNDLE_ZIP_SHA256 = PUBLICATION_RECOVERY_BUNDLE_ZIP_SHA256
export const RECOVERY_BINDING_ZIP_SHA256 = PUBLICATION_RECOVERY_BINDING_ZIP_SHA256

const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const ARCHIVE_SHA256 = /^[0-9a-f]{64}$/
const execFile = promisify(execFileCallback)

const cargoTomlParserScript = String.raw`
import json, sys
try:
    import tomllib
except ImportError:
    raise SystemExit('Python 3.11+ with tomllib is required')
try:
    parsed = tomllib.loads(sys.argv[1])
except Exception as error:
    raise SystemExit(f'Cargo TOML is invalid: {error}')
print(json.dumps(parsed, separators=(',', ':')))
`

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

/** Return the one semantically parsed source-free workspace package entry. */
export async function findLocalCargoPackage(lockSource, packageName = CRATE_NAME, execution = {}) {
  const parsed = typeof lockSource === 'string'
    ? await parseCargoToml(lockSource, 'Cargo.lock', execution)
    : lockSource
  const entries = Array.isArray(parsed?.package)
    ? parsed.package.filter(entry => entry?.name === packageName)
    : []
  const localEntries = entries.filter(entry => !Object.prototype.hasOwnProperty.call(entry, 'source'))
  if (localEntries.length !== 1) {
    fail(
      `Cargo.lock must contain exactly one source-free ${packageName} entry; ` +
        `found ${localEntries.length}`,
    )
  }
  return localEntries[0]
}

const rust011SourcePaths = Object.freeze([
  'LICENSE',
  'LICENSES/Apache-2.0.txt',
  'THIRD_PARTY_NOTICES.md',
  'src/lib.rs',
  ...RUST_011_CLIENT_MODULES.map(module => `src/${module}.rs`),
  ...RUST_011_SUI_MEMBERS.filter(member => !RUST_011_CLIENT_MODULES.some(module => member === `src/${module}.rs`)),
  ...RUST_011_REQUIRED_EXAMPLES,
  ...RUST_011_REQUIRED_TESTS,
])

const parseCargoToml = async (source, label, execution = {}) => {
  let raw
  try {
    raw = await commandText('python3', ['-c', cargoTomlParserScript, source], execution)
  } catch (error) {
    const diagnostic = String(error?.stderr ?? error?.message ?? '')
    if (/Python 3\.11\+|tomllib/.test(diagnostic)) fail(`${label} requires Python 3.11+ with tomllib`)
    fail(`${label} TOML is invalid`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    fail(`${label} TOML parser output is malformed`)
  }
}

const collectRegularSourceFiles = async (root, current = root) => {
  const entries = await readdir(current, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await collectRegularSourceFiles(root, absolute))
    else if (entry.isFile()) files.push(absolute.slice(root.length + 1))
  }
  return files
}

const readRustSourceEvidence = async root => {
  const sourceRoot = resolve(root, 'packages/rust')
  const sourceFiles = {}
  const inventory = await collectRegularSourceFiles(sourceRoot)
  for (const relativePath of inventory) sourceFiles[relativePath] = sha256Hex(await readFile(join(sourceRoot, relativePath)))
  let libSource = ''
  if (sourceFiles['src/lib.rs'] !== undefined) libSource = await readFile(join(sourceRoot, 'src/lib.rs'), 'utf8')
  const currentShape = RUST_011_REQUIRED_SOURCE_FILES.every(relativePath => sourceFiles[relativePath] !== undefined) &&
    RUST_011_CLIENT_MODULES.every(module => new RegExp(`^mod ${module};$`, 'm').test(libSource))
  return { sourceRoot, sourceFiles, libSource, currentShape, inventory }
}

const readRust011SourceEvidence = async root => {
  return readRustSourceEvidence(root)
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
    data.cargoToml = await parseCargoToml(cargoManifest, 'packages/rust/Cargo.toml')
    data.cargoManifest = cargoManifest
    data.cargoLock = cargoLock
    data.cargoName = data.cargoToml.package?.name
    data.cargoVersion = data.cargoToml.package?.version
    data.cargoLockToml = await parseCargoToml(cargoLock, 'Cargo.lock')
    data.cargoLockPackage = await findLocalCargoPackage(data.cargoLockToml)
    data.rustSource = await readRust011SourceEvidence(root)
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

const validateRust011Source = source => {
  if (source === null || typeof source !== 'object' || typeof source.sourceRoot !== 'string') {
    fail('Rust 0.11 source evidence is missing')
  }
  for (const relativePath of RUST_011_REQUIRED_SOURCE_FILES) {
    if (source.sourceFiles?.[relativePath] === undefined) fail(`Rust 0.11 source is missing ${relativePath}`)
  }
  for (const [relativePath, expectedHash] of Object.entries(RUST_011_LICENSE_HASHES)) {
    requireEqual(source.sourceFiles?.[relativePath], expectedHash, `Rust 0.11 source hash mismatch for ${relativePath}`)
  }
  for (const module of RUST_011_CLIENT_MODULES) {
    const relativePath = `src/${module}.rs`
    if (source.sourceFiles?.[relativePath] === undefined) fail(`Rust 0.11 source is missing ${relativePath}`)
    if (!new RegExp(`^\\s*mod\\s+${module}\\s*;\\s*(?:\\/\\/.*)?$`, 'm').test(source.libSource ?? '')) fail(`Rust 0.11 lib.rs is missing ${module}`)
  }
  for (const relativePath of RUST_011_SUI_MEMBERS) {
    if (source.sourceFiles?.[relativePath] === undefined) fail(`Rust 0.11 source is missing ${relativePath}`)
  }
  for (const relativePath of [...RUST_011_REQUIRED_EXAMPLES, ...RUST_011_REQUIRED_TESTS]) {
    if (source.sourceFiles?.[relativePath] === undefined) fail(`Rust 0.11 source is missing ${relativePath}`)
  }
  return source
}

const validateRust = (data, expectedVersion) => {
  const manifest = data.cargoToml
  if (manifest === null || typeof manifest !== 'object' || manifest.package === undefined) fail('Rust Cargo.toml semantic package table is missing')
  assertRust011ManifestProfile(manifest, 'Rust source Cargo.toml')
  const packageTable = manifest.package
  requireEqual(packageTable.name, CRATE_NAME, 'Unexpected Rust crate package name')
  requireEqual(packageTable.version, data.cargoVersion, 'Parsed Rust package version mirror mismatch')
  requireEqual(data.cargoName, packageTable.name, 'Parsed Rust package name mirror mismatch')
  if (!STABLE_VERSION.test(packageTable.version ?? '')) fail('Unexpected Rust crate version')
  requireEqual(packageTable.version, CURRENT_RUST_VERSION, 'Current Rust source must be 0.11.0')
  requireEqual(data.cargoLockPackage?.name, CRATE_NAME, 'Cargo.lock local erpc-sdk package name mismatch')
  requireEqual(data.cargoLockPackage?.version, packageTable.version, 'Cargo.lock local erpc-sdk version must match Cargo.toml')
  if (expectedVersion !== undefined) requireEqual(packageTable.version, expectedVersion, `Rust crate version ${packageTable.version} must match expected version ${expectedVersion}`)
  requireEqual(packageTable.repository, 'https://github.com/elsoul/erpc-sdk', 'Unexpected Rust crate repository')
  requireEqual(packageTable['rust-version'], '1.85', 'Unexpected Rust MSRV')
  requireEqual(packageTable.edition, '2024', 'Unexpected Rust edition')
  requireEqual(JSON.stringify(packageTable.publish), JSON.stringify(['crates-io']), 'The Rust crate must be restricted to crates.io')
  requireEqual(packageTable.license, RUST_011_LICENSE_PROFILE, 'Unexpected Rust crate license')
  sameMemberSet(packageTable.include ?? [], rust011ManifestIncludes, 'Rust 0.11 package include')
  const prost = manifest.dependencies?.prost
  const prostTypes = manifest.dependencies?.['prost-types']
  requireEqual(prost?.version, '=0.14.4', 'Rust 0.11 Prost version is not exact')
  requireEqual(prost?.['default-features'], false, 'Rust 0.11 Prost default-features is not exact')
  requireEqual(JSON.stringify(prost?.features), JSON.stringify(['derive', 'std']), 'Rust 0.11 Prost features are not exact')
  requireEqual(prostTypes?.version, '=0.14.4', 'Rust 0.11 prost-types version is not exact')
  requireEqual(prostTypes?.['default-features'], false, 'Rust 0.11 prost-types default-features is not exact')
  requireEqual(JSON.stringify(prostTypes?.features), JSON.stringify(['std']), 'Rust 0.11 prost-types features are not exact')
  validateRust011Source(data.rustSource)
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
  requireEqual(data.packageJson.license, RELEASE_SET_NON_RUST_LICENSE_PROFILE, 'Unexpected npm package license')
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
  if (!/^license = "MIT AND Apache-2\.0 AND BSD-3-Clause"$/m.test(data.pythonManifest) && !/^license = \{ file = "LICENSE" \}$/m.test(data.pythonManifest)) {
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
  if (!/^\s*spec\.licenses = \["MIT", "Apache-2\.0", "BSD-3-Clause"\]$/m.test(data.rubyManifest) && !/^\s*spec\.license = "MIT"$/m.test(data.rubyManifest)) {
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

const validateGoInventory = (inventory, mixedProfile = false) => {
  if (!inventory || !Array.isArray(inventory.files) || inventory.files.length === 0) {
    fail('Go inventory is empty')
  }
  const files = inventory.files.map(file => ({
    path: safeRelativePath(file.path),
    sha256: requireArchiveSha(file.sha256, `Go inventory SHA-256 for ${file.path}`),
  }))
  if (new Set(files.map(file => file.path)).size !== files.length) fail('Go inventory contains duplicate paths')
  const requiredPaths = mixedProfile ? ['go.mod', 'LICENSE', 'LICENSES/Apache-2.0.txt', 'LICENSES/BSD-3-Clause-Google-Protobuf.txt', 'THIRD_PARTY_NOTICES.md'] : ['go.mod', 'LICENSE']
  for (const required of requiredPaths) {
    if (!files.some(file => file.path === required)) fail(`Go inventory must include ${required}`)
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

const archiveMemberRecords = async (filePath, kind, execution = {}) => {
  const raw = await commandText('python3', ['-c', archiveInspectionScript, filePath, kind], execution)
  let records
  try { records = JSON.parse(raw) } catch { fail(`Archive inspection is malformed for ${filePath}`) }
  if (!Array.isArray(records) || records.length === 0) fail(`Archive ${filePath} is empty`)
  const seen = new Set()
  const normalized = []
  for (const record of records) {
    if (record?.type !== 'file' && record?.type !== 'directory') fail(`Archive ${filePath} contains a non-regular member`)
    if (typeof record?.name !== 'string' || record.name.length === 0) fail(`Archive ${filePath} contains an invalid member name`)
    const name = record.type === 'directory' ? record.name.replace(/\/$/, '') : record.name
    safeRelativePath(name)
    if (seen.has(name)) fail(`Archive ${filePath} contains duplicate member ${name}`)
    seen.add(name)
    normalized.push({ name, type: record.type })
  }
  return normalized
}

const archiveEntries = async (filePath, kind, execution = {}) =>
  (await archiveMemberRecords(filePath, kind, execution)).map(record => record.name)

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

export async function buildGoInventory(goRoot, options = {}) {
  const profile = options === true || options?.profile === 'future' || options?.mixedProfile === true ? 'future' : 'historical'
  const files = (await collectFiles(resolve(goRoot))).sort((a, b) => a.path.localeCompare(b.path))
  const required = profile === 'future'
    ? ['LICENSE', ...RELEASE_SET_NON_RUST_LICENSE_FILES.filter(file => file !== 'LICENSE'), 'go.mod']
    : ['LICENSE', 'go.mod']
  for (const path of required) if (!files.some(file => file.path === path)) fail(`Go inventory is missing ${path}`)
  if (profile === 'future') {
    const sourceRoot = resolve(join(REPOSITORY_ROOT, 'packages/go'))
    const sourceFiles = RELEASE_SET_PROFILE_SOURCE_FILES.go
    for (const [key, relative] of Object.entries(sourceFiles)) {
      const sourceSha = await sha256File(join(sourceRoot, relative.slice('packages/go/'.length)))
      const inventoryPath = key === 'license' ? 'LICENSE' : key === 'apache' ? 'LICENSES/Apache-2.0.txt' : key === 'bsd' ? 'LICENSES/BSD-3-Clause-Google-Protobuf.txt' : key === 'notice' ? 'THIRD_PARTY_NOTICES.md' : 'go.mod'
      requireEqual(files.find(file => file.path === inventoryPath)?.sha256, sourceSha, `Go inventory ${inventoryPath} is not bound to the current source`)
    }
  }
  return validateGoInventory({ files, inventorySha256: sha256Hex(canonicalJson(files)) }, profile === 'future')
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
  archiveFile,
  packageList,
  archiveList,
  suppliedManifest,
  suppliedVcsInfo,
  expectedArchiveSha256,
  archivePath,
  filePath,
}) {
  const rawArchiveFile = archiveFile ?? archivePath ?? filePath
  if (rawArchiveFile !== undefined) {
    return inspectRust011Archive({
      filePath: rawArchiveFile,
      packageList,
      archiveList: archiveList ?? fileList,
      suppliedManifest: suppliedManifest ?? manifest,
      suppliedVcsInfo: suppliedVcsInfo ?? vcsInfo,
      expectedVersion,
      expectedCommit,
      expectedArchiveSha256,
    })
  }
  if (expectedVersion === CURRENT_RUST_VERSION) fail('Rust 0.11 archive verification requires raw archive bytes')
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

const rust011ManifestIncludes = Object.freeze([
  'Cargo.toml',
  'LICENSE',
  'README.md',
  'LICENSES/Apache-2.0.txt',
  'THIRD_PARTY_NOTICES.md',
  'examples/**/*.rs',
  'src/**/*.rs',
  'tests/**/*.rs',
])

const normalizeRust011SuppliedList = (source, root, label) => {
  if (source === undefined) return undefined
  const values = String(source).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (values.length === 0) fail(`${label} is empty`)
  return values.map(value => {
    let member = value
    if (member.startsWith('./')) member = member.slice(2)
    member = member.replace(/\/$/, '')
    safeRelativePath(member)
    if (member === root || member.startsWith(`${root}/`)) return member
    return `${root}/${member}`
  })
}

const sameMemberSet = (left, right, label) => {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  if (leftSet.size !== left.length || rightSet.size !== right.length || leftSet.size !== rightSet.size || [...leftSet].some(member => !rightSet.has(member))) fail(`${label} member set mismatch`)
}

const normalizedDependencyPolicy = document => {
  const allowed = new Set(['version', 'features', 'default-features', 'optional', 'package', 'registry', 'git', 'path', 'rev', 'branch', 'tag'])
  const normalizeEntry = (name, value, section) => {
    const entry = typeof value === 'string' ? { version: value } : value
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(`Unsupported ${section}.${name} dependency shape`)
    for (const key of Object.keys(entry)) if (!allowed.has(key)) fail(`Unsupported ${section}.${name} dependency policy field ${key}`)
    const normalized = { ...entry, features: entry.features ?? [], 'default-features': entry['default-features'] ?? true, optional: entry.optional ?? false }
    return Object.fromEntries(Object.keys(normalized).sort().map(key => [key, normalized[key]]))
  }
  const normalizeSection = (section, dependencies) => Object.fromEntries(Object.keys(dependencies ?? {}).sort().map(name => [name, normalizeEntry(name, dependencies[name], section)]))
  const policy = {}
  for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) policy[section] = normalizeSection(section, document?.[section])
  const targets = document?.target ?? {}
  policy.target = Object.fromEntries(Object.keys(targets).sort().map(targetName => {
    const target = targets[targetName]
    if (target === null || typeof target !== 'object' || Array.isArray(target)) fail(`Unsupported target dependency policy ${targetName}`)
    return [targetName, Object.fromEntries(['dependencies', 'dev-dependencies', 'build-dependencies'].map(section => [section, normalizeSection(`target.${targetName}.${section}`, target[section])]))]
  }))
  return policy
}

const targetTable = (value, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} target is malformed`)
  const allowed = new Set(['name', 'path', 'crate-type', 'proc-macro', 'test', 'doctest', 'bench', 'doc', 'harness'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`Unsupported ${label} target field ${key}`)
  return value
}

const targetPath = (target, kind) => target.path ?? `${kind === 'example' ? 'examples' : 'tests'}/${target.name}.rs`

const effectiveLibraryTarget = (document, label) => {
  const packageTable = document?.package ?? {}
  if (packageTable.autolib === false && document.lib === undefined) return undefined
  const target = document.lib === undefined ? {} : targetTable(document.lib, `${label} lib`)
  const crateTypes = target['crate-type'] ?? ['lib']
  if (JSON.stringify(crateTypes) !== JSON.stringify(['lib'])) fail(`${label} has unsupported crate-type policy`)
  if (target['proc-macro'] === true) fail(`${label} has unsupported proc-macro policy`)
  return { name: target.name ?? 'erpc_sdk', path: target.path ?? 'src/lib.rs', crateType: ['lib'], procMacro: false, test: target.test ?? true, doctest: target.doctest ?? true, bench: target.bench ?? true, doc: target.doc ?? true, harness: target.harness ?? true }
}

const effectiveAuxiliaryTargets = (document, kind, files, root, label) => {
  const packageTable = document?.package ?? {}
  const autoKey = kind === 'example' ? 'autoexamples' : 'autotests'
  const explicit = Array.isArray(document?.[kind]) ? document[kind] : []
  const targets = new Map()
  for (const raw of explicit) {
    const target = targetTable(raw, `${label} ${kind}`)
    const name = target.name ?? target.path?.split('/').pop()?.replace(/\.rs$/, '')
    if (typeof name !== 'string' || name.length === 0) fail(`${label} ${kind} target name is missing`)
    const path = targetPath({ ...target, name }, kind)
    if (!files.includes(`${root}/${path}`)) fail(`${label} ${kind} target is missing ${path}`)
    if (target['crate-type'] !== undefined && JSON.stringify(target['crate-type']) !== JSON.stringify(['bin'])) fail(`${label} ${kind} has unsupported crate-type policy`)
    if (target['proc-macro'] === true) fail(`${label} ${kind} has unsupported proc-macro policy`)
    targets.set(path, { name, path, test: target.test ?? (kind === 'test'), doctest: target.doctest ?? false, bench: target.bench ?? false, doc: target.doc ?? false, harness: target.harness ?? true })
  }
  if (packageTable[autoKey] !== false) {
    const prefix = kind === 'example' ? `${root}/examples/` : `${root}/tests/`
    for (const file of files.filter(member => member.startsWith(prefix) && member.endsWith('.rs') && !member.endsWith('/support/mod.rs'))) {
      const path = file.slice(root.length + 1)
      const name = path.split('/').pop().replace(/\.rs$/, '')
      if (!targets.has(path)) targets.set(path, { name, path, test: kind === 'test', doctest: false, bench: false, doc: false, harness: true })
    }
  }
  return [...targets.values()].sort((a, b) => a.path.localeCompare(b.path))
}

const assertRust011TargetPolicy = (original, normalized, files, root) => {
  for (const [label, document] of [['original', original], ['normalized', normalized]]) {
    const packageTable = document?.package ?? {}
    if (document?.bin?.length > 0 || document?.bench?.length > 0) fail(`${label} contains unsupported binary/benchmark targets`)
    if (packageTable.build !== undefined && packageTable.build !== false) fail(`${label} contains unsupported build-script policy`)
    if (packageTable.autolib === false && document.lib === undefined) fail(`${label} disables inferred library target`)
    if (packageTable.autotests === false && (!Array.isArray(document.test) || document.test.length === 0)) fail(`${label} disables inferred test targets`)
    if (packageTable.autoexamples === false && (!Array.isArray(document.example) || document.example.length === 0)) fail(`${label} disables inferred example targets`)
  }
  const originalLib = effectiveLibraryTarget(original, 'Rust original')
  const normalizedLib = effectiveLibraryTarget(normalized, 'Rust normalized')
  requireEqual(canonicalJson(originalLib), canonicalJson(normalizedLib), 'Rust original/normalized library target mismatch')
  for (const kind of ['example', 'test']) {
    requireEqual(canonicalJson(effectiveAuxiliaryTargets(original, kind, files, root, 'Rust original')), canonicalJson(effectiveAuxiliaryTargets(normalized, kind, files, root, 'Rust normalized')), `Rust original/normalized ${kind} target mismatch`)
  }
}

const assertRust011ManifestProfile = (document, label) => {
  const packageTable = document?.package
  if (packageTable === null || typeof packageTable !== 'object') fail(`${label} semantic package table is missing`)
  requireEqual(packageTable.name, CRATE_NAME, `${label} package name mismatch`)
  requireEqual(packageTable.version, CURRENT_RUST_VERSION, `${label} package version mismatch`)
  requireEqual(packageTable.license, RUST_011_LICENSE_PROFILE, `${label} license mismatch`)
  requireEqual(packageTable.repository, 'https://github.com/elsoul/erpc-sdk', `${label} repository mismatch`)
  requireEqual(packageTable.edition, '2024', `${label} edition mismatch`)
  requireEqual(packageTable['rust-version'], '1.85', `${label} MSRV mismatch`)
  requireEqual(JSON.stringify(packageTable.publish), JSON.stringify(['crates-io']), `${label} publish target mismatch`)
  sameMemberSet(packageTable.include ?? [], rust011ManifestIncludes, `${label} include`)
  const prost = document.dependencies?.prost
  const prostTypes = document.dependencies?.['prost-types']
  requireEqual(prost?.version, '=0.14.4', `${label} Prost version is not exact`)
  requireEqual(prost?.['default-features'], false, `${label} Prost default-features is not exact`)
  requireEqual(JSON.stringify(prost?.features), JSON.stringify(['derive', 'std']), `${label} Prost features are not exact`)
  requireEqual(prostTypes?.version, '=0.14.4', `${label} prost-types version is not exact`)
  requireEqual(prostTypes?.['default-features'], false, `${label} prost-types default-features is not exact`)
  requireEqual(JSON.stringify(prostTypes?.features), JSON.stringify(['std']), `${label} prost-types features are not exact`)
  return packageTable
}

const rust011ManifestIncludeValues = manifest => {
  const include = manifest.match(/^include\s*=\s*\[([\s\S]*?)\]$/m)?.[1]
  if (include === undefined) fail('Rust 0.11 archive manifest include list is missing')
  return [...include.matchAll(/"([^"\r\n]+)"/g)].map(match => match[1])
}

const rust011PackageBody = manifest => {
  const packageHeaders = manifest.match(/^\[package\]\s*$/gm) ?? []
  if (packageHeaders.length !== 1) fail('Rust 0.11 archive Cargo.toml must contain exactly one [package] table')
  return manifest.split(/^\[package\]\s*$/m)[1]?.split(/^\[[^\]]+\]\s*$/m)[0] ?? ''
}

/** Inspect the actual raw 0.11 .crate bytes, including licences and source. */
export async function inspectRust011Archive({
  filePath,
  packageList,
  archiveList,
  suppliedManifest,
  suppliedVcsInfo,
  expectedVersion,
  expectedCommit,
  expectedArchiveSha256,
  execution = {},
}) {
  requireStableVersion(expectedVersion, 'Expected Rust archive version')
  requireEqual(expectedVersion, CURRENT_RUST_VERSION, 'Rust archive inspection requires 0.11.0')
  requireSha(expectedCommit, 'Expected Rust archive source commit')
  const archiveSha256 = await sha256File(filePath)
  if (expectedArchiveSha256 !== undefined && expectedArchiveSha256 !== '') {
    requireArchiveSha(expectedArchiveSha256, 'Approved Rust archive SHA-256')
    requireEqual(archiveSha256, expectedArchiveSha256, 'Rust archive SHA-256 does not match the approved bytes')
  }

  const root = `${CRATE_NAME}-${expectedVersion}`
  const records = await archiveMemberRecords(filePath, 'tar', execution)
  const names = records.map(record => record.name)
  const roots = new Set(names.map(name => name.split('/')[0]))
  if (roots.size !== 1 || !roots.has(root)) fail(`Rust 0.11 archive must contain only the ${root} root`)
  const files = records.filter(record => record.type === 'file').map(record => record.name)
  const requiredStatic = [
    `${root}/Cargo.toml`,
    `${root}/Cargo.toml.orig`,
    `${root}/Cargo.lock`,
    `${root}/LICENSE`,
    `${root}/README.md`,
    `${root}/LICENSES/Apache-2.0.txt`,
    `${root}/THIRD_PARTY_NOTICES.md`,
    `${root}/.cargo_vcs_info.json`,
    ...RUST_011_CLIENT_MODULES.map(module => `${root}/src/${module}.rs`),
    ...RUST_011_REQUIRED_SOURCE_FILES.map(member => `${root}/${member}`),
    ...RUST_011_SUI_MEMBERS.map(member => `${root}/${member}`),
    ...RUST_011_REQUIRED_EXAMPLES.map(member => `${root}/${member}`),
    ...RUST_011_REQUIRED_TESTS.map(member => `${root}/${member}`),
  ]
  for (const member of requiredStatic) if (!files.includes(member)) fail(`Rust 0.11 archive is missing ${member}`)

  const allowedFiles = new Set([
    `${root}/Cargo.toml`, `${root}/Cargo.toml.orig`, `${root}/Cargo.lock`, `${root}/LICENSE`, `${root}/README.md`,
    `${root}/LICENSES/Apache-2.0.txt`, `${root}/THIRD_PARTY_NOTICES.md`,
    `${root}/.cargo_vcs_info.json`,
  ])
  for (const member of files) {
    if (allowedFiles.has(member)) continue
    const relative = member.slice(root.length + 1)
    if (!/^(?:examples|src|tests)\/.+\.rs$/.test(relative)) fail(`Rust 0.11 archive contains an unlisted member ${member}`)
  }

  const manifestBytes = await commandBuffer('tar', ['-xOf', filePath, `${root}/Cargo.toml`], execution)
  const manifest = Buffer.from(manifestBytes).toString('utf8')
  if (suppliedManifest !== undefined) requireEqual(String(suppliedManifest), manifest, 'Rust archive manifest evidence differs from raw bytes')
  const lockSource = Buffer.from(await commandBuffer('tar', ['-xOf', filePath, `${root}/Cargo.lock`], execution)).toString('utf8')
  const lockPackage = await findLocalCargoPackage(lockSource, CRATE_NAME, execution)
  requireEqual(lockPackage.version, expectedVersion, 'Rust 0.11 archive Cargo.lock version mismatch')
  const manifestToml = await parseCargoToml(manifest, 'Rust 0.11 archive Cargo.toml', execution)
  const packageTable = assertRust011ManifestProfile(manifestToml, 'Rust 0.11 archive Cargo.toml')
  const originalBytes = await commandBuffer('tar', ['-xOf', filePath, `${root}/Cargo.toml.orig`], execution)
  const originalToml = await parseCargoToml(Buffer.from(originalBytes).toString('utf8'), 'Rust 0.11 archive Cargo.toml.orig', execution)
  const originalPackageTable = assertRust011ManifestProfile(originalToml, 'Rust 0.11 archive Cargo.toml.orig')
  for (const field of ['name', 'version', 'license', 'repository', 'edition', 'rust-version']) requireEqual(originalPackageTable[field], packageTable[field], `Rust 0.11 original/normalized ${field} mismatch`)
  requireEqual(canonicalJson(normalizedDependencyPolicy(originalToml)), canonicalJson(normalizedDependencyPolicy(manifestToml)), 'Rust 0.11 original/normalized dependency policy mismatch')
  assertRust011TargetPolicy(originalToml, manifestToml, files, root)
  requireEqual(lockPackage.version, packageTable.version, 'Rust 0.11 archive lock/package version mismatch')
  requireEqual(manifestToml.lib?.path, 'src/lib.rs', 'Rust 0.11 archive library target mismatch')
  requireEqual(manifestToml.lib?.name, 'erpc_sdk', 'Rust 0.11 archive library name mismatch')
  const selectedExamples = Array.isArray(manifestToml.example) ? manifestToml.example : []
  const selectedTests = Array.isArray(manifestToml.test) ? manifestToml.test : []
  if (selectedExamples.length === 0 || selectedTests.length === 0) fail('Rust 0.11 archive has no selected example/test targets')
  for (const target of [...selectedExamples, ...selectedTests]) {
    if (typeof target?.path !== 'string' || !files.includes(`${root}/${target.path}`)) fail(`Rust 0.11 archive target is missing ${target?.path ?? '<unnamed>'}`)
  }

  const vcsBytes = await commandBuffer('tar', ['-xOf', filePath, `${root}/.cargo_vcs_info.json`], execution)
  const vcsInfo = Buffer.from(vcsBytes).toString('utf8')
  if (suppliedVcsInfo !== undefined) requireEqual(String(suppliedVcsInfo), vcsInfo, 'Rust archive VCS evidence differs from raw bytes')
  let vcs
  try { vcs = JSON.parse(vcsInfo) } catch { fail('Rust 0.11 archive VCS metadata is malformed') }
  requireEqual(vcs?.git?.sha1 ?? vcs?.git?.commit, expectedCommit, 'Rust 0.11 archive VCS source mismatch')
  if (vcs?.git?.dirty !== undefined && vcs.git.dirty !== false) fail('Rust 0.11 archive VCS metadata dirty value is not clean')
  requireEqual(vcs?.path_in_vcs, 'packages/rust', 'Rust 0.11 archive VCS path mismatch')

  const licenseHashes = {}
  for (const [relative, expectedHash] of Object.entries(RUST_011_LICENSE_HASHES)) {
    const member = `${root}/${relative}`
    const digest = sha256Hex(await commandBuffer('tar', ['-xOf', filePath, member], execution))
    requireEqual(digest, expectedHash, `Rust 0.11 archive hash mismatch for ${relative}`)
    licenseHashes[relative] = digest
  }
  const notices = Buffer.from(await commandBuffer('tar', ['-xOf', filePath, `${root}/THIRD_PARTY_NOTICES.md`], execution)).toString('utf8')
  for (const marker of ['aa9ba2c13b2a9348059b38110e64af39849a0377', 'proto/sui/rpc/v2/ledger_service.proto', 'proto/sui/rpc/v2/state_service.proto', 'proto/sui/rpc/v2/object.proto', 'prost 0.14.4', 'prost-types 0.14.4']) if (!notices.includes(marker)) fail(`Rust 0.11 notice is missing ${marker}`)

  const suppliedArchiveMembers = normalizeRust011SuppliedList(archiveList, root, 'Rust archive member list')
  if (suppliedArchiveMembers !== undefined) {
    const rawLines = String(archiveList).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const includesDirectories = rawLines.some(line => line.endsWith('/'))
    sameMemberSet(suppliedArchiveMembers, includesDirectories ? names : files, 'Rust archive supplied list')
  }
  const suppliedPackageMembers = normalizeRust011SuppliedList(packageList, root, 'Rust package member list')
  if (suppliedPackageMembers !== undefined) sameMemberSet(suppliedPackageMembers, files, 'Rust package supplied list')

  return {
    crate: CRATE_NAME,
    version: expectedVersion,
    sha256: archiveSha256,
    sizeInBytes: (await stat(filePath)).size,
    root,
    sourceCommit: expectedCommit,
    pathInVcs: vcs.path_in_vcs,
    licenseProfile: RUST_011_LICENSE_PROFILE,
    licenseHashes,
    members: names.slice().sort(),
    clientModules: RUST_011_CLIENT_MODULES.map(module => `src/${module}.rs`),
    suiMembers: RUST_011_SUI_MEMBERS.slice(),
    examples: RUST_011_REQUIRED_EXAMPLES.slice(),
    tests: RUST_011_REQUIRED_TESTS.slice(),
  }
}

// Keep an explicit verification name for callers that distinguish the raw
// current archive path from the historical text-only helper above.
export const verifyRust011Archive = inspectRust011Archive

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

const requireFuturePositiveId = (value, label) => {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9][0-9]*$/.test(String(value))) fail(`${label} must be a positive numeric ID`)
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || String(numeric) !== String(value)) fail(`${label} must be a safe positive numeric ID`)
  return String(value)
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

const publicationRecoveryContextPayload = context => {
  const { contextSha256: _contextSha256, ...payload } = context ?? {}
  return payload
}

const publicationRecoveryExpectedArtifacts = Object.freeze({
  npm: PUBLICATION_RECOVERY_NPM_SHA256,
  'pypi-wheel': PUBLICATION_RECOVERY_PYPI_WHEEL_SHA256,
  'pypi-sdist': PUBLICATION_RECOVERY_PYPI_SDIST_SHA256,
  rubygems: PUBLICATION_RECOVERY_RUBYGEMS_SHA256,
})

const publicationRecoveryId = (value, label) => requireFuturePositiveId(value, label)

const publicationRecoveryRunTuple = (value, label) => {
  releaseSetObject(value, label)
  return {
    runId: publicationRecoveryId(value.runId, `${label} run ID`),
    runAttempt: publicationRecoveryId(value.runAttempt, `${label} attempt`),
  }
}

/**
 * Validate the live controller identity for the one approved recovery route.
 * This is intentionally separate from validateReleaseSetContext: a normal
 * release-set plan is M-valued and must continue rejecting a C-valued runtime.
 */
export function validatePublicationRecoveryRuntimeContext(context) {
  releaseSetKeys(context, [
    'mode', 'repository', 'repositoryId', 'eventName', 'eventRef', 'eventSha',
    'expectedControlCommit', 'checkoutHead', 'checkoutStatus', 'workflowRef',
    'workflowSha', 'mainSha', 'sourceM', 'sourceMAncestor', 'deltaPaths',
  ], 'Publication recovery runtime context')
  requireEqual(context.mode, PUBLICATION_RECOVERY_MODE, 'Publication recovery mode is not the approved finite route')
  requireEqual(context.repository, EXPECTED_REPOSITORY, 'Publication recovery repository mismatch')
  requireEqual(String(context.repositoryId), EXPECTED_REPOSITORY_ID, 'Publication recovery repository ID mismatch')
  requireEqual(context.eventName, 'workflow_dispatch', 'Publication recovery must be manually dispatched')
  requireEqual(context.eventRef, 'refs/heads/main', 'Publication recovery must run on main')
  requireSha(context.eventSha, 'Publication recovery event SHA')
  requireSha(context.expectedControlCommit, 'Publication recovery control commit')
  requireSha(context.checkoutHead, 'Publication recovery checkout HEAD')
  requireSha(context.workflowSha, 'Publication recovery workflow SHA')
  requireEqual(context.expectedControlCommit, context.eventSha, 'Publication recovery input must match the live event SHA')
  requireEqual(context.expectedControlCommit, context.checkoutHead, 'Publication recovery checkout is not the reviewed controller')
  requireEqual(context.expectedControlCommit, context.workflowSha, 'Publication recovery workflow SHA is not the reviewed controller')
  requireEqual(context.mainSha, context.expectedControlCommit, 'Publication recovery main ref moved before the control boundary')
  requireEqual(context.checkoutStatus, '', 'Publication recovery checkout must be clean')
  requireEqual(context.workflowRef, `${EXPECTED_REPOSITORY}/${RELEASE_SET_WORKFLOW}@refs/heads/main`, 'Publication recovery workflow ref mismatch')
  requireEqual(context.sourceM, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery package source M mismatch')
  requireEqual(context.sourceMAncestor, true, 'Publication recovery source M is not an ancestor of controller C')
  if (!Array.isArray(context.deltaPaths)) fail('Publication recovery M-to-C delta is missing')
  const delta = [...context.deltaPaths].sort()
  const expected = [...PUBLICATION_RECOVERY_ALLOWED_DELTA].sort()
  requireEqual(canonicalJson(delta), canonicalJson(expected), 'Publication recovery M-to-C delta is outside the four approved files')
  return { controlCommit: context.expectedControlCommit, sourceM: context.sourceM, deltaPaths: delta }
}

/** Build the immutable recovery context recorded outside the public asset set. */
export function buildPublicationRecoveryContext({ runtime, preparation, originalPublication, recoveryRun, ciProof, sourceCiProof }) {
  const checkedRuntime = validatePublicationRecoveryRuntimeContext(runtime)
  const checkedPreparation = publicationRecoveryRunTuple(preparation, 'Publication recovery preparation')
  requireEqual(preparation.sourceCommit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery preparation source mismatch')
  requireEqual(preparation.planSha256, PUBLICATION_RECOVERY_PLAN_SHA256, 'Publication recovery preparation plan mismatch')
  const checkedOriginal = publicationRecoveryRunTuple(originalPublication, 'Publication recovery original publication')
  requireEqual(checkedOriginal.runId, PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ID, 'Publication recovery original publication run mismatch')
  requireEqual(checkedOriginal.runAttempt, PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ATTEMPT, 'Publication recovery original publication attempt mismatch')
  const checkedRecovery = publicationRecoveryRunTuple(recoveryRun, 'Publication recovery run')
  if (ciProof !== undefined) {
    releaseSetObject(ciProof, 'Publication recovery C CI proof')
    requireEqual(ciProof.sourceCommit, checkedRuntime.controlCommit, 'Publication recovery C CI source mismatch')
    requireEqual(ciProof.conclusion, 'success', 'Publication recovery C CI did not succeed')
  }
  if (sourceCiProof !== undefined) {
    releaseSetObject(sourceCiProof, 'Publication recovery M CI proof')
    requireEqual(sourceCiProof.sourceCommit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery M CI source mismatch')
    requireEqual(sourceCiProof.conclusion, 'success', 'Publication recovery M CI did not succeed')
  }
  const payload = {
    schemaVersion: 1,
    kind: 'erpc-sdk-publication-recovery-context',
    mode: PUBLICATION_RECOVERY_MODE,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    sourceM: PUBLICATION_RECOVERY_SOURCE_M,
    controlCommit: checkedRuntime.controlCommit,
    controlWorkflow: RELEASE_SET_WORKFLOW,
    controlWorkflowRef: runtime.workflowRef,
    event: { name: runtime.eventName, ref: runtime.eventRef, sha: runtime.eventSha },
    checkout: { head: runtime.checkoutHead, status: runtime.checkoutStatus },
    deltaPaths: [...runtime.deltaPaths].sort(),
    planSha256: PUBLICATION_RECOVERY_PLAN_SHA256,
    preparation: { ...checkedPreparation, sourceCommit: PUBLICATION_RECOVERY_SOURCE_M, artifactId: String(preparation.artifactId), bindingArtifactId: String(preparation.bindingArtifactId), planSha256: PUBLICATION_RECOVERY_PLAN_SHA256 },
    originalPublication: {
      ...checkedOriginal,
      sourceCommit: PUBLICATION_RECOVERY_SOURCE_M,
      workflowPath: RELEASE_SET_WORKFLOW,
      status: originalPublication.status,
      conclusion: originalPublication.conclusion,
      jobOutcomes: originalPublication.jobOutcomes,
      outcomes: originalPublication.outcomes,
    },
    recoveryRun: checkedRecovery,
    ciProof,
    sourceCiProof,
    registryWrites: { npm: false, pypi: true, rubygems: false, rust: false },
  }
  return { ...payload, contextSha256: sha256Hex(canonicalJson(payload)) }
}

/**
 * Authenticate a recovery context at every read/write boundary.  The context
 * hash covers the frozen M/preparation/publication tuple and actual C run;
 * callers must pass the same object again before an effect.
 */
export function validatePublicationRecoveryContext(context, { requireCiProof = false } = {}) {
  releaseSetKeys(context, [
    'schemaVersion', 'kind', 'mode', 'repository', 'repositoryId', 'sourceM',
    'controlCommit', 'controlWorkflow', 'controlWorkflowRef', 'event', 'checkout',
    'deltaPaths', 'planSha256', 'preparation', 'originalPublication', 'recoveryRun',
    'ciProof', 'sourceCiProof', 'registryWrites', 'contextSha256',
  ], 'Publication recovery context')
  requireEqual(context.schemaVersion, 1, 'Publication recovery context schema mismatch')
  requireEqual(context.kind, 'erpc-sdk-publication-recovery-context', 'Publication recovery context kind mismatch')
  requireEqual(context.mode, PUBLICATION_RECOVERY_MODE, 'Publication recovery context mode mismatch')
  requireEqual(context.sourceM, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery context source M mismatch')
  requireEqual(context.planSha256, PUBLICATION_RECOVERY_PLAN_SHA256, 'Publication recovery context plan mismatch')
  requireEqual(context.controlCommit, context.event?.sha, 'Publication recovery context control/event mismatch')
  requireEqual(context.controlCommit, context.checkout?.head, 'Publication recovery context checkout mismatch')
  requireEqual(context.checkout?.status, '', 'Publication recovery context checkout is dirty')
  requireEqual(context.controlWorkflow, RELEASE_SET_WORKFLOW, 'Publication recovery context workflow mismatch')
  requireEqual(context.controlWorkflowRef, `${EXPECTED_REPOSITORY}/${RELEASE_SET_WORKFLOW}@refs/heads/main`, 'Publication recovery context workflow ref mismatch')
  validatePublicationRecoveryRuntimeContext({
    mode: context.mode,
    repository: context.repository,
    repositoryId: context.repositoryId,
    eventName: context.event?.name,
    eventRef: context.event?.ref,
    eventSha: context.event?.sha,
    expectedControlCommit: context.controlCommit,
    checkoutHead: context.checkout?.head,
    checkoutStatus: context.checkout?.status,
    workflowRef: context.controlWorkflowRef,
    workflowSha: context.controlCommit,
    mainSha: context.controlCommit,
    sourceM: context.sourceM,
    sourceMAncestor: true,
    deltaPaths: context.deltaPaths,
  })
  const preparation = { ...publicationRecoveryRunTuple(context.preparation, 'Publication recovery context preparation'), artifactId: publicationRecoveryId(context.preparation.artifactId, 'Publication recovery context preparation artifact'), bindingArtifactId: publicationRecoveryId(context.preparation.bindingArtifactId, 'Publication recovery context preparation binding artifact') }
  requireEqual(preparation.runId, PUBLICATION_RECOVERY_PREPARED_RUN_ID, 'Publication recovery context preparation run mismatch')
  requireEqual(preparation.runAttempt, PUBLICATION_RECOVERY_PREPARED_RUN_ATTEMPT, 'Publication recovery context preparation attempt mismatch')
  requireEqual(preparation.artifactId, PUBLICATION_RECOVERY_BUNDLE_ARTIFACT_ID, 'Publication recovery context preparation artifact mismatch')
  requireEqual(preparation.bindingArtifactId, PUBLICATION_RECOVERY_BINDING_ARTIFACT_ID, 'Publication recovery context preparation binding artifact mismatch')
  requireEqual(context.preparation.sourceCommit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery context preparation source mismatch')
  requireEqual(context.preparation.planSha256, PUBLICATION_RECOVERY_PLAN_SHA256, 'Publication recovery context preparation digest mismatch')
  const original = publicationRecoveryRunTuple(context.originalPublication, 'Publication recovery context original publication')
  requireEqual(original.runId, PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ID, 'Publication recovery context original publication run mismatch')
  requireEqual(original.runAttempt, PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ATTEMPT, 'Publication recovery context original publication attempt mismatch')
  requireEqual(context.originalPublication.sourceCommit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery context original publication source mismatch')
  requireEqual(context.originalPublication.workflowPath, RELEASE_SET_WORKFLOW, 'Publication recovery context original publication workflow mismatch')
  requireEqual(context.originalPublication.status, 'completed', 'Publication recovery original publication is not terminal')
  requireEqual(context.originalPublication.conclusion, 'failure', 'Publication recovery original publication outcome mismatch')
  validatePublicationRecoveryOriginalPublication({
    run: { id: Number(original.runId), run_attempt: Number(original.runAttempt), repository: { full_name: EXPECTED_REPOSITORY, id: Number(EXPECTED_REPOSITORY_ID) }, path: RELEASE_SET_WORKFLOW, head_branch: 'main', head_sha: PUBLICATION_RECOVERY_SOURCE_M, event: 'workflow_dispatch', status: context.originalPublication.status, conclusion: context.originalPublication.conclusion },
    jobs: context.originalPublication.jobOutcomes,
    outcomes: context.originalPublication.outcomes,
  })
  const recovery = publicationRecoveryRunTuple(context.recoveryRun, 'Publication recovery context run')
  if (requireCiProof && context.ciProof === undefined) fail('Publication recovery context is missing C CI proof')
  if (requireCiProof && context.sourceCiProof === undefined) fail('Publication recovery context is missing M CI proof')
  if (context.ciProof !== undefined) {
    requireEqual(context.ciProof.sourceCommit, context.controlCommit, 'Publication recovery context C CI source mismatch')
    requireEqual(context.ciProof.conclusion, 'success', 'Publication recovery context C CI outcome mismatch')
  }
  if (context.sourceCiProof !== undefined) {
    requireEqual(context.sourceCiProof.sourceCommit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery context M CI source mismatch')
    requireEqual(context.sourceCiProof.conclusion, 'success', 'Publication recovery context M CI outcome mismatch')
  }
  releaseSetKeys(context.registryWrites, ['npm', 'pypi', 'rubygems', 'rust'], 'Publication recovery registry-write capability')
  requireEqual(context.registryWrites.npm, false, 'Publication recovery unexpectedly grants npm write capability')
  requireEqual(context.registryWrites.rubygems, false, 'Publication recovery unexpectedly grants RubyGems write capability')
  requireEqual(context.registryWrites.rust, false, 'Publication recovery unexpectedly grants Rust write capability')
  requireEqual(context.registryWrites.pypi, true, 'Publication recovery PyPI write capability is missing')
  requireArchiveSha(context.contextSha256, 'Publication recovery context hash')
  requireEqual(context.contextSha256, sha256Hex(canonicalJson(publicationRecoveryContextPayload(context))), 'Publication recovery context hash mismatch')
  return { ...context, preparation, originalPublication: original, recoveryRun: recovery }
}

/** Authenticate the observed terminal failure and its individual job outcomes. */
export function validatePublicationRecoveryOriginalPublication({ run, jobs, outcomes }) {
  requireEqual(run?.id, Number(PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ID), 'Original publication run ID mismatch')
  requireEqual(run?.run_attempt, Number(PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ATTEMPT), 'Original publication attempt mismatch')
  requireEqual(run?.repository?.full_name, EXPECTED_REPOSITORY, 'Original publication repository mismatch')
  requireEqual(String(run?.repository?.id), EXPECTED_REPOSITORY_ID, 'Original publication repository ID mismatch')
  requireEqual(run?.path, RELEASE_SET_WORKFLOW, 'Original publication workflow mismatch')
  requireEqual(run?.head_branch, 'main', 'Original publication branch mismatch')
  requireEqual(run?.head_sha, PUBLICATION_RECOVERY_SOURCE_M, 'Original publication source mismatch')
  requireEqual(run?.event, 'workflow_dispatch', 'Original publication event mismatch')
  requireEqual(run?.status, 'completed', 'Original publication is not complete')
  requireEqual(run?.conclusion, 'failure', 'Original publication was not the recorded failure')
  if (!Array.isArray(jobs) || jobs.length === 0) fail('Original publication job outcomes are missing')
  const seen = new Set()
  for (const job of jobs) {
    const identity = `${job?.id ?? ''}/${job?.run_attempt ?? ''}`
    if (seen.has(identity)) fail('Original publication job outcomes contain duplicate identities')
    seen.add(identity)
    publicationRecoveryId(job?.id, 'Original publication job ID')
    requireEqual(job?.run_id, Number(PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ID), 'Original publication job run mismatch')
    requireEqual(job?.run_attempt, Number(PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ATTEMPT), 'Original publication job attempt mismatch')
    requireEqual(job?.status, 'completed', 'Original publication job is not terminal')
    if (!['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped'].includes(job?.conclusion)) fail('Original publication job conclusion is invalid')
  }
  const jobsById = new Map(jobs.map(job => [String(job.id), job]))
  const npmJob = jobsById.get(PUBLICATION_RECOVERY_ORIGINAL_NPM_JOB_ID)
  const pypiJob = jobsById.get(PUBLICATION_RECOVERY_ORIGINAL_PYPI_JOB_ID)
  const rubygemsJob = jobsById.get(PUBLICATION_RECOVERY_ORIGINAL_RUBYGEMS_JOB_ID)
  for (const [job, label] of [[npmJob, 'npm'], [pypiJob, 'PyPI'], [rubygemsJob, 'RubyGems']]) {
    if (job === undefined || !Array.isArray(job.steps)) fail(`Original publication ${label} individual job step evidence is missing`)
  }
  const stepConclusion = (job, needle, label) => {
    const matches = job.steps.filter(step => `${step?.name ?? ''}`.toLowerCase().includes(needle))
    if (matches.length !== 1) fail(`Original publication ${label} step evidence is missing or ambiguous`)
    return matches[0]?.conclusion
  }
  requireEqual(stepConclusion(npmJob, 'publish exact npm archive once', 'npm upload'), 'success', 'Original publication npm upload step evidence mismatch')
  requireEqual(stepConclusion(npmJob, 'observe npm public bytes', 'npm observer'), 'failure', 'Original publication npm observer step evidence mismatch')
  requireEqual(stepConclusion(pypiJob, 'publish exact missing pypi files', 'PyPI upload'), 'skipped', 'Original publication PyPI upload step evidence mismatch')
  requireEqual(stepConclusion(pypiJob, 'observe pypi files', 'PyPI observer'), 'failure', 'Original publication PyPI observer step evidence mismatch')
  requireEqual(stepConclusion(rubygemsJob, 'publish the exact reviewed gem once', 'RubyGems upload'), 'success', 'Original publication RubyGems upload step evidence mismatch')
  requireEqual(rubygemsJob.conclusion, 'success', 'Original publication RubyGems job outcome mismatch')
  releaseSetKeys(outcomes, ['npmPublished', 'rubygemsPublished', 'pypiUploadAttempted', 'pypiBeforeUploadFailure', 'npmObserverFailure', 'npmJobConclusion', 'npmUploadStepConclusion', 'npmObserverStepConclusion', 'rubygemsJobConclusion', 'rubygemsUploadStepConclusion', 'pypiJobConclusion', 'pypiUploadStepConclusion', 'pypiObserverStepConclusion'], 'Original publication outcomes')
  requireEqual(outcomes.npmPublished, true, 'Original publication did not authenticate npm upload step success')
  requireEqual(outcomes.npmJobConclusion, 'failure', 'Original publication npm job failure is not retained')
  requireEqual(outcomes.npmUploadStepConclusion, 'success', 'Original publication npm upload step was not successful')
  requireEqual(outcomes.npmObserverStepConclusion, 'failure', 'Original publication npm observer failure is not retained')
  requireEqual(outcomes.rubygemsPublished, true, 'Original publication did not authenticate RubyGems success')
  requireEqual(outcomes.rubygemsJobConclusion, 'success', 'Original publication RubyGems job outcome mismatch')
  requireEqual(outcomes.rubygemsUploadStepConclusion, 'success', 'Original publication RubyGems upload step mismatch')
  requireEqual(outcomes.pypiUploadAttempted, false, 'Original publication unexpectedly uploaded PyPI bytes')
  requireEqual(outcomes.pypiBeforeUploadFailure, true, 'Original publication PyPI failure was not before upload')
  requireEqual(outcomes.pypiJobConclusion, 'failure', 'Original publication PyPI job failure is not retained')
  requireEqual(outcomes.pypiUploadStepConclusion, 'skipped', 'Original publication PyPI upload step was not actually skipped')
  requireEqual(outcomes.pypiObserverStepConclusion, 'failure', 'Original publication PyPI observer failure is not retained')
  return { runId: PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ID, runAttempt: PUBLICATION_RECOVERY_ORIGINAL_PUBLICATION_RUN_ATTEMPT, jobs: jobs.length, outcomes }
}

/**
 * Verify the frozen plan/bundle directory before any recovery registry
 * credential is requested.  This calls the ordinary byte/profile verifier;
 * recovery only changes the accepted identity context, never archive bytes.
 */
export async function validatePublicationRecoveryBundle({ plan, artifactDirectory, binding, bindingArtifactId, bundleZip, bindingZip, bundleMetadata, bindingMetadata, bindingDirectory } = {}) {
  const normalized = validateReleaseSetPlan(plan)
  requireEqual(releaseSetPlanDigest(normalized), PUBLICATION_RECOVERY_PLAN_SHA256, 'Publication recovery plan digest mismatch')
  requireEqual(normalized.sourceCommit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery plan source mismatch')
  requireEqual(normalized.versions.nonRustVersion, PUBLICATION_RECOVERY_VERSION, 'Publication recovery non-Rust version mismatch')
  requireEqual(normalized.versions.rustVersion, PUBLICATION_RECOVERY_VERSION, 'Publication recovery Rust version mismatch')
  requireEqual(normalized.tags.commit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery tag source must remain M')
  const expectedArchive = publicationRecoveryExpectedArtifacts
  for (const artifact of normalized.artifacts) requireEqual(artifact.sha256, expectedArchive[artifact.kind], `Publication recovery ${artifact.kind} archive digest mismatch`)
  const expectedFiles = [...PUBLICATION_RECOVERY_BUNDLE_FILES].sort()
  const actualEntries = (await readdir(artifactDirectory, { withFileTypes: true })).map(entry => entry.name).sort()
  requireEqual(canonicalJson(actualEntries), canonicalJson(expectedFiles), 'Publication recovery bundle members are not the frozen nine files')
  const prepared = await ingestReleaseSetBundle({ plan: normalized, artifactDirectory })
  if (bundleZip !== undefined || bindingZip !== undefined) {
    if (bundleZip === undefined || bindingZip === undefined || bundleMetadata === undefined || bindingMetadata === undefined || bindingDirectory === undefined) fail('Publication recovery raw ZIP evidence is incomplete')
    requireEqual(await sha256File(bundleZip), PUBLICATION_RECOVERY_BUNDLE_ZIP_SHA256, 'Publication recovery bundle ZIP digest mismatch')
    requireEqual(await sha256File(bindingZip), PUBLICATION_RECOVERY_BINDING_ZIP_SHA256, 'Publication recovery binding ZIP digest mismatch')
    await verifyReleaseSetArtifactZip({ zipFile: bundleZip, metadata: bundleMetadata, expectedId: PUBLICATION_RECOVERY_BUNDLE_ARTIFACT_ID, consumedDirectory: artifactDirectory, expectedName: `release-set-bundle-${PUBLICATION_RECOVERY_SOURCE_M}` })
    await verifyReleaseSetArtifactZip({ zipFile: bindingZip, metadata: bindingMetadata, expectedId: PUBLICATION_RECOVERY_BINDING_ARTIFACT_ID, consumedDirectory: bindingDirectory, expectedName: `release-set-binding-${PUBLICATION_RECOVERY_PREPARED_RUN_ID}-${PUBLICATION_RECOVERY_PREPARED_RUN_ATTEMPT}` })
  }
  if (binding !== undefined) {
    validateReleaseSetPreparationBinding(binding, { plan: normalized, expected: { runId: PUBLICATION_RECOVERY_PREPARED_RUN_ID, runAttempt: PUBLICATION_RECOVERY_PREPARED_RUN_ATTEMPT, artifactId: PUBLICATION_RECOVERY_BUNDLE_ARTIFACT_ID } })
    if (bindingArtifactId !== undefined) requireEqual(String(bindingArtifactId), PUBLICATION_RECOVERY_BINDING_ARTIFACT_ID, 'Publication recovery binding artifact ID mismatch')
  }
  return { plan: normalized, prepared, sourceCommit: PUBLICATION_RECOVERY_SOURCE_M, planSha256: PUBLICATION_RECOVERY_PLAN_SHA256, bundleFiles: expectedFiles }
}

const publicationRecoveryReadOnlyState = (record, kind, expectedSha256, { provenanceSource = PUBLICATION_RECOVERY_SOURCE_M } = {}) => {
  if (!record || typeof record !== 'object') fail(`Publication recovery ${kind} public proof is missing`)
  requireEqual(record.state === undefined ? 'observed' : record.state, 'observed', `Publication recovery ${kind} public proof is incomplete`)
  const observed = record.observedSha256 ?? record.archive?.sha256 ?? record.download?.sha256 ?? record.descriptor?.observedSha256
  requireEqual(observed, expectedSha256, `Publication recovery ${kind} public bytes mismatch`)
  requireEqual(record.auth?.requested, false, `Publication recovery ${kind} requested credentials`)
  requireEqual(record.auth?.uploadAttempted, false, `Publication recovery ${kind} attempted an upload`)
  const source = kind === 'Rust'
    ? record.archive?.sourceCommit ?? record.preparation?.sourceCommit
    : record.publisher?.sourceCommit ?? record.provenance?.sourceCommit ?? record.originalProvenance?.sourceCommit ?? record.preparation?.sourceCommit
  requireEqual(source, provenanceSource, `Publication recovery ${kind} original provenance source mismatch`)
  return record
}

/** Classify the finite recovery preflight before the PyPI protected job. */
export function classifyPublicationRecoveryPreflight({ npm, rubygems, rust, pypi, controlCommit = undefined }) {
  const npmProof = publicationRecoveryReadOnlyState(npm, 'npm', PUBLICATION_RECOVERY_NPM_SHA256)
  const rubyProof = publicationRecoveryReadOnlyState(rubygems, 'RubyGems', PUBLICATION_RECOVERY_RUBYGEMS_SHA256)
  const rustProof = publicationRecoveryReadOnlyState(rust, 'Rust', RUST_011_REUSE_SHA256, { provenanceSource: RUST_011_REUSE_SOURCE })
  requireEqual(rust?.preparation?.sourceCommit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery Rust preparation source must remain M')
  if (rust?.mode !== 'reuse' || rust?.version !== PUBLICATION_RECOVERY_VERSION) fail('Publication recovery Rust proof is not immutable reuse')
  releaseSetKeys(pypi, ['state', 'status', 'missing', 'existing', 'absenceGate'], 'Publication recovery PyPI preflight')
  if (!['absent', 'partial', 'match'].includes(pypi.state)) fail(`Publication recovery PyPI preflight stopped in ${pypi.state}`)
  const expectedPyPi = new Set(['erpc_sdk-0.11.0-py3-none-any.whl', 'erpc_sdk-0.11.0.tar.gz'])
  const missing = Array.isArray(pypi.missing) ? [...new Set(pypi.missing)] : []
  const existing = Array.isArray(pypi.existing) ? pypi.existing : []
  for (const filename of missing) if (!expectedPyPi.has(filename)) fail(`Publication recovery PyPI missing file is not approved: ${filename}`)
  for (const file of existing) {
    releaseSetKeys(file, ['filename', 'sha256', 'yanked', 'attestationVerified', 'publisherSourceCommit', 'publisher'], 'Publication recovery existing PyPI file')
    const expected = file.filename === 'erpc_sdk-0.11.0-py3-none-any.whl' ? PUBLICATION_RECOVERY_PYPI_WHEEL_SHA256 : file.filename === 'erpc_sdk-0.11.0.tar.gz' ? PUBLICATION_RECOVERY_PYPI_SDIST_SHA256 : undefined
    if (expected === undefined) fail(`Publication recovery PyPI existing file is not approved: ${file.filename}`)
    requireEqual(file.sha256, expected, `Publication recovery PyPI existing ${file.filename} digest mismatch`)
    requireEqual(file.yanked, false, `Publication recovery PyPI existing ${file.filename} is yanked`)
    requireEqual(file.attestationVerified, true, `Publication recovery PyPI existing ${file.filename} attestation is not verified`)
    requireEqual(file.publisherSourceCommit === PUBLICATION_RECOVERY_SOURCE_M || (controlCommit !== undefined && file.publisherSourceCommit === controlCommit), true, `Publication recovery PyPI existing ${file.filename} provenance source mismatch`)
    if (file.publisher !== undefined) {
      requireEqual(file.publisher.sourceCommit, file.publisherSourceCommit, `Publication recovery PyPI existing ${file.filename} publisher source mismatch`)
      publicationRecoveryId(file.publisher.publisherRunId, `Publication recovery PyPI existing ${file.filename} publisher run ID`)
      publicationRecoveryId(file.publisher.publisherAttempt, `Publication recovery PyPI existing ${file.filename} publisher attempt`)
    }
  }
  if (pypi.state === 'absent') {
    requireEqual(pypi.absenceGate, true, 'Publication recovery PyPI absence gate is missing')
    requireEqual(canonicalJson(missing.sort()), canonicalJson([...expectedPyPi].sort()), 'Publication recovery absent PyPI target must stage both original files')
  }
  if (pypi.state === 'partial' && missing.length === 0) fail('Publication recovery PyPI partial state has no missing file')
  if (pypi.state === 'match' && missing.length !== 0) fail('Publication recovery PyPI match state has missing files')
  return { state: pypi.state, missing: missing.sort(), npm: npmProof, rubygems: rubyProof, rust: rustProof }
}

/** Validate mixed-origin receipts produced by the recovery observers. */
export function validatePublicationRecoveryReceipt(receipt, { kind, context, expectedSha256, pypiPublisherSource, pypiPublisherSources } = {}) {
  validatePublicationRecoveryContext(context)
  releaseSetObject(receipt, `Publication recovery ${kind} receipt`)
  requireEqual(receipt.repository, EXPECTED_REPOSITORY, `Publication recovery ${kind} receipt repository mismatch`)
  requireEqual(String(receipt.repositoryId), EXPECTED_REPOSITORY_ID, `Publication recovery ${kind} receipt repository ID mismatch`)
  requireEqual(receipt.planSha256, PUBLICATION_RECOVERY_PLAN_SHA256, `Publication recovery ${kind} receipt plan mismatch`)
  requireEqual(receipt.preparation?.sourceCommit, PUBLICATION_RECOVERY_SOURCE_M, `Publication recovery ${kind} preparation source mismatch`)
  requireEqual(String(receipt.preparation?.runId), PUBLICATION_RECOVERY_PREPARED_RUN_ID, `Publication recovery ${kind} preparation run mismatch`)
  requireEqual(String(receipt.preparation?.runAttempt), PUBLICATION_RECOVERY_PREPARED_RUN_ATTEMPT, `Publication recovery ${kind} preparation attempt mismatch`)
  requireEqual(String(receipt.preparation?.artifactId), PUBLICATION_RECOVERY_BUNDLE_ARTIFACT_ID, `Publication recovery ${kind} preparation artifact mismatch`)
  requireEqual(receipt.observer?.sourceCommit, context.controlCommit, `Publication recovery ${kind} observer source must be C`)
  requireEqual(receipt.recoveryContextSha256, context.contextSha256, `Publication recovery ${kind} context binding mismatch`)
  if (kind === 'pypi') {
    requireEqual(receipt.auth?.requested === true || receipt.auth?.requested === false, true, 'Publication recovery PyPI auth state is malformed')
    requireEqual(receipt.auth?.uploadAttempted, receipt.auth?.requested, 'Publication recovery PyPI upload/auth state mismatch')
  } else {
    requireEqual(receipt.auth?.requested, false, `Publication recovery ${kind} receipt requested credentials unexpectedly`)
    requireEqual(receipt.auth?.uploadAttempted, false, `Publication recovery ${kind} receipt upload capability is not read-only`)
  }
  if (expectedSha256 !== undefined) {
    const observed = receipt.descriptor?.observedSha256 ?? receipt.archive?.sha256 ?? receipt.download?.sha256 ?? receipt.observedSha256
    requireEqual(observed, expectedSha256, `Publication recovery ${kind} receipt digest mismatch`)
  }
  if (kind === 'pypi') {
    if (pypiPublisherSource === undefined && pypiPublisherSources === undefined) fail('Publication recovery PyPI publisher source is missing')
    if (pypiPublisherSource !== undefined) requireEqual(pypiPublisherSource === context.controlCommit || pypiPublisherSource === PUBLICATION_RECOVERY_SOURCE_M, true, 'Publication recovery PyPI publisher source is outside M/C')
    const publishers = receipt.publishers ?? {}
    for (const [filename, publisher] of Object.entries(publishers)) {
      const expectedSource = pypiPublisherSources?.[filename] ?? pypiPublisherSource
      requireEqual(expectedSource === context.controlCommit || expectedSource === PUBLICATION_RECOVERY_SOURCE_M, true, 'Publication recovery PyPI publisher source is outside M/C')
      requireEqual(publisher.sourceCommit, expectedSource, 'Publication recovery PyPI publisher source is not the authenticated M/C identity')
      publicationRecoveryId(publisher.publisherRunId, `Publication recovery PyPI ${filename} publisher run ID`)
      publicationRecoveryId(publisher.publisherAttempt, `Publication recovery PyPI ${filename} publisher attempt`)
    }
  } else {
    const provenanceSource = receipt.publisher?.sourceCommit ?? receipt.provenance?.certificateClaims?.['1.3.6.1.4.1.57264.1.13'] ?? receipt.originalProvenance?.sourceCommit ?? receipt.archive?.sourceCommit ?? receipt.preparation?.sourceCommit
    requireEqual(provenanceSource, kind === 'rust' ? RUST_011_REUSE_SOURCE : PUBLICATION_RECOVERY_SOURCE_M, `Publication recovery ${kind} provenance must remain ${kind === 'rust' ? 'the immutable Rust source' : 'M'}`)
  }
  return receipt
}

/** Ensure a tag/Go target can only ever be M, never the recovery controller C. */
export function validatePublicationRecoveryTagTargets({ plan, releaseTag, goTag, releaseCommit, goCommit }) {
  releaseSetObject(plan, 'Publication recovery tag plan')
  requireEqual(plan.sourceCommit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery tag plan source mismatch')
  requireEqual(plan.tags?.commit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery tag plan target is not M')
  requireEqual(releaseTag, plan.tags?.release, 'Publication recovery release tag name mismatch')
  requireEqual(goTag, plan.tags?.go, 'Publication recovery Go tag name mismatch')
  requireEqual(releaseCommit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery release tag target must be M')
  requireEqual(goCommit, PUBLICATION_RECOVERY_SOURCE_M, 'Publication recovery Go tag target must be M')
  return { releaseTag, goTag, commit: PUBLICATION_RECOVERY_SOURCE_M }
}

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
  releaseSetKeys(descriptor, ['kind', 'filename', 'name', 'version', 'sha256', 'files', 'profile'], 'Release-set artifact')
  if (!RELEASE_SET_ARTIFACT_KINDS.includes(descriptor.kind)) fail(`Unknown release-set artifact kind ${descriptor.kind}`)
  releaseSetVersion(expectedVersion, 'Release-set non-Rust version')
  requireEqual(descriptor.version, expectedVersion, `${descriptor.kind} release-set version mismatch`)
  requireEqual(descriptor.filename, releaseSetArtifactFilename(descriptor.kind, expectedVersion), `${descriptor.kind} release-set filename mismatch`)
  requireEqual(descriptor.name, releaseSetArtifactName(descriptor.kind), `${descriptor.kind} release-set identity mismatch`)
  requireArchiveSha(descriptor.sha256, `${descriptor.kind} release-set archive SHA-256`)
  const profile = descriptor.profile ?? RELEASE_SET_NON_RUST_PROFILE
  requireEqual(profile, RELEASE_SET_NON_RUST_PROFILE, `${descriptor.kind} release-set profile mismatch`)
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0) fail(`${descriptor.kind} release-set member list is empty`)
  const files = descriptor.files.map(member => safeRelativePath(member))
  if (new Set(files).size !== files.length) fail(`${descriptor.kind} release-set member list contains duplicates`)
  return { ...descriptor, files, profile }
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
    releaseSetKeys(rust.reuse, ['registry', 'downloadUrl', 'sourceCommit', 'sha256', 'sizeInBytes', 'yanked'], 'Rust reuse intent')
    requireEqual(rust.reuse.registry, 'crates.io', 'Rust reuse registry mismatch')
    requireEqual(rust.reuse.downloadUrl, `https://crates.io/api/v1/crates/${CRATE_NAME}/${rust.version}/download`, 'Rust reuse download URL mismatch')
    requireSha(rust.reuse.sourceCommit, 'Rust reuse source commit')
    requireArchiveSha(rust.reuse.sha256, 'Rust reuse checksum')
    requireEqual(rust.reuse.sha256, rust.sha256, 'Rust reuse checksum mismatch')
    requireEqual(rust.reuse.yanked, false, 'Rust reuse must prove an unyanked intent')
    if (rust.version === RUST_VERSION) {
      requireEqual(rust.reuse.sourceCommit, FOUNDATION_RUST_SOURCE, 'Historical Rust reuse source mismatch')
      requireEqual(rust.reuse.sha256, FOUNDATION_RUST_SHA256, 'Historical Rust reuse checksum mismatch')
    } else if (rust.version === CURRENT_RUST_VERSION) {
      requireEqual(rust.reuse.sourceCommit, RUST_011_REUSE_SOURCE, 'Rust 0.11 reuse source mismatch')
      requireEqual(rust.reuse.sha256, RUST_011_REUSE_SHA256, 'Rust 0.11 reuse checksum mismatch')
      requireEqual(rust.reuse.sizeInBytes, RUST_011_REUSE_SIZE, 'Rust 0.11 reuse archive size mismatch')
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
  for (const [value, label] of [[rust.prepared.runId, 'Rust preparation run ID'], [rust.prepared.runAttempt, 'Rust preparation attempt'], [rust.prepared.artifactId, 'Rust preparation artifact ID'], [rust.prepared.bindingArtifactId, 'Rust preparation binding artifact ID']]) requireFuturePositiveId(value, label)
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
  const goInventory = validateGoInventory(plan.go.inventory, true)
  const rust = releaseSetValidateRust(plan.rust, plan.sourceCommit)
  requireEqual(rust.version, plan.versions.rustVersion, 'Release-set Rust version mismatch')
  releaseSetKeys(plan.ciProof, ['workflowPath', 'sourceCommit', 'runId', 'runAttempt', 'jobId', 'requiredJob', 'event', 'headBranch', 'status', 'conclusion'], 'Release-set CI proof')
  requireEqual(plan.ciProof.workflowPath, RELEASE_SET_CI_WORKFLOW, 'Release-set CI proof workflow mismatch')
  requireEqual(plan.ciProof.sourceCommit, plan.sourceCommit, 'Release-set CI proof source mismatch')
  for (const [value, label] of [[plan.ciProof.runId, 'Release-set CI run ID'], [plan.ciProof.runAttempt, 'Release-set CI attempt'], [plan.ciProof.jobId, 'Release-set CI job ID']]) requireFuturePositiveId(value, label)
  requireEqual(plan.ciProof.requiredJob, FOUNDATION_CI_JOB, 'Release-set CI job mismatch')
  requireEqual(plan.ciProof.event, 'push', 'Release-set CI event mismatch')
  requireEqual(plan.ciProof.headBranch, 'main', 'Release-set CI branch mismatch')
  requireEqual(plan.ciProof.status, 'completed', 'Release-set CI status mismatch')
  requireEqual(plan.ciProof.conclusion, 'success', 'Release-set CI conclusion mismatch')
  releaseSetKeys(plan.tags, ['release', 'go', 'commit'], 'Release-set tags')
  requireEqual(plan.tags.release, `non-rust-v${plan.versions.nonRustVersion}`, 'Release-set release tag mismatch')
  requireEqual(plan.tags.go, `packages/go/v${plan.versions.nonRustVersion}`, 'Release-set Go tag mismatch')
  requireEqual(plan.tags.commit, plan.sourceCommit, 'Release-set tag source mismatch')
  releaseSetKeys(plan.githubRelease, ['title', 'tag', 'body', 'bodySha256', 'latest'], 'Release-set Release descriptor')
  requireEqual(plan.githubRelease.title, `SDK release set: non-Rust ${plan.versions.nonRustVersion} / Rust ${plan.versions.rustVersion}`, 'Release-set Release title mismatch')
  requireEqual(plan.githubRelease.tag, plan.tags.release, 'Release-set Release tag mismatch')
  releaseSetString(plan.githubRelease.body, 'Release-set Release body')
  requireEqual(plan.githubRelease.bodySha256, sha256Hex(plan.githubRelease.body), 'Release-set Release body hash mismatch')
  if (plan.githubRelease.latest !== undefined && typeof plan.githubRelease.latest !== 'boolean') fail('Release-set Latest designation must be boolean')
  releaseSetKeys(plan.licenseProfile, ['nonRust', 'rust'], 'Release-set license profile')
  requireEqual(plan.licenseProfile.nonRust, RELEASE_SET_NON_RUST_LICENSE_PROFILE, 'Release-set non-Rust license profile mismatch')
  releaseSetString(plan.licenseProfile.rust, 'Release-set Rust license profile')
  const expectedRustLicense = rust.mode === 'reuse' && rust.version === RUST_VERSION ? 'MIT' : RUST_011_LICENSE_PROFILE
  requireEqual(plan.licenseProfile.rust, expectedRustLicense, 'Release-set Rust license profile does not match the bound artifact')
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

/** Validate the live dispatch/checkout identity before any package command runs. */
export function validateReleaseSetRuntimeContext(context) {
  releaseSetKeys(context, ['repository', 'repositoryId', 'eventName', 'eventRef', 'eventSha', 'expectedCommit', 'checkoutHead', 'checkoutStatus', 'workflowRef', 'workflowSha'], 'Release-set execution context')
  requireEqual(context.repository, EXPECTED_REPOSITORY, 'Release-set execution repository mismatch')
  requireEqual(String(context.repositoryId), EXPECTED_REPOSITORY_ID, 'Release-set execution repository ID mismatch')
  requireEqual(context.eventName, 'workflow_dispatch', 'Release-set execution must be manually dispatched')
  requireEqual(context.eventRef, 'refs/heads/main', 'Release-set execution must run on main')
  requireSha(context.expectedCommit, 'Release-set expected commit')
  requireSha(context.eventSha, 'Release-set event commit')
  requireSha(context.checkoutHead, 'Release-set checkout HEAD')
  requireEqual(context.expectedCommit, context.eventSha, 'Release-set expected commit/event SHA mismatch')
  requireEqual(context.expectedCommit, context.checkoutHead, 'Release-set expected commit/checkout mismatch')
  requireEqual(context.checkoutStatus, '', 'Release-set checkout must be clean')
  requireEqual(context.workflowRef, `${EXPECTED_REPOSITORY}/${RELEASE_SET_WORKFLOW}@refs/heads/main`, 'Release-set workflow ref mismatch')
  requireSha(context.workflowSha, 'Release-set workflow SHA')
  requireEqual(context.workflowSha, context.expectedCommit, 'Release-set workflow SHA mismatch')
  return context
}

/** Validate only template identity; archive hashes/members are filled from measured bytes later. */
export function validateReleaseSetTemplateIdentity(template, context) {
  const normalizedContext = validateReleaseSetRuntimeContext(context)
  releaseSetObject(template, 'Release-set plan template')
  const requireOptionalEqual = (value, expected, label) => {
    if (value !== undefined) requireEqual(value, expected, label)
  }
  for (const [value, expected, label] of [
    [template.repository, EXPECTED_REPOSITORY, 'Release-set template repository'],
    [String(template.repositoryId), EXPECTED_REPOSITORY_ID, 'Release-set template repository ID'],
    [template.workflowPath, RELEASE_SET_WORKFLOW, 'Release-set template workflow path'],
    [template.ciWorkflowPath, RELEASE_SET_CI_WORKFLOW, 'Release-set template CI workflow path'],
  ]) requireEqual(value, expected, label)
  for (const [value, expected, label] of [
    [template.sourceCommit, normalizedContext.expectedCommit, 'Release-set template source'],
    [template.controlCommit, normalizedContext.expectedCommit, 'Release-set template control commit'],
    [template.workflowRevision, normalizedContext.expectedCommit, 'Release-set template workflow revision'],
    [template.checkoutHead, normalizedContext.expectedCommit, 'Release-set template checkout head'],
    [template.checkoutStatus, '', 'Release-set template checkout status'],
    [template.event?.name, 'workflow_dispatch', 'Release-set template event'],
    [template.event?.ref, 'refs/heads/main', 'Release-set template event ref'],
    [template.event?.sha, normalizedContext.expectedCommit, 'Release-set template event SHA'],
    [template.go?.sourceCommit, normalizedContext.expectedCommit, 'Release-set template Go source'],
    [template.tags?.commit, normalizedContext.expectedCommit, 'Release-set template tag source'],
    [template.ciProof?.sourceCommit, normalizedContext.expectedCommit, 'Release-set template CI source'],
  ]) requireOptionalEqual(value, expected, label)
  releaseSetVersion(template.versions?.nonRustVersion, 'Release-set template non-Rust version')
  releaseSetVersion(template.versions?.rustVersion, 'Release-set template Rust version')
  if (template.versions.nonRustVersion === FOUNDATION_VERSION) fail('Release-set template cannot target the historical foundation version')
  if (!Array.isArray(template.artifacts) || template.artifacts.length !== RELEASE_SET_ARTIFACT_KINDS.length) fail('Release-set template artifact set is incomplete')
  for (const artifact of template.artifacts) {
    releaseSetObject(artifact, 'Release-set template artifact')
    if (!RELEASE_SET_ARTIFACT_KINDS.includes(artifact.kind)) fail(`Unknown release-set template artifact kind ${artifact.kind}`)
    requireEqual(artifact.filename, releaseSetArtifactFilename(artifact.kind, template.versions.nonRustVersion), `${artifact.kind} release-set template filename mismatch`)
    requireEqual(artifact.name, releaseSetArtifactName(artifact.kind), `${artifact.kind} release-set template identity mismatch`)
    requireEqual(artifact.version, template.versions.nonRustVersion, `${artifact.kind} release-set template version mismatch`)
  }
  return template
}

/**
 * Classify the finite read-only registry preflight used before protected
 * publisher fanout. This operation only authenticates package identity and
 * prepared digests; the package observers still perform the full public-byte,
 * attestation, and consumer proof after any upload or reuse decision.
 */
export function classifyReleaseSetPreflight({ plan, responses }) {
  const normalized = validateReleaseSetPlan(plan)
  releaseSetKeys(responses, ['npm', 'pypi', 'rubygems'], 'Release-set preflight responses')
  const version = normalized.versions.nonRustVersion
  const artifacts = Object.fromEntries(normalized.artifacts.map(artifact => [artifact.kind, artifact]))
  const parseResponse = (name, response) => {
    releaseSetKeys(response, ['status', 'body', 'absenceGate', 'fullStatus', 'fullBody', 'fullRecheckStatus', 'fullRecheckBody'], `Release-set ${name} preflight response`)
    const status = Number(response.status)
    if (!Number.isInteger(status) || status < 100 || status > 599) return { state: 'malformed', status: response.status }
    if (status === 404 && response.absenceGate !== true) return { state: 'unknown', status, reason: 'absence-gate-missing' }
    let payload
    if (status === 200) {
      try { payload = JSON.parse(response.body) } catch { return { state: 'malformed', status } }
    }
    return { status, payload, absenceGate: response.absenceGate }
  }

  const npmResponse = parseResponse('npm', responses.npm)
  const npmFullResponse = parseResponse('npm-full', { status: responses.npm.fullStatus, body: responses.npm.fullBody, absenceGate: responses.npm.absenceGate })
  const npmFullRecheckResponse = parseResponse('npm-full-recheck', { status: responses.npm.fullRecheckStatus, body: responses.npm.fullRecheckBody, absenceGate: responses.npm.absenceGate })
  const npmFullPackument = npmFullResponse.payload
  const npmFullRecheckPackument = npmFullRecheckResponse.payload
  const npmFullTarget = npmFullPackument?.versions?.[version]
  const npmFullRecheckTarget = npmFullRecheckPackument?.versions?.[version]
  const npmFullPayload = npmFullTarget === undefined
    ? undefined
    : { ...npmFullTarget, name: npmFullPackument.name ?? npmFullTarget.name }
  const npmIntegrity = value => {
    if (typeof value !== 'string' || !value.startsWith('sha512-')) return false
    const encoded = value.slice('sha512-'.length)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
    try { return Buffer.from(encoded, 'base64').length === 64 && Buffer.from(encoded, 'base64').toString('base64') === encoded } catch { return false }
  }
  const npmComparable = payload => ({ name: payload?.name, version: payload?.version, tarball: payload?.dist?.tarball, integrity: payload?.dist?.integrity })
  let npm
  if (npmResponse.state !== undefined && npmResponse.state !== 'unknown' && npmResponse.state !== 'malformed') npm = { state: npmResponse.state, status: npmResponse.status, reason: npmResponse.reason }
  else if (npmResponse.status === 404) {
    const fullIsCanonical = npmFullResponse.status === 200 && npmFullPackument?.name === '@elsoul/erpc-sdk' && npmFullPackument?.versions !== null && typeof npmFullPackument?.versions === 'object' && !Array.isArray(npmFullPackument.versions)
    if (npmFullResponse.status === 404 && npmResponse.absenceGate === true) npm = { state: 'absent', status: npmResponse.status }
    else if (fullIsCanonical && npmFullRecheckResponse.status === 200 && npmFullRecheckPackument?.name === '@elsoul/erpc-sdk' && npmFullRecheckPackument?.versions !== null && typeof npmFullRecheckPackument?.versions === 'object' && !Array.isArray(npmFullRecheckPackument.versions) && npmResponse.absenceGate === true && npmFullTarget === undefined && npmFullRecheckTarget === undefined) npm = { state: 'absent', status: npmResponse.status, scope: 'target-version', fullBodySha256: sha256Hex(responses.npm.fullBody), fullRecheckBodySha256: sha256Hex(responses.npm.fullRecheckBody) }
    else npm = { state: 'conflict', status: npmResponse.status, reason: 'npm exact/full absence is inconsistent' }
  }
  else if (npmResponse.status !== 200) npm = { state: 'unknown', status: npmResponse.status }
  else if (npmFullResponse.status !== 200 || npmFullRecheckResponse.status !== 200 || npmResponse.payload?.name !== '@elsoul/erpc-sdk' || npmResponse.payload.version !== version || npmResponse.payload.dist?.tarball !== npmTarballUrl(version) || !npmIntegrity(npmResponse.payload.dist?.integrity) || npmFullPackument?.name !== '@elsoul/erpc-sdk' || npmFullPackument?.versions === null || typeof npmFullPackument?.versions !== 'object' || Array.isArray(npmFullPackument.versions) || npmFullRecheckPackument?.name !== '@elsoul/erpc-sdk' || npmFullRecheckPackument?.versions === null || typeof npmFullRecheckPackument.versions !== 'object' || Array.isArray(npmFullRecheckPackument.versions) || npmFullPayload?.name !== '@elsoul/erpc-sdk' || npmFullPayload.version !== version || npmFullPayload.dist?.tarball !== npmTarballUrl(version) || !npmIntegrity(npmFullPayload.dist?.integrity) || npmFullRecheckTarget === undefined || npmFullRecheckTarget.name !== '@elsoul/erpc-sdk' || npmFullRecheckTarget.version !== version || npmFullRecheckTarget.dist?.tarball !== npmTarballUrl(version) || !npmIntegrity(npmFullRecheckTarget.dist?.integrity) || canonicalJson(npmComparable(npmResponse.payload)) !== canonicalJson(npmComparable(npmFullPayload)) || canonicalJson(npmComparable(npmFullPayload)) !== canonicalJson(npmComparable({ ...npmFullRecheckTarget, name: npmFullRecheckPackument.name ?? npmFullRecheckTarget.name }))) npm = { state: 'conflict', status: npmResponse.status, reason: 'npm exact/full metadata mismatch' }
  else npm = { state: 'match', status: npmResponse.status, bodySha256: sha256Hex(responses.npm.body), fullBodySha256: sha256Hex(responses.npm.fullBody), tarball: npmResponse.payload.dist.tarball, integrity: npmResponse.payload.dist.integrity }

  const pypiResponse = parseResponse('pypi', responses.pypi)
  const expectedPyPI = new Map(['pypi-wheel', 'pypi-sdist'].map(kind => [artifacts[kind].filename, artifacts[kind]]))
  let pypi
  if (pypiResponse.status === 404) pypi = pypiResponse.absenceGate === true ? { state: 'absent', status: pypiResponse.status, files: [] } : { state: 'unknown', status: pypiResponse.status, reason: 'absence-gate-missing' }
  else if (pypiResponse.status !== 200) pypi = { state: 'unknown', status: pypiResponse.status }
  else if (pypiResponse.payload?.info?.name !== 'erpc-sdk' || pypiResponse.payload.info.version !== version || !Array.isArray(pypiResponse.payload.urls)) pypi = { state: 'conflict', status: pypiResponse.status }
  else {
    const seen = new Set()
    const files = []
    let invalid = false
    for (const file of pypiResponse.payload.urls) {
      const descriptor = expectedPyPI.get(file?.filename)
      if (descriptor === undefined || seen.has(file.filename)) { invalid = true; continue }
      seen.add(file.filename)
      const expectedType = descriptor.kind === 'pypi-wheel' ? 'bdist_wheel' : 'sdist'
      if (file.yanked !== false || file.packagetype !== expectedType || pypiCanonicalFileUrl(file.url) === null || file.digests?.sha256 !== descriptor.sha256) invalid = true
      files.push({ filename: file.filename, kind: descriptor.kind, sha256: file.digests?.sha256, url: file.url, packagetype: file.packagetype, yanked: file.yanked })
    }
    if (invalid) pypi = { state: 'conflict', status: pypiResponse.status, files }
    else if (files.length === 0) pypi = { state: 'incomplete', status: pypiResponse.status, files }
    else pypi = { state: files.length === expectedPyPI.size ? 'match' : 'partial', status: pypiResponse.status, files: files.sort((left, right) => left.filename.localeCompare(right.filename)) }
  }

  const rubyResponse = parseResponse('rubygems', responses.rubygems)
  const rubyArtifact = artifacts.rubygems
  let rubygems
  if (rubyResponse.status === 404) rubygems = rubyResponse.absenceGate === true ? { state: 'absent', status: rubyResponse.status } : { state: 'unknown', status: rubyResponse.status, reason: 'absence-gate-missing' }
  else if (rubyResponse.status !== 200) rubygems = { state: 'unknown', status: rubyResponse.status }
  else if (rubyResponse.payload?.name !== 'erpc-sdk' || rubyResponse.payload.version !== version || rubyResponse.payload.platform !== 'ruby' || rubyResponse.payload.sha !== rubyArtifact.sha256 || (rubyResponse.payload.yanked !== undefined && rubyResponse.payload.yanked !== false)) rubygems = { state: 'conflict', status: rubyResponse.status }
  else rubygems = { state: 'match', status: rubyResponse.status, sha256: rubyResponse.payload.sha }

  const result = { schemaVersion: 1, kind: 'erpc-sdk-release-set-preflight', sourceCommit: normalized.sourceCommit, planSha256: releaseSetPlanDigest(normalized), registries: { npm, pypi, rubygems }, observedAt: new Date().toISOString() }
  const invalidStates = Object.entries(result.registries).filter(([, state]) => !['absent', 'match', 'partial'].includes(state.state))
  if (invalidStates.length > 0) fail(`Release-set preflight stopped in ${invalidStates.map(([registry, state]) => `${registry}:${state.state}${state.reason ? `:${state.reason}` : ''}`).join(',')}`)
  return result
}

/** Reuse the accepted CI selection/proof helpers and convert their evidence to schema2 fields. */
export function validateReleaseSetCIEvidence(evidence, expectedSourceCommit) {
  requireSha(expectedSourceCommit, 'Release-set CI expected source')
  releaseSetKeys(evidence, ['workflow', 'runs', 'selection', 'recheck', 'jobs'], 'Release-set CI evidence')
  const validated = validateFoundationCIProof({
    workflow: evidence.workflow,
    runs: evidence.runs,
    selection: evidence.selection,
    recheck: evidence.recheck,
    jobs: evidence.jobs,
    expected: { sourceCommit: expectedSourceCommit },
  })
  return {
    workflowPath: RELEASE_SET_CI_WORKFLOW,
    sourceCommit: expectedSourceCommit,
    runId: String(validated.id),
    runAttempt: String(validated.runAttempt),
    jobId: String(validated.requiredJobId),
    requiredJob: validated.requiredJobName,
    event: validated.event,
    headBranch: validated.headBranch,
    status: validated.requiredJobStatus,
    conclusion: validated.requiredJobConclusion,
  }
}

/** Build a schema2 plan and all fixed sidecars from measured archive/Go bytes. */
export async function prepareReleaseSetBundle({ template, artifactDirectory, goRoot, planFile, context, ciEvidence, reviewedPlanSha256 }) {
  if (context !== undefined) validateReleaseSetTemplateIdentity(template, context)
  if (context !== undefined && ciEvidence === undefined) fail('Release-set preparation requires actual CI evidence')
  const input = structuredClone(template)
  const runtimeSource = context?.expectedCommit ?? input.sourceCommit
  const runtimeCiProof = ciEvidence === undefined ? input.ciProof : validateReleaseSetCIEvidence(ciEvidence, runtimeSource)
  if (context !== undefined) {
    input.sourceCommit = runtimeSource
    input.controlCommit = runtimeSource
    input.workflowRevision = runtimeSource
    input.event = { name: context.eventName, ref: context.eventRef, sha: context.eventSha }
    input.checkoutHead = context.checkoutHead
    input.checkoutStatus = context.checkoutStatus
    input.ciProof = runtimeCiProof
    input.go = { ...input.go, sourceCommit: runtimeSource }
    input.tags = { ...input.tags, commit: runtimeSource }
  }
  const version = input.versions?.nonRustVersion
  releaseSetVersion(version, 'Release-set non-Rust version')
  const artifacts = []
  for (const kind of RELEASE_SET_ARTIFACT_KINDS) {
    const templateArtifact = input.artifacts?.find(item => item.kind === kind)
    if (templateArtifact === undefined) fail(`Release-set template is missing ${kind}`)
    const filename = releaseSetArtifactFilename(kind, version)
    const filePath = join(artifactDirectory, filename)
    const descriptor = { ...templateArtifact, kind, filename, name: releaseSetArtifactName(kind), version, profile: RELEASE_SET_NON_RUST_PROFILE, sha256: await sha256File(filePath), files: await releaseSetReadMetadata(filePath, kind, version, releaseSetArtifactName(kind)) }
    const inspected = await inspectReleaseSetArtifactBytes(descriptor, filePath, runtimeSource)
    artifacts.push({ ...descriptor, files: inspected.members })
  }
  const goInventory = await buildGoInventory(goRoot, { profile: 'future' })
  const plan = buildReleaseSetPlan({ ...input, artifacts, go: { ...input.go, inventory: goInventory } })
  if (context !== undefined) validateReleaseSetContext(context, plan)
  const planSha256 = releaseSetPlanDigest(plan)
  if (reviewedPlanSha256 !== undefined) {
    requireArchiveSha(reviewedPlanSha256, 'Release-set reviewed plan digest')
    requireEqual(reviewedPlanSha256, planSha256, 'Release-set reviewed plan digest mismatch')
  }
  await writeFile(join(artifactDirectory, 'release-set-plan.json'), `${canonicalJson(plan)}\n`)
  await writeFile(join(artifactDirectory, 'release-set-plan.sha256'), `${releaseSetPlanDigest(plan)}\n`)
  await writeFile(join(artifactDirectory, 'release-body.md'), plan.githubRelease.body)
  await writeFile(join(artifactDirectory, 'go-inventory.json'), `${canonicalJson(plan.go.inventory)}\n`)
  const checksumFiles = releaseSetExpectedBundleFiles(plan).filter(file => file !== 'checksums.txt')
  const checksums = []
  for (const filename of checksumFiles) checksums.push(`${await sha256File(join(artifactDirectory, filename))}  ./${filename}`)
  await writeFile(join(artifactDirectory, 'checksums.txt'), `${checksums.join('\n')}\n`)
  await writeFile(planFile, `${canonicalJson(plan)}\n`)
  return plan
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
  releaseSetKeys(binding, ['schemaVersion', 'kind', 'repository', 'repositoryId', 'workflowPath', 'sourceCommit', 'versions', 'runId', 'runAttempt', 'artifactId', 'planSha256'], 'Release-set preparation binding')
  requireEqual(binding.schemaVersion, RELEASE_SET_SCHEMA_VERSION, 'Release-set binding schema mismatch')
  requireEqual(binding.kind, RELEASE_SET_BINDING_KIND, 'Release-set binding kind mismatch')
  requireEqual(binding.repository, EXPECTED_REPOSITORY, 'Release-set binding repository mismatch')
  requireEqual(String(binding.repositoryId), EXPECTED_REPOSITORY_ID, 'Release-set binding repository ID mismatch')
  requireEqual(binding.workflowPath, RELEASE_SET_WORKFLOW, 'Release-set binding workflow mismatch')
  requireEqual(binding.sourceCommit, normalized.sourceCommit, 'Release-set binding source mismatch')
  releaseSetKeys(binding.versions, ['nonRustVersion', 'rustVersion'], 'Release-set binding versions')
  requireEqual(binding.versions.nonRustVersion, normalized.versions.nonRustVersion, 'Release-set binding non-Rust version mismatch')
  requireEqual(binding.versions.rustVersion, normalized.versions.rustVersion, 'Release-set binding Rust version mismatch')
  for (const [value, label] of [[binding.runId, 'Release-set binding run ID'], [binding.runAttempt, 'Release-set binding attempt'], [binding.artifactId, 'Release-set binding artifact ID']]) requireFuturePositiveId(value, label)
  requireArchiveSha(binding.planSha256, 'Release-set binding plan hash')
  requireEqual(binding.planSha256, releaseSetPlanDigest(normalized), 'Release-set binding plan hash mismatch')
  for (const key of ['runId', 'runAttempt', 'artifactId']) if (expected[key] !== undefined) requireEqual(String(binding[key]), String(expected[key]), `Release-set binding ${key} mismatch`)
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

const releaseSetLicenseMember = (members, suffix, label) => {
  const matches = members.filter(member => member === suffix || member.endsWith(`/${suffix}`))
  if (matches.length !== 1) fail(`${label} is missing or ambiguous`)
  return matches[0]
}

const releaseSetLicenseText = async (filePath, kind, member, execution = {}) => {
  if (kind === 'pypi-wheel') return Buffer.from(await commandBuffer('unzip', ['-p', filePath, member], execution)).toString('utf8')
  if (kind === 'rubygems') {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'erpc-sdk-release-set-profile-'))
    try {
      const dataPath = join(temporaryDirectory, 'data.tar.gz')
      await writeFile(dataPath, await commandBuffer('tar', ['-xOf', filePath, 'data.tar.gz'], execution))
      return Buffer.from(await commandBuffer('tar', ['-xOf', dataPath, member], execution)).toString('utf8')
    } finally { await rm(temporaryDirectory, { recursive: true, force: true }) }
  }
  return Buffer.from(await commandBuffer('tar', ['-xOf', filePath, member], execution)).toString('utf8')
}

const releaseSetProfileMembers = ({ kind, members, metadata, label }) => {
  if (kind === 'npm') {
    const expected = new Map([
      ['license', 'package/LICENSE'],
      ['apache', 'package/LICENSES/Apache-2.0.txt'],
      ['bsd', 'package/LICENSES/BSD-3-Clause-Google-Protobuf.txt'],
      ['notice', 'package/THIRD_PARTY_NOTICES.md'],
    ])
    for (const [key, member] of expected) if (!members.includes(member)) fail(`${label} is missing ${member}`)
    return Object.fromEntries(expected)
  }
  if (kind === 'rubygems') {
    const expected = new Map([
      ['license', 'LICENSE'],
      ['apache', 'LICENSES/Apache-2.0.txt'],
      ['bsd', 'LICENSES/BSD-3-Clause-Google-Protobuf.txt'],
      ['notice', 'THIRD_PARTY_NOTICES.md'],
    ])
    for (const [key, member] of expected) if (!members.includes(member)) fail(`${label} is missing ${member}`)
    return Object.fromEntries(expected)
  }
  if (!Array.isArray(metadata?.licenseFiles) || metadata.licenseFiles.length !== RELEASE_SET_NON_RUST_LICENSE_FILES.length || new Set(metadata.licenseFiles).size !== metadata.licenseFiles.length || canonicalJson([...metadata.licenseFiles].sort()) !== canonicalJson([...RELEASE_SET_NON_RUST_LICENSE_FILES].sort())) fail(`${label} Python License-File entries are not the exact approved set`)
  const metadataMember = metadata.metadataMember
  const prefix = metadataMember?.replace(/\/(?:METADATA|PKG-INFO)$/, '')
  if (!prefix) fail(`${label} Python metadata member root is missing`)
  const resolved = {}
  for (const value of RELEASE_SET_NON_RUST_LICENSE_FILES) {
    const basename = value.slice(value.lastIndexOf('/') + 1)
    const candidates = kind === 'pypi-wheel'
      ? [`${prefix}/${value}`, `${prefix}/licenses/${value}`, `${prefix}/licenses/${basename}`]
      : [`${prefix}/${value}`]
    const matches = [...new Set(candidates.filter(candidate => members.includes(candidate)))]
    if (matches.length !== 1) fail(`${label} Python License-File ${value} does not map to exactly one archive member`)
    resolved[value === 'LICENSE' ? 'license' : value.startsWith('LICENSES/Apache') ? 'apache' : value.startsWith('LICENSES/BSD') ? 'bsd' : 'notice'] = matches[0]
  }
  return resolved
}

const releaseSetProfileSourceHashes = async kind => {
  const source = RELEASE_SET_PROFILE_SOURCE_FILES[kind === 'pypi-wheel' || kind === 'pypi-sdist' ? 'pypi' : kind]
  if (!source) fail(`No source-bound release-set profile exists for ${kind}`)
  const hashes = {}
  for (const [key, relative] of Object.entries(source)) hashes[key] = await sha256File(join(REPOSITORY_ROOT, relative))
  return hashes
}

const validateReleaseSetMixedLicenseProfile = async ({ filePath, kind, version, members, metadata, expectedSourceCommit, execution = {} }) => {
  requireSha(expectedSourceCommit, `${kind} profile source commit`)
  if (execution.profileMode === 'legacy') return undefined
  const label = `${kind} mixed-license profile`
  if (kind === 'npm' && metadata?.license !== RELEASE_SET_NON_RUST_LICENSE_PROFILE) fail(`${label} package expression mismatch`)
  if (kind === 'rubygems' && canonicalJson(metadata?.licenses) !== canonicalJson(['MIT', 'Apache-2.0', 'BSD-3-Clause'])) fail(`${label} gem license array mismatch`)
  const profileMembers = releaseSetProfileMembers({ kind, members, metadata, label })
  const sourceHashes = await releaseSetProfileSourceHashes(kind)
  const license = await releaseSetLicenseText(filePath, kind, profileMembers.license, execution)
  const apache = await releaseSetLicenseText(filePath, kind, profileMembers.apache, execution)
  const bsd = await releaseSetLicenseText(filePath, kind, profileMembers.bsd, execution)
  const notice = await releaseSetLicenseText(filePath, kind, profileMembers.notice, execution)
  requireEqual(sha256Hex(license), sourceHashes.license, `${label} original MIT text hash mismatch`)
  requireEqual(sha256Hex(apache), sourceHashes.apache, `${label} Apache text hash mismatch`)
  requireEqual(sha256Hex(bsd), sourceHashes.bsd, `${label} Google BSD text hash mismatch`)
  requireEqual(sha256Hex(notice), sourceHashes.notice, `${label} full provenance notice hash mismatch`)
  if (kind === 'pypi-wheel' || kind === 'pypi-sdist') {
    if (metadata === undefined || metadata.version !== '2.4' || metadata.licenseExpression !== RELEASE_SET_NON_RUST_LICENSE_PROFILE) fail(`${label} Python metadata license evidence is incomplete`)
  }
  return { sourceCommit: expectedSourceCommit, license: sourceHashes.license, apache: sourceHashes.apache, bsd: sourceHashes.bsd, notice: sourceHashes.notice, members: profileMembers }
}

const releaseSetInspectRustArchive = async (filePath, version, expectedCommit, execution = {}) => {
  const members = await archiveEntries(filePath, 'tar', execution)
  const root = `${CRATE_NAME}-${version}`
  const roots = new Set(members.map(member => member.split('/')[0]))
  if (roots.size !== 1 || !roots.has(root)) fail(`Rust archive must contain exactly one ${root} root`)
  const required = [`${root}/Cargo.toml`, `${root}/LICENSE`, `${root}/README.md`, `${root}/.cargo_vcs_info.json`]
  for (const member of required) if (!members.includes(member)) fail(`Rust archive is missing ${member}`)
  const manifest = await archiveText(filePath, `${root}/Cargo.toml`, false, execution)
  const packageSections = manifest.match(/^\[package\]\s*$/gm) ?? []
  if (packageSections.length !== 1) fail('Rust archive Cargo.toml must contain exactly one [package] table')
  const packageBody = manifest.split(/^\[package\]\s*$/m)[1]?.split(/^\[[^\]]+\]\s*$/m)[0] ?? ''
  if (packageBody.match(/^name\s*=\s*"([^"]+)"$/m)?.[1] !== CRATE_NAME || packageBody.match(/^version\s*=\s*"([^"]+)"$/m)?.[1] !== version) fail('Rust archive [package] identity/version mismatch')
  let vcs
  try { vcs = JSON.parse(await archiveText(filePath, `${root}/.cargo_vcs_info.json`, false, execution)) } catch { fail('Rust archive VCS metadata is malformed') }
  if ((vcs.git?.sha1 ?? vcs.git?.commit) !== expectedCommit || (vcs.git?.dirty !== undefined && vcs.git.dirty !== false) || vcs.path_in_vcs !== 'packages/rust') fail('Rust archive VCS provenance mismatch')
  return members
}

export async function inspectReleaseSetRustArchiveBytes({ filePath, version, sourceCommit, execution = {} }) {
  return releaseSetInspectRustArchive(filePath, version, sourceCommit, execution)
}

export async function inspectReleaseSetRubyGemBytes({ filePath, name, version, execution = {} }) {
  return releaseSetReadMetadata(filePath, 'rubygems', version, name, execution)
}

/** Read and validate genuine prepared archive bytes; plaintext files fail closed. */
export async function inspectReleaseSetArtifactBytes(descriptor, filePath, expectedSourceCommit, execution = {}) {
  if (await sha256File(filePath) !== descriptor.sha256) fail(`Prepared artifact bytes do not match ${descriptor.filename}`)
  const members = await releaseSetReadMetadata(filePath, descriptor.kind, descriptor.version, descriptor.name, execution)
  let profileMetadata
  if (descriptor.kind === 'npm') profileMetadata = { ...JSON.parse(await archiveText(filePath, 'package/package.json', false, execution)), profile: descriptor.profile }
  if (descriptor.kind === 'pypi-wheel' || descriptor.kind === 'pypi-sdist') {
    const metadataMember = members.find(member => descriptor.kind === 'pypi-wheel' ? /\.dist-info\/METADATA$/.test(member) : /(?:^|\/)PKG-INFO$/.test(member))
    const text = await releaseSetLicenseText(filePath, descriptor.kind, metadataMember, execution)
    profileMetadata = { profile: descriptor.profile, metadataMember, version: metadataValue(text, 'Metadata-Version'), licenseExpression: metadataValue(text, 'License-Expression'), licenseFiles: [...text.matchAll(/^License-File:\s*(.+)$/gm)].map(match => match[1].trim()) }
  }
  if (descriptor.kind === 'rubygems') profileMetadata = { ...JSON.parse(await commandText('ruby', ['-rrubygems/package', '-rjson', '-e', 'spec = Gem::Package.new(ARGV.fetch(0)).spec; puts JSON.generate({"licenses" => spec.licenses})', filePath], execution)), profile: descriptor.profile }
  await validateReleaseSetMixedLicenseProfile({ filePath, kind: descriptor.kind, version: descriptor.version, members, metadata: profileMetadata, expectedSourceCommit, execution })
  releaseSetMemberSet(members, descriptor.files, descriptor.kind)
  return { filename: descriptor.filename, sha256: descriptor.sha256, members, sourceCommit: expectedSourceCommit }
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
  const id = requireFuturePositiveId(expectedId, 'Release-set ZIP artifact ID')
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

const npmInvalidateOutput = async (path, workPath, label, expectedKind = 'npm-public-observation') => {
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
    if (priorReceipt?.schemaVersion !== 1 || priorReceipt?.kind !== expectedKind || !['observed', 'partial'].includes(priorReceipt?.state)) fail(`${label} is not a prior ${expectedKind} receipt`)
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

const pypiChildEnvironment = ({ workDir, emptyPipConfig }) => ({
  PATH: process.env.PATH ?? '',
  TMPDIR: workDir,
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PIP_CONFIG_FILE: '/dev/null',
  PIP_INDEX_URL: 'https://pypi.org/simple',
  PIP_EXTRA_INDEX_URL: '',
  PIP_CACHE_DIR: join(workDir, 'pip-cache'),
  PIP_NO_INPUT: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  PYTHONNOUSERSITE: '1',
  PYTHONPATH: '',
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
  releaseSetKeys(input, ['descriptor', 'planSha256', 'preparation', 'publisher', 'observer', 'workDir', 'outputFile', 'toolPaths', 'recoveryContext'], 'npm observer input')
  releaseSetKeys(input.descriptor, ['kind', 'filename', 'name', 'version', 'sha256', 'files', 'profile'], 'npm observer descriptor')
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
  for (const [value, label] of [[input.preparation.runId, 'npm observer preparation run ID'], [input.preparation.runAttempt, 'npm observer preparation attempt'], [input.preparation.artifactId, 'npm observer preparation artifact ID'], [input.preparation.bindingArtifactId, 'npm observer preparation binding artifact ID']]) requireFuturePositiveId(value, label)
  releaseSetKeys(input.publisher, ['repository', 'repositoryId', 'sourceCommit', 'workflowPath', 'ref', 'event', 'environment', 'publisherRunId', 'publisherAttempt'], 'npm observer publisher')
  requireEqual(input.publisher.repository, EXPECTED_REPOSITORY, 'npm observer publisher repository mismatch')
  requireEqual(String(input.publisher.repositoryId), EXPECTED_REPOSITORY_ID, 'npm observer publisher repository ID mismatch')
  requireEqual(input.publisher.sourceCommit, input.preparation.sourceCommit, 'npm observer publisher source mismatch')
  requireEqual(input.publisher.workflowPath, RELEASE_SET_WORKFLOW, 'npm observer publisher workflow mismatch')
  requireEqual(input.publisher.ref, 'refs/heads/main', 'npm observer publisher ref mismatch')
  requireEqual(input.publisher.event, 'workflow_dispatch', 'npm observer publisher event mismatch')
  requireEqual(input.publisher.environment, 'npm', 'npm observer publisher environment mismatch')
  requireFuturePositiveId(input.publisher.publisherRunId, 'npm observer publisher run ID')
  requireFuturePositiveId(input.publisher.publisherAttempt, 'npm observer publisher attempt')
  releaseSetKeys(input.observer, ['runId', 'runAttempt', 'workflowPath', 'sourceCommit'], 'npm observer context')
  requireFuturePositiveId(input.observer.runId, 'npm observer run ID')
  requireFuturePositiveId(input.observer.runAttempt, 'npm observer attempt')
  requireEqual(input.observer.workflowPath, RELEASE_SET_WORKFLOW, 'npm observer workflow mismatch')
  requireSha(input.observer.sourceCommit, 'npm observer source')
  if (input.recoveryContext !== undefined) {
    validatePublicationRecoveryContext(input.recoveryContext)
    requireEqual(input.recoveryContext.sourceM, input.preparation.sourceCommit, 'npm observer recovery source/preparation mismatch')
    requireEqual(input.observer.sourceCommit, input.recoveryContext.controlCommit, 'npm observer recovery observer source mismatch')
  }
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
    profileMode: input.descriptor.profile === 'legacy' ? 'legacy' : 'future',
  })

  const auditDirectory = await mkdtemp(join(workDir, 'audit-consumer-'))
  const smokeDirectory = await mkdtemp(join(workDir, 'smoke-consumer-'))
  const nodeVersion = await npmInvoke(run, input.toolPaths.node, ['--version'], { cwd: workDir, env: isolatedEnv }, 'node-version', deadlineControl)
  const npmVersion = await npmInvoke(run, input.toolPaths.node, [input.toolPaths.npmCli, '--version'], { cwd: workDir, env: isolatedEnv }, 'npm-version', deadlineControl)
  if (!/^v24\./.test(String(nodeVersion.stdout).trim()) || String(npmVersion.stdout).trim() !== '11.19.1') fail('npm-observe-tool-version-mismatch')
  const pythonVersion = await npmInvoke(run, input.toolPaths.python, ['-c', 'import sys, cryptography; print(sys.version.split()[0]); print(cryptography.__version__)'], { cwd: workDir, env: isolatedEnv }, 'python-version', deadlineControl)
  if (!/^3\.12\./m.test(pythonVersion.stdout) || !/^50\.0\.2$/m.test(pythonVersion.stdout)) fail('npm-observe-python-tool-version-mismatch')
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
    auth: { requested: false, uploadAttempted: false }, ...(input.recoveryContext === undefined ? {} : { recoveryContextSha256: input.recoveryContext.contextSha256 }), observedAt: new Date().toISOString(),
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

const pypiMetadataUrl = version => `https://pypi.org/pypi/erpc-sdk/${version}/json`
const pypiProvenanceUrl = (version, filename) => `https://pypi.org/integrity/erpc-sdk/${version}/${filename}/provenance`
const pypiExpectedKinds = Object.freeze(['pypi-wheel', 'pypi-sdist'])
const pypiCanonicalFileUrl = value => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'files.pythonhosted.org' || url.username || url.password || url.port || url.search || url.hash) return null
    return url.href
  } catch { return null }
}

const pypiClaimsPython = String.raw`
import json, sys
from cryptography import x509
from pypi_attestations import Distribution, GitHubPublisher, Provenance
document = Provenance.model_validate_json(open(sys.argv[1], encoding='utf-8').read())
filename, digest = sys.argv[2:]
verified = []
for bundle in document.attestation_bundles:
    for attestation in bundle.attestations:
        statement = json.loads(attestation.envelope.statement.decode('utf-8'))
        subjects = [subject for subject in statement.get('subject', []) if subject.get('name') == filename and subject.get('digest', {}).get('sha256') == digest]
        if statement.get('predicateType') != 'https://docs.pypi.org/attestations/publish/v1' or len(subjects) != 1:
            continue
        publisher = bundle.publisher
        try:
            attestation.verify(GitHubPublisher(repository='elsoul/erpc-sdk', workflow='release.yml', environment='pypi'), Distribution(name=filename, digest=digest))
        except Exception:
            continue
        claims = {}
        cert = x509.load_der_x509_certificate(attestation.verification_material.certificate)
        for extension in cert.extensions:
            oid = extension.oid.dotted_string
            if not oid.startswith('1.3.6.1.4.1.57264.'): continue
            value = getattr(extension.value, 'value', b'')
            if value[:1] == b'\x0c':
                length = value[1]; offset = 2
                if length & 0x80:
                    count = length & 0x7f; length = int.from_bytes(value[offset:offset + count], 'big'); offset += count
                value = value[offset:offset + length]
            try: claims[oid] = value.decode('utf-8')
            except UnicodeDecodeError: pass
        verified.append({'claims': claims, 'subject': subjects[0], 'publisher': publisher.model_dump()})
if len(verified) != 1:
    raise SystemExit('expected exactly one verified publish attestation')
print(json.dumps(verified[0], sort_keys=True))
`

const pypiStrictInput = input => {
  releaseSetKeys(input, ['descriptors', 'planSha256', 'preparation', 'publishers', 'observer', 'workDir', 'outputFile', 'toolPaths', 'recoveryContext', 'publisherSources'], 'PyPI observer input')
  releaseSetKeys(input.descriptors, ['pypi-wheel', 'pypi-sdist'], 'PyPI observer descriptors')
  for (const kind of pypiExpectedKinds) {
    const descriptor = input.descriptors[kind]
    releaseSetKeys(descriptor, ['kind', 'filename', 'name', 'version', 'sha256', 'files', 'profile'], `PyPI observer ${kind} descriptor`)
    requireEqual(descriptor.kind, kind, `PyPI observer ${kind} kind mismatch`)
    requireEqual(descriptor.name, 'erpc-sdk', `PyPI observer ${kind} name mismatch`)
    releaseSetVersion(descriptor.version, `PyPI observer ${kind} version`)
    requireEqual(descriptor.filename, releaseSetArtifactFilename(kind, descriptor.version), `PyPI observer ${kind} filename mismatch`)
    requireArchiveSha(descriptor.sha256, `PyPI observer ${kind} SHA-256`)
  }
  requireEqual(input.descriptors['pypi-wheel'].version, input.descriptors['pypi-sdist'].version, 'PyPI observer versions differ')
  requireArchiveSha(input.planSha256, 'PyPI observer plan SHA-256')
  releaseSetKeys(input.preparation, ['sourceCommit', 'runId', 'runAttempt', 'artifactId', 'bindingArtifactId', 'planSha256'], 'PyPI observer preparation')
  requireSha(input.preparation.sourceCommit, 'PyPI observer preparation source')
  requireArchiveSha(input.preparation.planSha256, 'PyPI observer preparation plan SHA-256')
  requireEqual(input.preparation.planSha256, input.planSha256, 'PyPI observer preparation plan mismatch')
  for (const [value, label] of [[input.preparation.runId, 'PyPI observer preparation run ID'], [input.preparation.runAttempt, 'PyPI observer preparation attempt'], [input.preparation.artifactId, 'PyPI observer preparation artifact ID'], [input.preparation.bindingArtifactId, 'PyPI observer preparation binding artifact ID']]) requireFuturePositiveId(value, label)
  const publisherKeys = pypiExpectedKinds.map(kind => input.descriptors[kind].filename)
  releaseSetObject(input.publishers, 'PyPI observer publishers')
  const recoveryControlSource = input.recoveryContext === undefined ? undefined : validatePublicationRecoveryContext(input.recoveryContext).controlCommit
  if (input.publisherSources !== undefined) releaseSetObject(input.publisherSources, 'PyPI observer publisher source map')
  if (input.publisherSources !== undefined && Object.keys(input.publisherSources).some(filename => !publisherKeys.includes(filename))) fail('PyPI observer publisher source map contains an unknown file')
  const publisherSource = input.recoveryContext === undefined ? input.preparation.sourceCommit : recoveryControlSource
  if (input.recoveryContext !== undefined) requireEqual(input.recoveryContext.sourceM, input.preparation.sourceCommit, 'PyPI observer recovery source/preparation mismatch')
  if (Object.keys(input.publishers).some(filename => !publisherKeys.includes(filename))) fail('PyPI observer publishers contain an unknown file')
  for (const [filename, publisher] of Object.entries(input.publishers)) {
    releaseSetKeys(publisher, ['repository', 'repositoryId', 'sourceCommit', 'workflowPath', 'ref', 'event', 'environment', 'publisherRunId', 'publisherAttempt'], `PyPI observer publisher ${filename}`)
    requireEqual(publisher.repository, EXPECTED_REPOSITORY, `PyPI observer publisher ${filename} repository mismatch`)
    requireEqual(String(publisher.repositoryId), EXPECTED_REPOSITORY_ID, `PyPI observer publisher ${filename} repository ID mismatch`)
    const expectedPublisherSource = input.publisherSources?.[filename] ?? publisherSource
    requireEqual(expectedPublisherSource === input.preparation.sourceCommit || expectedPublisherSource === recoveryControlSource, true, `PyPI observer publisher ${filename} source is outside M/C`)
    requireEqual(publisher.sourceCommit, expectedPublisherSource, `PyPI observer publisher ${filename} source mismatch`)
    requireEqual(publisher.workflowPath, RELEASE_SET_WORKFLOW, `PyPI observer publisher ${filename} workflow mismatch`)
    requireEqual(publisher.ref, 'refs/heads/main', `PyPI observer publisher ${filename} ref mismatch`)
    requireEqual(publisher.event, 'workflow_dispatch', `PyPI observer publisher ${filename} event mismatch`)
    requireEqual(publisher.environment, 'pypi', `PyPI observer publisher ${filename} environment mismatch`)
    requireFuturePositiveId(publisher.publisherRunId, `PyPI observer publisher ${filename} run ID`)
    requireFuturePositiveId(publisher.publisherAttempt, `PyPI observer publisher ${filename} attempt`)
  }
  releaseSetKeys(input.observer, ['runId', 'runAttempt', 'workflowPath', 'sourceCommit'], 'PyPI observer context')
  requireFuturePositiveId(input.observer.runId, 'PyPI observer run ID'); requireFuturePositiveId(input.observer.runAttempt, 'PyPI observer attempt')
  requireEqual(input.observer.workflowPath, RELEASE_SET_WORKFLOW, 'PyPI observer workflow mismatch'); requireSha(input.observer.sourceCommit, 'PyPI observer source')
  releaseSetKeys(input.toolPaths, ['python'], 'PyPI observer tool paths'); npmSafePath(input.toolPaths.python, 'PyPI observer Python path')
  return input
}

const pypiConsumerProof = async (result, pythonPath, expectedVersion, label) => {
  let proof
  try { proof = JSON.parse(result.stdout) } catch { fail(`pypi-observe-${label}-proof-invalid`) }
  releaseSetKeys(proof, ['version', 'origin'], `PyPI ${label} consumer proof`)
  requireEqual(proof.version, expectedVersion, `PyPI ${label} consumer version mismatch`)
  if (typeof proof.origin !== 'string' || !proof.origin.endsWith('/erpc_sdk/__init__.py')) fail(`pypi-observe-${label}-consumer-origin-invalid`)
  const venvRoot = await realpath(resolve(pythonPath, '..', '..'))
  const origin = await realpath(proof.origin)
  if (!origin.startsWith(`${venvRoot}${sep}`) || !origin.includes(`${sep}site-packages${sep}erpc_sdk${sep}`)) fail(`pypi-observe-${label}-consumer-origin-invalid`)
  return proof
}

/** Read-only PyPI wheel/sdist observation. */
export async function observePyPIRelease(input, adapters = {}) {
  const outputFile = await npmInvalidateOutput(input?.outputFile, input?.workDir, 'PyPI observer output file', 'pypi-public-observation')
  pypiStrictInput(input)
  const request = adapters.request ?? npmDefaultRequest; const run = adapters.run ?? npmDefaultRun
  const now = adapters.now ?? (() => performance.now()); const sleep = adapters.sleep ?? (milliseconds => new Promise(resolve_ => setTimeout(resolve_, milliseconds)))
  const workDir = npmSafePath(input.workDir, 'PyPI observer work directory')
  if ((await readdir(workDir, { withFileTypes: true })).length !== 0) fail('pypi-observe-work-directory-not-fresh')
  const deadline = now() + 600_000; const deadlineControl = { now, deadline }; const headers = { 'user-agent': RELEASE_USER_AGENT, accept: 'application/json' }
  const get = async (url, timeoutMs) => {
    try { const response = await request(url, { headers, timeoutMs: Math.min(timeoutMs, npmDeadlineRemaining(now, deadline)), deadline }); npmCheckDeadline(now, deadline); return response }
    catch (error) { if (error?.message === 'npm-observe-deadline-exceeded') throw error; fail('pypi-observe-http-failed') }
  }
  const version = input.descriptors['pypi-wheel'].version; const metadataUrl = pypiMetadataUrl(version)
  let metadataResponse
  while (true) { metadataResponse = await get(metadataUrl, 20_000); if (metadataResponse.status === 200) break; if (metadataResponse.status !== 404) fail(`pypi-observe-metadata-http-${metadataResponse.status}`); await sleep(Math.min(30_000, npmDeadlineRemaining(now, deadline))); npmCheckDeadline(now, deadline) }
  let metadata; try { metadata = JSON.parse(npmResponseBody(metadataResponse).toString('utf8')) } catch { fail('pypi-observe-metadata-json-invalid') }
  if (metadata.info?.name !== 'erpc-sdk' || metadata.info?.version !== version || !Array.isArray(metadata.urls)) fail('pypi-observe-metadata-identity-failed')
  const expected = Object.fromEntries(pypiExpectedKinds.map(kind => [input.descriptors[kind].filename, { kind, descriptor: input.descriptors[kind] }]))
  const files = new Map()
  for (const file of metadata.urls) {
    const expectedFile = expected[file?.filename]; if (!expectedFile || files.has(file.filename)) fail('pypi-observe-metadata-file-set-failed')
    const packageType = expectedFile.kind === 'pypi-wheel' ? 'bdist_wheel' : 'sdist'; const url = pypiCanonicalFileUrl(file.url)
    if (file.yanked !== false || file.packagetype !== packageType || url === null || !ARCHIVE_SHA256.test(file.digests?.sha256 ?? '')) fail(`pypi-observe-metadata-file-invalid-${file?.filename ?? 'unknown'}`)
    requireEqual(file.digests.sha256, expectedFile.descriptor.sha256, `PyPI ${file.filename} metadata digest conflicts with preparation`)
    files.set(file.filename, { ...file, url, kind: expectedFile.kind, descriptor: expectedFile.descriptor })
  }
  if (files.size === 0) fail('pypi-observe-version-files-absent')
  const missing = pypiExpectedKinds.filter(kind => !files.has(input.descriptors[kind].filename))
  const emptyPipConfig = join(workDir, 'empty-pip.conf'); await writeFile(emptyPipConfig, ''); const isolatedEnv = pypiChildEnvironment({ workDir, emptyPipConfig })
  const archiveExecutor = async (command, arguments_, options = {}) => { const result = await npmBoundedExecFile(command, arguments_, { ...options, cwd: options.cwd ?? workDir, env: isolatedEnv, timeout: Math.min(options.timeout ?? Number.POSITIVE_INFINITY, npmDeadlineRemaining(now, deadline)), killSignal: 'SIGTERM' }); npmCheckDeadline(now, deadline); return result }
  const toolVersion = await npmInvoke(run, input.toolPaths.python, ['-c', 'import sys,importlib.metadata,cryptography; print(sys.version.split()[0]); print(importlib.metadata.version("pypi-attestations")); print(cryptography.__version__)'], { cwd: workDir, env: isolatedEnv }, 'pypi-tool-versions', deadlineControl)
  const toolLines = String(toolVersion.stdout).trim().split(/\r?\n/)
  if (toolLines.length < 3 || !/^3\.12\./.test(toolLines[0]) || toolLines[1] !== '0.0.30' || toolLines[2] !== '50.0.2') fail('pypi-observe-tool-version-mismatch')
  const buildVersion = await npmInvoke(run, input.toolPaths.python, ['-m', 'build', '--version'], { cwd: workDir, env: isolatedEnv }, 'pypi-build-version', deadlineControl)
  if (!/^build 1\.6\.0(?:\s|\(|$)/.test(String(buildVersion.stdout).trim())) fail('pypi-observe-build-version-mismatch')
  const observations = []
  for (const file of files.values()) {
    const publisher = input.publishers[file.filename]
    if (publisher === undefined) fail(`pypi-observe-publisher-context-missing-${file.filename}`)
    let response
    while (true) {
      response = await get(file.url, 60_000)
      if (response.status === 200) break
      if (response.status !== 404) fail(`pypi-observe-download-http-${response.status}`)
      await sleep(Math.min(30_000, npmDeadlineRemaining(now, deadline)))
      npmCheckDeadline(now, deadline)
    }
    const bytes = npmResponseBody(response); const observedSha256 = sha256Hex(bytes); requireEqual(observedSha256, file.digests.sha256, `PyPI ${file.filename} downloaded digest mismatch`); requireEqual(observedSha256, file.descriptor.sha256, `PyPI ${file.filename} prepared digest mismatch`)
    const archivePath = join(workDir, file.filename); await writeFile(archivePath, bytes); await inspectReleaseSetArtifactBytes(file.descriptor, archivePath, publisher.sourceCommit, { execFile: archiveExecutor, commandMap: { python3: input.toolPaths.python }, profileMode: file.descriptor.profile === 'legacy' ? 'legacy' : 'future' })
    const provenanceUrl = pypiProvenanceUrl(version, file.filename)
    let provenanceResponse
    while (true) {
      provenanceResponse = await get(provenanceUrl, 20_000)
      if (provenanceResponse.status === 200) break
      if (provenanceResponse.status !== 404) fail(`pypi-observe-provenance-http-${provenanceResponse.status}`)
      await sleep(Math.min(30_000, npmDeadlineRemaining(now, deadline)))
      npmCheckDeadline(now, deadline)
    }
    const provenanceFile = join(workDir, `${file.filename}.provenance.json`); await writeFile(provenanceFile, npmResponseBody(provenanceResponse))
    await npmInvoke(run, input.toolPaths.python, ['-m', 'pypi_attestations', 'verify', 'pypi', '--repository', `https://github.com/${EXPECTED_REPOSITORY}`, '--provenance-file', provenanceFile, archivePath], { cwd: workDir, env: isolatedEnv }, `pypi-attestation-${file.filename}`, deadlineControl)
    const claimsResult = await npmInvoke(run, input.toolPaths.python, ['-c', pypiClaimsPython, provenanceFile, file.filename, observedSha256], { cwd: workDir, env: isolatedEnv }, `pypi-claims-${file.filename}`, deadlineControl)
    let claims; try { claims = JSON.parse(claimsResult.stdout) } catch { fail(`pypi-observe-claims-invalid-${file.filename}`) }
    if (claims.publisher?.kind !== 'GitHub' || claims.publisher.repository !== EXPECTED_REPOSITORY || claims.publisher.workflow !== 'release.yml' || claims.publisher.environment !== 'pypi') fail(`pypi-observe-publisher-invalid-${file.filename}`)
    const expectedInvocation = `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/${publisher.publisherRunId}/attempts/${publisher.publisherAttempt}`
    for (const [key, expectedClaim, label] of [['1.3.6.1.4.1.57264.1.9', `https://github.com/${EXPECTED_REPOSITORY}/.github/workflows/release.yml@refs/heads/main`, 'workflow-legacy'], ['1.3.6.1.4.1.57264.1.18', `https://github.com/${EXPECTED_REPOSITORY}/.github/workflows/release.yml@refs/heads/main`, 'workflow'], ['1.3.6.1.4.1.57264.1.10', publisher.sourceCommit, 'source-legacy'], ['1.3.6.1.4.1.57264.1.13', publisher.sourceCommit, 'source'], ['1.3.6.1.4.1.57264.1.19', publisher.sourceCommit, 'source-workflow'], ['1.3.6.1.4.1.57264.1.12', `https://github.com/${EXPECTED_REPOSITORY}`, 'repository'], ['1.3.6.1.4.1.57264.1.14', 'refs/heads/main', 'ref'], ['1.3.6.1.4.1.57264.1.15', EXPECTED_REPOSITORY_ID, 'repository-id'], ['1.3.6.1.4.1.57264.1.20', 'workflow_dispatch', 'event'], ['1.3.6.1.4.1.57264.1.21', expectedInvocation, 'invocation']]) npmRequireClaim(claims.claims, [key], expectedClaim, `${label}-${file.filename}`)
    if (claims.claims['1.3.6.1.4.1.57264.1.8'] !== 'https://token.actions.githubusercontent.com' && claims.claims['1.3.6.1.4.1.57264.1.1'] !== 'https://token.actions.githubusercontent.com') fail(`pypi-observe-issuer-${file.filename}`)
    if (claims.claims['1.3.6.1.4.1.57264.1.23'] !== undefined) requireEqual(claims.claims['1.3.6.1.4.1.57264.1.23'], 'pypi', `PyPI ${file.filename} environment claim`)
    if (claims.claims['1.3.6.1.4.1.57264.1.24'] !== undefined) requireEqual(claims.claims['1.3.6.1.4.1.57264.1.24'], `repo:elsoul@42315168/erpc-sdk@${EXPECTED_REPOSITORY_ID}:environment:pypi`, `PyPI ${file.filename} environment identity claim`)
    if (claims.subject?.name !== file.filename || claims.subject?.digest?.sha256 !== observedSha256) fail(`pypi-observe-subject-${file.filename}`)
    if (claims.publisher?.repository !== publisher.repository || String(claims.publisher?.repository_id ?? publisher.repositoryId) !== String(publisher.repositoryId) || claims.publisher?.workflow !== 'release.yml' || claims.publisher?.environment !== publisher.environment) fail(`pypi-observe-publisher-context-${file.filename}`)
    observations.push({ filename: file.filename, kind: file.kind, url: file.url, sha256: observedSha256, provenanceUrl, certificateClaims: claims.claims, environmentClaimsPresent: { environment: claims.claims['1.3.6.1.4.1.57264.1.23'] !== undefined, identity: claims.claims['1.3.6.1.4.1.57264.1.24'] !== undefined }, subject: claims.subject, publisher: { ...publisher, invocation: expectedInvocation } })
  }
  if (missing.length > 0) {
    const verifiedExisting = observations.map(file => ({ filename: file.filename, kind: file.kind, sha256: file.sha256, publisher: file.publisher, certificateClaims: file.certificateClaims, subject: file.subject }))
    const partialConsumers = {}
    const availableWheel = observations.find(file => file.kind === 'pypi-wheel')
    if (availableWheel !== undefined) {
      const venv = await mkdtemp(join(workDir, 'partial-wheel-venv-')); await npmInvoke(run, input.toolPaths.python, ['-m', 'venv', venv], { cwd: workDir, env: isolatedEnv }, 'pypi-partial-wheel-venv', deadlineControl)
      const wheelPython = join(venv, 'bin', 'python'); await npmInvoke(run, wheelPython, ['-m', 'pip', 'install', join(workDir, availableWheel.filename)], { cwd: workDir, env: isolatedEnv }, 'pypi-partial-wheel-install', deadlineControl)
      const wheelImport = await npmInvoke(run, wheelPython, ['-c', 'import erpc_sdk, importlib.metadata, json; print(json.dumps({"origin": erpc_sdk.__file__, "version": importlib.metadata.version("erpc-sdk")}))'], { cwd: workDir, env: isolatedEnv }, 'pypi-partial-wheel-consumer', deadlineControl)
      partialConsumers.wheel = { exitCode: wheelImport.exitCode, proof: await pypiConsumerProof(wheelImport, wheelPython, version, 'partial-wheel') }
    }
    const availableSdist = observations.find(file => file.kind === 'pypi-sdist')
    if (availableSdist !== undefined) {
      const partialBuild = join(workDir, 'partial-sdist-wheel'); await mkdir(partialBuild)
      await npmInvoke(run, input.toolPaths.python, ['-m', 'build', '--wheel', '--outdir', partialBuild, join(workDir, availableSdist.filename)], { cwd: workDir, env: isolatedEnv }, 'pypi-partial-sdist-build', deadlineControl)
      const partialWheels = (await readdir(partialBuild, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.whl'))
      if (partialWheels.length !== 1) fail('pypi-observe-partial-sdist-wheel-ambiguous')
      const partialVenv = await mkdtemp(join(workDir, 'partial-sdist-venv-')); await npmInvoke(run, input.toolPaths.python, ['-m', 'venv', partialVenv], { cwd: workDir, env: isolatedEnv }, 'pypi-partial-sdist-venv', deadlineControl)
      const partialPython = join(partialVenv, 'bin', 'python'); await npmInvoke(run, partialPython, ['-m', 'pip', 'install', join(partialBuild, partialWheels[0].name)], { cwd: workDir, env: isolatedEnv }, 'pypi-partial-sdist-install', deadlineControl)
      const partialImport = await npmInvoke(run, partialPython, ['-c', 'import erpc_sdk, importlib.metadata, json; print(json.dumps({"origin": erpc_sdk.__file__, "version": importlib.metadata.version("erpc-sdk")}))'], { cwd: workDir, env: isolatedEnv }, 'pypi-partial-sdist-consumer', deadlineControl)
      partialConsumers.sdist = { exitCode: partialImport.exitCode, proof: await pypiConsumerProof(partialImport, partialPython, version, 'partial-sdist') }
    }
    return { schemaVersion: 1, kind: 'pypi-public-observation', state: 'partial', complete: false, version, missingKinds: missing, observedKinds: observations.map(file => file.kind), verifiedExisting, consumers: partialConsumers, auth: { requested: false, uploadAttempted: false } }
  }
  const wheel = observations.find(item => item.kind === 'pypi-wheel'); const sdist = observations.find(item => item.kind === 'pypi-sdist')
  const wheelVenv = await mkdtemp(join(workDir, 'wheel-venv-')); await npmInvoke(run, input.toolPaths.python, ['-m', 'venv', wheelVenv], { cwd: workDir, env: isolatedEnv }, 'pypi-wheel-venv', deadlineControl)
  const wheelPython = join(wheelVenv, 'bin', 'python'); await npmInvoke(run, wheelPython, ['-m', 'pip', 'install', join(workDir, wheel.filename)], { cwd: workDir, env: isolatedEnv }, 'pypi-wheel-install', deadlineControl)
  const wheelImport = await npmInvoke(run, wheelPython, ['-c', 'import erpc_sdk, importlib.metadata, json; print(json.dumps({"origin": erpc_sdk.__file__, "version": importlib.metadata.version("erpc-sdk")}))'], { cwd: workDir, env: isolatedEnv }, 'pypi-wheel-consumer', deadlineControl); const wheelProof = await pypiConsumerProof(wheelImport, wheelPython, version, 'wheel')
  const sdistBuild = join(workDir, 'sdist-wheel'); await mkdir(sdistBuild); await npmInvoke(run, input.toolPaths.python, ['-m', 'build', '--wheel', '--outdir', sdistBuild, join(workDir, sdist.filename)], { cwd: workDir, env: isolatedEnv }, 'pypi-sdist-build', deadlineControl)
  const builtWheels = (await readdir(sdistBuild, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.whl')); if (builtWheels.length !== 1) fail('pypi-observe-sdist-wheel-ambiguous')
  const sdistVenv = await mkdtemp(join(workDir, 'sdist-venv-')); await npmInvoke(run, input.toolPaths.python, ['-m', 'venv', sdistVenv], { cwd: workDir, env: isolatedEnv }, 'pypi-sdist-venv', deadlineControl); const sdistPython = join(sdistVenv, 'bin', 'python'); await npmInvoke(run, sdistPython, ['-m', 'pip', 'install', join(sdistBuild, builtWheels[0].name)], { cwd: workDir, env: isolatedEnv }, 'pypi-sdist-install', deadlineControl)
  const sdistImport = await npmInvoke(run, sdistPython, ['-c', 'import erpc_sdk, importlib.metadata, json; print(json.dumps({"origin": erpc_sdk.__file__, "version": importlib.metadata.version("erpc-sdk")}))'], { cwd: workDir, env: isolatedEnv }, 'pypi-sdist-consumer', deadlineControl); const sdistProof = await pypiConsumerProof(sdistImport, sdistPython, version, 'sdist')
  npmCheckDeadline(now, deadline)
  const receipt = { schemaVersion: 1, kind: 'pypi-public-observation', state: 'observed', complete: true, repository: EXPECTED_REPOSITORY, repositoryId: EXPECTED_REPOSITORY_ID, planSha256: input.planSha256, preparation: input.preparation, version, publishers: Object.fromEntries(observations.map(file => [file.filename, file.publisher])), observer: input.observer, metadata: { url: metadataUrl, status: metadataResponse.status, bodySha256: sha256Hex(npmResponseBody(metadataResponse)) }, files: observations, consumers: { wheel: { exitCode: wheelImport.exitCode, proof: wheelProof }, sdist: { exitCode: sdistImport.exitCode, proof: sdistProof } }, auth: { requested: false, uploadAttempted: false }, ...(input.recoveryContext === undefined ? {} : { recoveryContextSha256: input.recoveryContext.contextSha256 }), observedAt: new Date().toISOString() }
  const temporaryOutput = `${outputFile}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporaryOutput, `${canonicalJson(receipt)}\n`, { flag: 'wx' })
  await rename(temporaryOutput, outputFile)
  try { npmCheckDeadline(now, deadline) } catch (error) { await rm(outputFile, { force: true }); throw error }
  return receipt
}

const rubyGemsOrigin = 'https://rubygems.org'
const rubyGemsMetadataUrl = version => `${rubyGemsOrigin}/api/v2/rubygems/erpc-sdk/versions/${version}.json`
const rubyGemsDownloadUrl = version => `${rubyGemsOrigin}/downloads/erpc-sdk-${version}.gem`

const rubyRequireRunSuccess = (result, stage) => {
  if (!result || result.exitCode !== 0) fail(`rubygems-observe-${stage}-failed`)
  return result
}

const rubyDeadlineRemaining = (now, deadline) => {
  const remaining = deadline - now()
  if (!(remaining > 0)) fail('rubygems-observe-deadline-exceeded')
  return Math.max(1, Math.ceil(remaining))
}

const rubyCheckDeadline = (now, deadline) => {
  if (now() >= deadline) fail('rubygems-observe-deadline-exceeded')
}

const rubyInvoke = async (run, command, arguments_, options, stage, deadlineControl) => {
  const boundedOptions = deadlineControl === undefined
    ? options
    : {
        ...options,
        timeout: Math.min(options.timeout ?? Number.POSITIVE_INFINITY, rubyDeadlineRemaining(deadlineControl.now, deadlineControl.deadline)),
        killSignal: 'SIGTERM',
      }
  let result
  try {
    result = await run(command, arguments_, boundedOptions)
  } catch {
    fail(`rubygems-observe-${stage}-failed`)
  }
  rubyRequireRunSuccess(result, stage)
  if (deadlineControl !== undefined) rubyCheckDeadline(deadlineControl.now, deadlineControl.deadline)
  return result
}

const rubyChildEnvironment = ({ workDir, gemHome, gemCache, gemrc, bundleConfig }) => ({
  PATH: process.env.PATH ?? '',
  TMPDIR: workDir,
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  GEM_HOME: gemHome,
  GEM_PATH: gemHome,
  GEM_SPEC_CACHE: gemCache,
  GEMRC: gemrc,
  BUNDLE_USER_CONFIG: bundleConfig,
  BUNDLE_USER_CACHE: gemCache,
  BUNDLE_DISABLE_SHARED_GEMS: '1',
  BUNDLE_GEMFILE: '',
  BUNDLE_PATH: '',
  BUNDLE_WITH: '',
  BUNDLE_WITHOUT: '',
  RUBYOPT: '',
  RUBYLIB: '',
  RUBYGEMS_GEMDEPS: '',
})

const rubyConsumerScript = String.raw`
require 'json'
require 'digest'

gem_home, expected_version, expected_runtime = ARGV
abort 'Ruby consumer arguments are incomplete' unless gem_home && expected_version && expected_runtime
root = File.realpath(gem_home)
under_root = lambda do |path|
  real = File.realpath(path)
  real == root || real.start_with?("#{root}#{File::SEPARATOR}")
end
canonical = lambda do |path, label|
  abort "#{label} origin is missing" unless path && File.file?(path)
  File.realpath(path)
rescue StandardError
  abort "#{label} origin is not readable"
end
canonical_root = lambda do |path, label|
  abort "#{label} root is missing" unless path && File.directory?(path)
  File.realpath(path)
rescue StandardError
  abort "#{label} root is not readable"
end
under = lambda do |path, allowed_root|
  path == allowed_root || path.start_with?("#{allowed_root}#{File::SEPARATOR}")
end
abort 'Ruby interpreter mismatch' unless RUBY_VERSION.start_with?("#{expected_runtime}.")
sdk = Gem::Specification.find_by_name('erpc-sdk', expected_version)
base64 = Gem::Specification.find_by_name('base64', '0.2.0')
keccak = Gem::Specification.find_by_name('digest-keccak', '0.0.7')
sdk_root = canonical_root.call(sdk.full_gem_path, 'SDK')
base64_root = canonical_root.call(base64.full_gem_path, 'base64')
keccak_root = canonical_root.call(keccak.full_gem_path, 'digest-keccak')
keccak_extension_root = canonical_root.call(keccak.extension_dir, 'digest-keccak extension')
abort 'SDK was not loaded from fresh GEM_HOME' unless under_root.call(sdk_root)
abort 'base64 did not resolve from fresh GEM_HOME' unless under_root.call(base64_root)
abort 'digest-keccak did not resolve from fresh GEM_HOME' unless under_root.call(keccak_root)
abort 'digest-keccak extension did not resolve from fresh GEM_HOME' unless under_root.call(keccak_extension_root)
require 'erpc_sdk'
require 'base64'
require 'digest/keccak'
loaded = Gem.loaded_specs.fetch('erpc-sdk')
loaded_base64 = Gem.loaded_specs.fetch('base64')
loaded_keccak = Gem.loaded_specs.fetch('digest-keccak')
abort 'wrong SDK version' unless ERPC::VERSION == expected_version
abort 'loaded SDK version/origin is invalid' unless loaded.version.to_s == expected_version && under_root.call(File.realpath(loaded.full_gem_path))
abort 'loaded base64 version/origin is invalid' unless loaded_base64.version.to_s == '0.2.0' && under_root.call(File.realpath(loaded_base64.full_gem_path))
abort 'loaded digest-keccak version/origin is invalid' unless loaded_keccak.version.to_s == '0.0.7' && under_root.call(File.realpath(loaded_keccak.full_gem_path))
sdk_features = $LOADED_FEATURES.grep(/(?:^|\/)erpc_sdk\.rb\z/).map { |path| canonical.call(path, 'SDK entrypoint') }
base64_features = $LOADED_FEATURES.grep(/(?:^|\/)base64\.rb\z/).map { |path| canonical.call(path, 'base64 entrypoint') }
keccak_features = $LOADED_FEATURES.grep(/(?:^|\/)digest\/keccak(?:\/[^\/]+)?\.(?:rb|bundle|so|dylib|dll)\z/).map { |path| canonical.call(path, 'digest-keccak entrypoint') }
keccak_native_features = keccak_features.select { |path| path.match?(/\.(?:bundle|so|dylib|dll)\z/) }
abort 'SDK entrypoint evidence is missing or ambiguous' unless sdk_features.length == 1 && sdk_features.all? { |path| under.call(path, sdk_root) }
abort 'base64 entrypoint evidence is missing or ambiguous' unless base64_features.length == 1 && base64_features.all? { |path| under.call(path, base64_root) }
abort 'digest-keccak entrypoint evidence is missing or ambiguous' unless keccak_features.length >= 1 && keccak_native_features.length == 1 && keccak_features.all? { |path| under.call(path, keccak_root) || under.call(path, keccak_extension_root) }
native_extension_files = Dir[File.join(keccak_extension_root, '**', 'keccak.{bundle,so,dylib,dll}')].map { |path| canonical.call(path, 'digest-keccak extension file') }.uniq
abort 'digest-keccak native extension evidence is missing' if native_extension_files.empty?
native_extension_digests = native_extension_files.map { |path| Digest::SHA256.file(path).hexdigest }
keccak_native_digests = keccak_native_features.map { |path| Digest::SHA256.file(path).hexdigest }
abort 'digest-keccak native entrypoint is not bound to the fresh extension' unless keccak_native_digests.all? { |digest| native_extension_digests.include?(digest) }
encoded = Base64.strict_encode64('erpc-recovery')
abort 'Base64 round trip failed' unless Base64.strict_decode64(encoded) == 'erpc-recovery'
keccak_answer = '6d7b9c3dc6053e342867a5d1cde60ad102664b6ee3805ec3649292d2ae8f4d1edd523f4b88e729500a990f9cf43b455543f59f8f5eb00035a69b1da9c1d48ae2'
abort 'Keccak smoke failed' unless Digest::Keccak.hexdigest('recovery') == keccak_answer
puts JSON.generate({
  ruby: RUBY_VERSION,
  sdk: sdk_root,
  sdkVersion: loaded.version.to_s,
  base64: base64_root,
  base64Version: loaded_base64.version.to_s,
  digestKeccak: keccak_root,
  digestKeccakVersion: loaded_keccak.version.to_s,
  roots: { sdk: sdk_root, base64: base64_root, digestKeccak: keccak_root, digestKeccakExtension: keccak_extension_root },
  entrypoints: { sdk: sdk_features, base64: base64_features, digestKeccak: keccak_features, digestKeccakNative: keccak_native_features },
  nativeExtensionFiles: native_extension_files.map { |path| { path: path, sha256: Digest::SHA256.file(path).hexdigest } },
})
`

const rubyPathWithin = async (path, root, label) => {
  if (typeof path !== 'string' || path.length === 0) fail(`${label} origin is missing`)
  let canonicalRoot
  let canonicalPath
  try {
    canonicalRoot = await realpath(root)
    canonicalPath = await realpath(path)
  } catch {
    fail(`${label} origin is not readable`)
  }
  if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) fail(`${label} origin escaped isolated GEM_HOME`)
  return canonicalPath
}

const rubyPathWithinAny = async (path, roots, label) => {
  if (typeof path !== 'string' || path.length === 0) fail(`${label} origin is missing`)
  let canonicalPath
  try { canonicalPath = await realpath(path) } catch { fail(`${label} origin is not readable`) }
  if (!roots.some(root => canonicalPath === root || canonicalPath.startsWith(`${root}${sep}`))) fail(`${label} origin escaped its package root`)
  return canonicalPath
}

const rubyConsumerProof = async (result, runtime, version, gemHome) => {
  rubyRequireRunSuccess(result, `${runtime}-consumer`)
  let proof
  try { proof = JSON.parse(String(result.stdout).trim()) } catch { fail(`rubygems-observe-${runtime}-consumer-json-invalid`) }
  if (typeof proof?.ruby !== 'string' || !proof.ruby.startsWith(`${runtime}.`)) fail(`rubygems-observe-${runtime}-interpreter-mismatch`)
  if (proof.sdkVersion !== version || proof.base64Version !== '0.2.0' || proof.digestKeccakVersion !== '0.0.7') fail(`rubygems-observe-${runtime}-dependency-version-mismatch`)
  const roots = {
    sdk: await rubyPathWithin(proof.roots?.sdk, gemHome, `${runtime} SDK root`),
    base64: await rubyPathWithin(proof.roots?.base64, gemHome, `${runtime} base64 root`),
    digestKeccak: await rubyPathWithin(proof.roots?.digestKeccak, gemHome, `${runtime} digest-keccak root`),
    digestKeccakExtension: await rubyPathWithin(proof.roots?.digestKeccakExtension, gemHome, `${runtime} digest-keccak extension root`),
  }
  const origins = {
    sdk: await rubyPathWithin(proof.sdk, roots.sdk, `${runtime} SDK`),
    base64: await rubyPathWithin(proof.base64, roots.base64, `${runtime} base64`),
    digestKeccak: await rubyPathWithin(proof.digestKeccak, roots.digestKeccak, `${runtime} digest-keccak`),
  }
  const entrypoints = {
    sdk: await Promise.all((Array.isArray(proof.entrypoints?.sdk) ? proof.entrypoints.sdk : []).map(path => rubyPathWithin(path, roots.sdk, `${runtime} SDK entrypoint`))),
    base64: await Promise.all((Array.isArray(proof.entrypoints?.base64) ? proof.entrypoints.base64 : []).map(path => rubyPathWithin(path, roots.base64, `${runtime} base64 entrypoint`))),
    digestKeccak: await Promise.all((Array.isArray(proof.entrypoints?.digestKeccak) ? proof.entrypoints.digestKeccak : []).map(path => rubyPathWithinAny(path, [roots.digestKeccak, roots.digestKeccakExtension], `${runtime} digest-keccak entrypoint`))),
    digestKeccakNative: await Promise.all((Array.isArray(proof.entrypoints?.digestKeccakNative) ? proof.entrypoints.digestKeccakNative : []).map(path => rubyPathWithinAny(path, [roots.digestKeccak, roots.digestKeccakExtension], `${runtime} digest-keccak native entrypoint`))),
  }
  if (entrypoints.sdk.length !== 1 || entrypoints.base64.length !== 1 || entrypoints.digestKeccak.length === 0 || entrypoints.digestKeccakNative.length !== 1) fail(`rubygems-observe-${runtime}-entrypoint-evidence-incomplete`)
  const nativeExtensionFiles = Array.isArray(proof.nativeExtensionFiles) ? await Promise.all(proof.nativeExtensionFiles.map(async item => ({ path: await rubyPathWithin(item?.path, roots.digestKeccakExtension, `${runtime} digest-keccak extension file`), sha256: item?.sha256 }))) : []
  if (nativeExtensionFiles.length === 0 || nativeExtensionFiles.some(item => typeof item.sha256 !== 'string' || !ARCHIVE_SHA256.test(item.sha256))) fail(`rubygems-observe-${runtime}-native-extension-evidence-incomplete`)
  const nativeExtensionDigests = new Set(nativeExtensionFiles.map(item => item.sha256))
  for (const path of entrypoints.digestKeccakNative) {
    if (!nativeExtensionDigests.has(sha256Hex(await readFile(path)))) fail(`rubygems-observe-${runtime}-native-extension-binding-failed`)
  }
  return {
    exitCode: result.exitCode,
    ruby: proof.ruby,
    sdk: origins.sdk,
    sdkVersion: proof.sdkVersion,
    base64: origins.base64,
    base64Version: proof.base64Version,
    digestKeccak: origins.digestKeccak,
    digestKeccakVersion: proof.digestKeccakVersion,
    roots,
    entrypoints,
    nativeExtensionFiles,
  }
}

const rubyStrictInput = input => {
  releaseSetKeys(input, ['descriptor', 'planSha256', 'preparation', 'observer', 'workDir', 'outputFile', 'toolPaths', 'recoveryContext'], 'RubyGems observer input')
  releaseSetKeys(input.descriptor, ['kind', 'filename', 'name', 'version', 'sha256', 'files', 'profile'], 'RubyGems observer descriptor')
  requireEqual(input.descriptor.kind, 'rubygems', 'RubyGems observer descriptor kind mismatch')
  requireEqual(input.descriptor.name, 'erpc-sdk', 'RubyGems observer package identity mismatch')
  releaseSetVersion(input.descriptor.version, 'RubyGems observer version')
  requireEqual(input.descriptor.filename, releaseSetArtifactFilename('rubygems', input.descriptor.version), 'RubyGems observer archive filename mismatch')
  requireArchiveSha(input.descriptor.sha256, 'RubyGems observer descriptor SHA-256')
  requireArchiveSha(input.planSha256, 'RubyGems observer plan SHA-256')
  releaseSetKeys(input.preparation, ['sourceCommit', 'runId', 'runAttempt', 'artifactId', 'bindingArtifactId', 'planSha256'], 'RubyGems observer preparation')
  requireSha(input.preparation.sourceCommit, 'RubyGems observer preparation source')
  requireArchiveSha(input.preparation.planSha256, 'RubyGems observer preparation plan SHA-256')
  requireEqual(input.preparation.planSha256, input.planSha256, 'RubyGems observer preparation plan mismatch')
  for (const [value, label] of [[input.preparation.runId, 'RubyGems observer preparation run ID'], [input.preparation.runAttempt, 'RubyGems observer preparation attempt'], [input.preparation.artifactId, 'RubyGems observer preparation artifact ID'], [input.preparation.bindingArtifactId, 'RubyGems observer preparation binding artifact ID']]) requireFuturePositiveId(value, label)
  releaseSetKeys(input.observer, ['runId', 'runAttempt', 'workflowPath', 'sourceCommit'], 'RubyGems observer context')
  requireFuturePositiveId(input.observer.runId, 'RubyGems observer run ID')
  requireFuturePositiveId(input.observer.runAttempt, 'RubyGems observer attempt')
  requireEqual(input.observer.workflowPath, RELEASE_SET_WORKFLOW, 'RubyGems observer workflow mismatch')
  requireSha(input.observer.sourceCommit, 'RubyGems observer source')
  if (input.recoveryContext === undefined) requireEqual(input.observer.sourceCommit, input.preparation.sourceCommit, 'RubyGems observer source mismatch')
  else {
    const context = validatePublicationRecoveryContext(input.recoveryContext)
    requireEqual(input.recoveryContext.sourceM, input.preparation.sourceCommit, 'RubyGems observer recovery source/preparation mismatch')
    requireEqual(input.observer.sourceCommit, context.controlCommit, 'RubyGems observer recovery observer source mismatch')
  }
  releaseSetKeys(input.toolPaths, ['ruby31', 'ruby34'], 'RubyGems observer tool paths')
  for (const [name, value] of Object.entries(input.toolPaths)) npmSafePath(value, `RubyGems observer ${name} path`)
  return input
}

const rubyValidateMetadata = (metadata, descriptor) => {
  if (!metadata || metadata.name !== descriptor.name || metadata.version !== descriptor.version || metadata.platform !== 'ruby') fail('rubygems-observe-metadata-identity-failed')
  if (metadata.sha !== descriptor.sha256) fail('rubygems-observe-metadata-digest-mismatch')
  for (const key of ['yanked', 'conflict', 'conflicted', 'version_yanked']) {
    if (metadata[key] !== undefined && metadata[key] !== false) fail(`rubygems-observe-metadata-${key}-conflict`)
  }
  return metadata
}

/** Execute exact RubyGems metadata, archive, and isolated Ruby 3.1/3.4 consumers. */
export async function observeRubyGemsRelease(input, adapters = {}) {
  const outputFile = await npmInvalidateOutput(input?.outputFile, input?.workDir, 'RubyGems observer output file', 'rubygems-public-observation')
  rubyStrictInput(input)
  const request = adapters.request ?? npmDefaultRequest
  const run = adapters.run ?? npmDefaultRun
  const now = adapters.now ?? (() => performance.now())
  const sleep = adapters.sleep ?? (milliseconds => new Promise(resolve_ => setTimeout(resolve_, milliseconds)))
  const workDir = npmSafePath(input.workDir, 'RubyGems observer work directory')
  const workEntries = await readdir(workDir, { withFileTypes: true })
  if (workEntries.length !== 0) fail('rubygems-observe-work-directory-not-fresh')
  const started = now()
  const deadline = started + 600_000
  const deadlineControl = { now, deadline }
  const headers = { 'user-agent': RELEASE_USER_AGENT, accept: 'application/json' }
  const get = async (url, timeoutMs, accept = 'application/json') => {
    const remaining = rubyDeadlineRemaining(now, deadline)
    try {
      const response = await request(url, { headers: { ...headers, accept }, timeoutMs: Math.min(timeoutMs, remaining), deadline })
      rubyCheckDeadline(now, deadline)
      return response
    } catch (error) {
      if (error?.message === 'rubygems-observe-deadline-exceeded') throw error
      fail('rubygems-observe-http-failed')
    }
  }
  const version = input.descriptor.version
  const metadataUrl = rubyGemsMetadataUrl(version)
  let metadataResponse
  while (true) {
    metadataResponse = await get(metadataUrl, 20_000)
    if (metadataResponse.status === 200) break
    if (metadataResponse.status !== 404) fail(`rubygems-observe-metadata-http-${metadataResponse.status}`)
    await sleep(Math.min(30_000, rubyDeadlineRemaining(now, deadline)))
    rubyCheckDeadline(now, deadline)
  }
  const metadataBody = npmResponseBody(metadataResponse)
  let metadata
  try { metadata = JSON.parse(metadataBody.toString('utf8')) } catch { fail('rubygems-observe-metadata-json-invalid') }
  rubyValidateMetadata(metadata, input.descriptor)
  const downloadUrl = rubyGemsDownloadUrl(version)
  let downloadResponse
  while (true) {
    downloadResponse = await get(downloadUrl, 60_000, 'application/octet-stream')
    if (downloadResponse.status === 200) break
    if (downloadResponse.status !== 404) fail(`rubygems-observe-download-http-${downloadResponse.status}`)
    await sleep(Math.min(30_000, rubyDeadlineRemaining(now, deadline)))
    rubyCheckDeadline(now, deadline)
  }
  const gemBytes = npmResponseBody(downloadResponse)
  const observedSha256 = sha256Hex(gemBytes)
  requireEqual(observedSha256, metadata.sha, 'RubyGems downloaded digest does not match registry metadata')
  requireEqual(observedSha256, input.descriptor.sha256, 'RubyGems downloaded digest does not match preparation')
  const gemPath = join(workDir, input.descriptor.filename)
  await writeFile(gemPath, gemBytes, { flag: 'wx' })
  const runtimes = [
    { key: 'ruby31', label: '3.1', command: input.toolPaths.ruby31 },
    { key: 'ruby34', label: '3.4', command: input.toolPaths.ruby34 },
  ]
  const runtimeRoots = new Map()
  for (const runtime of runtimes) {
    const runtimeDir = join(workDir, `ruby-${runtime.label}`)
    const gemHome = join(runtimeDir, 'gem-home')
    const gemCache = join(runtimeDir, 'gem-cache')
    const consumerDir = join(runtimeDir, 'consumer')
    const bundleConfig = join(runtimeDir, 'bundle-config')
    const gemrc = join(runtimeDir, 'empty-gemrc')
    await mkdir(gemHome, { recursive: true })
    await mkdir(gemCache, { recursive: true })
    await mkdir(consumerDir, { recursive: true })
    await mkdir(bundleConfig, { recursive: true })
    await writeFile(gemrc, '')
    runtimeRoots.set(runtime.key, { ...runtime, runtimeDir, gemHome, gemCache, consumerDir, bundleConfig, gemrc, env: rubyChildEnvironment({ workDir: runtimeDir, gemHome, gemCache, gemrc, bundleConfig }) })
  }
  const inspection = runtimeRoots.get('ruby34')
  const archiveExecutor = async (command, arguments_, options = {}) => {
    const timeout = Math.min(options.timeout ?? Number.POSITIVE_INFINITY, rubyDeadlineRemaining(now, deadline))
    const result = await npmBoundedExecFile(command, arguments_, { ...options, cwd: options.cwd ?? inspection.runtimeDir, env: inspection.env, timeout, killSignal: 'SIGTERM' })
    rubyCheckDeadline(now, deadline)
    return result
  }
  const archiveEvidence = await inspectReleaseSetArtifactBytes(input.descriptor, gemPath, input.preparation.sourceCommit, { execFile: archiveExecutor, commandMap: { ruby: input.toolPaths.ruby34 }, profileMode: input.descriptor.profile === 'legacy' ? 'legacy' : 'future' })
  const consumers = {}
  for (const runtime of runtimes) {
    const isolated = runtimeRoots.get(runtime.key)
    const versionResult = await rubyInvoke(run, runtime.command, ['-e', 'print RUBY_VERSION'], { cwd: isolated.consumerDir, env: isolated.env }, `${runtime.label}-version`, deadlineControl)
    const actualRuntime = String(versionResult.stdout).trim()
    if (!new RegExp(`^${runtime.label}\\.`).test(actualRuntime)) fail(`rubygems-observe-${runtime.label}-interpreter-mismatch`)
    const consumerScript = join(isolated.runtimeDir, 'consumer.rb')
    await writeFile(consumerScript, rubyConsumerScript, { flag: 'wx' })
    const installResult = await rubyInvoke(run, runtime.command, ['-S', 'gem', 'install', '--norc', gemPath, '--install-dir', isolated.gemHome, '--both', '--clear-sources', '--source', `${rubyGemsOrigin}/`, '--no-document'], { cwd: isolated.consumerDir, env: isolated.env }, `${runtime.label}-install`, deadlineControl)
    const consumerResult = await rubyInvoke(run, runtime.command, [consumerScript, isolated.gemHome, version, runtime.label], { cwd: isolated.consumerDir, env: isolated.env }, `${runtime.label}-consumer`, deadlineControl)
    const proof = await rubyConsumerProof(consumerResult, runtime.label, version, isolated.gemHome)
    consumers[runtime.key] = { ruby: actualRuntime, installExitCode: installResult.exitCode, ...proof }
  }
  rubyCheckDeadline(now, deadline)
  const receipt = {
    schemaVersion: 1,
    kind: 'rubygems-public-observation',
    state: 'observed',
    complete: true,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    planSha256: input.planSha256,
    preparation: input.preparation,
    observer: input.observer,
    version,
    metadata: { url: metadataUrl, status: metadataResponse.status, bodySha256: sha256Hex(metadataBody), name: metadata.name, version: metadata.version, platform: metadata.platform, registrySha256: metadata.sha, yanked: metadata.yanked },
    download: { url: downloadUrl, status: downloadResponse.status, sha256: observedSha256, sizeInBytes: gemBytes.length },
    archive: { filename: archiveEvidence.filename, sha256: archiveEvidence.sha256, members: archiveEvidence.members },
    consumers,
    auth: { requested: false, uploadAttempted: false },
    ...(input.recoveryContext === undefined ? {} : { recoveryContextSha256: input.recoveryContext.contextSha256 }),
    observedAt: new Date().toISOString(),
  }
  const temporaryOutput = `${outputFile}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporaryOutput, `${canonicalJson(receipt)}\n`, { flag: 'wx' })
  await rename(temporaryOutput, outputFile)
  try { rubyCheckDeadline(now, deadline) } catch (error) { await rm(outputFile, { force: true }); throw error }
  return receipt
}

const cratesIoOrigin = 'https://crates.io'
const cratesIoMetadataUrl = version => `${cratesIoOrigin}/api/v1/crates/${CRATE_NAME}/${version}`
const cratesIoDownloadUrl = version => `${cratesIoOrigin}/api/v1/crates/${CRATE_NAME}/${version}/download`
const cratesIoStaticDownloadUrl = version => `https://static.crates.io/crates/${CRATE_NAME}/${CRATE_NAME}-${version}.crate`

const rustObserverDescriptor = descriptor => {
  releaseSetKeys(descriptor, ['mode', 'version', 'sourceCommit', 'sha256', 'archive', 'reuse', 'prepared'], 'Rust observer descriptor')
  if (!RELEASE_SET_RUST_MODES.includes(descriptor.mode)) fail('Rust observer mode is invalid')
  releaseSetVersion(descriptor.version, 'Rust observer version')
  requireSha(descriptor.sourceCommit, 'Rust observer source commit')
  requireArchiveSha(descriptor.sha256, 'Rust observer archive SHA-256')
  const filename = `${CRATE_NAME}-${descriptor.version}.crate`
  if (descriptor.mode === 'reuse') {
    if (descriptor.archive !== undefined || descriptor.prepared !== undefined) fail('Rust reuse observer descriptor contains publish fields')
    releaseSetKeys(descriptor.reuse, ['registry', 'downloadUrl', 'sourceCommit', 'sha256', 'sizeInBytes', 'yanked'], 'Rust observer reuse')
    requireEqual(descriptor.reuse.registry, 'crates.io', 'Rust observer reuse registry mismatch')
    requireEqual(descriptor.reuse.downloadUrl, cratesIoDownloadUrl(descriptor.version), 'Rust observer reuse URL mismatch')
    requireEqual(descriptor.reuse.sourceCommit, descriptor.sourceCommit, 'Rust observer reuse source mismatch')
    requireEqual(descriptor.reuse.sha256, descriptor.sha256, 'Rust observer reuse checksum mismatch')
    requireEqual(descriptor.reuse.yanked, false, 'Rust observer reuse is yanked')
    if (descriptor.version === CURRENT_RUST_VERSION) {
      requireEqual(descriptor.sourceCommit, RUST_011_REUSE_SOURCE, 'Rust observer 0.11 reuse source mismatch')
      requireEqual(descriptor.sha256, RUST_011_REUSE_SHA256, 'Rust observer 0.11 reuse checksum mismatch')
      requireEqual(descriptor.reuse.sizeInBytes, RUST_011_REUSE_SIZE, 'Rust observer 0.11 reuse size mismatch')
    }
  } else {
    if (descriptor.reuse !== undefined) fail('Rust publish observer descriptor contains reuse fields')
    releaseSetKeys(descriptor.archive, ['filename', 'sha256'], 'Rust observer archive')
    requireEqual(descriptor.archive.filename, filename, 'Rust observer archive filename mismatch')
    requireEqual(descriptor.archive.sha256, descriptor.sha256, 'Rust observer archive checksum mismatch')
  }
  return { mode: descriptor.mode, version: descriptor.version, sourceCommit: descriptor.sourceCommit, sha256: descriptor.sha256, filename }
}

const rustObserverInput = input => {
  releaseSetKeys(input, ['descriptor', 'planSha256', 'preparation', 'observer', 'workDir', 'outputFile', 'recoveryContext'], 'Rust observer input')
  const descriptor = rustObserverDescriptor(input.descriptor)
  if (input.planSha256 !== undefined) requireArchiveSha(input.planSha256, 'Rust observer plan SHA-256')
  if (input.preparation !== undefined) {
    releaseSetKeys(input.preparation, ['sourceCommit', 'runId', 'runAttempt', 'artifactId', 'bindingArtifactId', 'planSha256'], 'Rust observer preparation')
    requireSha(input.preparation.sourceCommit, 'Rust observer preparation source')
    requireFuturePositiveId(input.preparation.runId, 'Rust observer preparation run ID')
    requireFuturePositiveId(input.preparation.runAttempt, 'Rust observer preparation attempt')
    requireFuturePositiveId(input.preparation.artifactId, 'Rust observer preparation artifact ID')
    requireFuturePositiveId(input.preparation.bindingArtifactId, 'Rust observer preparation binding artifact ID')
    requireArchiveSha(input.preparation.planSha256, 'Rust observer preparation plan SHA-256')
    if (input.planSha256 !== undefined) requireEqual(input.preparation.planSha256, input.planSha256, 'Rust observer preparation plan mismatch')
  }
  releaseSetKeys(input.observer, ['runId', 'runAttempt', 'workflowPath', 'sourceCommit'], 'Rust observer context')
  requireFuturePositiveId(input.observer.runId, 'Rust observer run ID')
  requireFuturePositiveId(input.observer.runAttempt, 'Rust observer attempt')
  requireEqual(input.observer.workflowPath, RELEASE_SET_WORKFLOW, 'Rust observer workflow mismatch')
  requireSha(input.observer.sourceCommit, 'Rust observer source')
  if (input.recoveryContext !== undefined) {
    validatePublicationRecoveryContext(input.recoveryContext)
    requireEqual(input.recoveryContext.sourceM, input.preparation.sourceCommit, 'Rust observer recovery source/preparation mismatch')
    requireEqual(input.observer.sourceCommit, input.recoveryContext.controlCommit, 'Rust observer recovery observer source mismatch')
  }
  return { ...input, descriptor }
}

const rustObserverDeadlineRemaining = (now, deadline) => {
  const remaining = deadline - now()
  if (!(remaining > 0)) fail('rust-observe-deadline-exceeded')
  return Math.max(1, Math.ceil(remaining))
}

const rustObserverCheckDeadline = (now, deadline) => {
  if (now() >= deadline) fail('rust-observe-deadline-exceeded')
}

const rustObserverIncomplete = ({ input, metadataUrl, metadataResponse, planSha256 }) => ({
  schemaVersion: 1,
  kind: 'rust-artifact-observation',
  state: 'incomplete',
  complete: false,
  repository: EXPECTED_REPOSITORY,
  repositoryId: EXPECTED_REPOSITORY_ID,
  mode: input.descriptor.mode,
  version: input.descriptor.version,
  planSha256,
  preparation: input.preparation,
  observer: input.observer,
  metadata: { url: metadataUrl, status: metadataResponse.status, bodySha256: sha256Hex(npmResponseBody(metadataResponse)) },
  auth: { requested: false, uploadAttempted: false },
})

/** Observe a crates.io artifact and its actual source archive without publication claims. */
export async function observeRustArtifact(input, adapters = {}) {
  const outputFile = await npmInvalidateOutput(input?.outputFile, input?.workDir, 'Rust observer output file', 'rust-artifact-observation')
  const normalizedInput = rustObserverInput(input)
  const request = adapters.request ?? npmDefaultRequest
  const now = adapters.now ?? (() => performance.now())
  const sleep = adapters.sleep ?? (milliseconds => new Promise(resolve_ => setTimeout(resolve_, milliseconds)))
  const run = adapters.run ?? npmDefaultRun
  const workDir = npmSafePath(input.workDir, 'Rust observer work directory')
  const workEntries = await readdir(workDir, { withFileTypes: true })
  if (workEntries.length !== 0) fail('rust-observe-work-directory-not-fresh')
  const deadline = now() + 600_000
  const headers = { 'user-agent': RELEASE_USER_AGENT, accept: 'application/json' }
  const get = async (url, timeoutMs, accept = 'application/json') => {
    const response = await request(url, { headers: { ...headers, accept }, timeoutMs: Math.min(timeoutMs, rustObserverDeadlineRemaining(now, deadline)), deadline })
    return response
  }
  const fetch404Bounded = async (url, timeoutMs, accept, allowRedirect = false) => {
    let lastResponse
    while (true) {
      if (lastResponse !== undefined && now() >= deadline) return { response: lastResponse, incomplete: true }
      const response = await get(url, timeoutMs, accept)
      lastResponse = response
      if (response.status === 200) return { response, incomplete: false }
      if (allowRedirect && [301, 302, 303, 307, 308].includes(response.status)) return { response, incomplete: false }
      if (response.status !== 404) fail(`rust-observe-http-${response.status}`)
      if (now() >= deadline) return { response, incomplete: true }
      await sleep(Math.min(30_000, rustObserverDeadlineRemaining(now, deadline)))
      if (now() >= deadline) return { response, incomplete: true }
    }
  }
  const version = normalizedInput.descriptor.version
  const metadataUrl = cratesIoMetadataUrl(version)
  const metadataResult = await fetch404Bounded(metadataUrl, 30_000)
  if (metadataResult.incomplete) return rustObserverIncomplete({ input: normalizedInput, metadataUrl, metadataResponse: metadataResult.response, planSha256: input.planSha256 })
  const metadataBody = npmResponseBody(metadataResult.response)
  let metadata
  try { metadata = JSON.parse(metadataBody.toString('utf8')) } catch { fail('rust-observe-metadata-json-invalid') }
  const classification = classifyRegistryResponse({ status: metadataResult.response.status, body: metadataBody.toString('utf8'), expectedVersion: version, expectedChecksum: normalizedInput.descriptor.sha256 })
  if (classification.state !== 'match') fail(`rust-observe-metadata-${classification.state}`)
  const apiDownloadUrl = cratesIoDownloadUrl(version)
  const staticDownloadUrl = cratesIoStaticDownloadUrl(version)
  let currentUrl = apiDownloadUrl
  const redirects = []
  let downloadResponse
  while (true) {
    const result = await fetch404Bounded(currentUrl, 60_000, 'application/octet-stream', true)
    if (result.incomplete) return { ...rustObserverIncomplete({ input: normalizedInput, metadataUrl, metadataResponse: metadataResult.response, planSha256: input.planSha256 }), download: { url: currentUrl, status: result.response.status } }
    downloadResponse = result.response
    if (downloadResponse.status === 200) break
    const location = downloadResponse.headers?.location ?? downloadResponse.headers?.Location
    if (![301, 302, 303, 307, 308].includes(downloadResponse.status) || location !== staticDownloadUrl || redirects.includes(location)) fail('rust-observe-download-redirect-unsafe')
    redirects.push(location)
    currentUrl = location
  }
  rustObserverCheckDeadline(now, deadline)
  const crateBytes = npmResponseBody(downloadResponse)
  const observedSha256 = sha256Hex(crateBytes)
  requireEqual(observedSha256, classification.checksum, 'Rust downloaded digest does not match registry metadata')
  requireEqual(observedSha256, normalizedInput.descriptor.sha256, 'Rust downloaded digest does not match preparation')
  const cratePath = join(workDir, normalizedInput.descriptor.filename)
  await writeFile(cratePath, crateBytes, { flag: 'wx' })
  const archiveExecutor = async (command, arguments_, options = {}) => {
    const result = await npmBoundedExecFile(command, arguments_, { ...options, cwd: options.cwd ?? workDir, env: { PATH: process.env.PATH ?? '', TMPDIR: workDir, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, timeout: Math.min(options.timeout ?? Number.POSITIVE_INFINITY, rustObserverDeadlineRemaining(now, deadline)), killSignal: 'SIGTERM' })
    rustObserverCheckDeadline(now, deadline)
    return result
  }
  const archive = await inspectReleaseSetRustArchiveBytes({ filePath: cratePath, version, sourceCommit: normalizedInput.descriptor.sourceCommit, execution: { execFile: archiveExecutor } })
  rustObserverCheckDeadline(now, deadline)
  const receipt = {
    schemaVersion: 1,
    kind: 'rust-artifact-observation',
    state: 'observed',
    complete: true,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    registry: 'crates.io',
    mode: normalizedInput.descriptor.mode,
    version,
    planSha256: input.planSha256,
    preparation: input.preparation,
    observer: input.observer,
    metadata: { url: metadataUrl, status: metadataResult.response.status, bodySha256: sha256Hex(metadataBody), checksum: classification.checksum, yanked: false },
    download: { requestedUrl: apiDownloadUrl, url: currentUrl, status: downloadResponse.status, redirects, sha256: observedSha256, sizeInBytes: crateBytes.length },
    archive: { filename: normalizedInput.descriptor.filename, sha256: observedSha256, members: archive, sourceCommit: normalizedInput.descriptor.sourceCommit, pathInVcs: 'packages/rust' },
    auth: { requested: false, uploadAttempted: false },
    ...(input.recoveryContext === undefined ? {} : { recoveryContextSha256: input.recoveryContext.contextSha256 }),
    observedAt: new Date().toISOString(),
  }
  const temporaryOutput = `${outputFile}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporaryOutput, `${canonicalJson(receipt)}\n`, { flag: 'wx' })
  await rename(temporaryOutput, outputFile)
  try { rustObserverCheckDeadline(now, deadline) } catch (error) { await rm(outputFile, { force: true }); throw error }
  return receipt
}

const goModuleName = 'github.com/elsoul/erpc-sdk/packages/go'
const goRepositoryUrl = 'https://github.com/elsoul/erpc-sdk'
const goProxyOrigin = 'https://proxy.golang.org'
const goSumOrigin = 'sum.golang.org'
const goObserverMaxPropagationRetries = 20

const goObserverDescriptor = descriptor => {
  releaseSetKeys(descriptor, ['module', 'version', 'tag', 'sourceCommit', 'inventory'], 'Go observer descriptor')
  requireEqual(descriptor.module, goModuleName, 'Go observer module mismatch')
  if (typeof descriptor.version !== 'string' || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(descriptor.version)) fail('Go observer version is invalid')
  requireEqual(descriptor.tag, `packages/go/${descriptor.version}`, 'Go observer tag mismatch')
  requireSha(descriptor.sourceCommit, 'Go observer source commit')
  return { ...descriptor, inventory: validateGoInventory(descriptor.inventory) }
}

const goObserverInput = input => {
  releaseSetKeys(input, ['descriptor', 'planSha256', 'preparation', 'observer', 'workDir', 'outputFile', 'toolPaths'], 'Go observer input')
  const descriptor = goObserverDescriptor(input.descriptor)
  if (input.planSha256 !== undefined) requireArchiveSha(input.planSha256, 'Go observer plan SHA-256')
  if (input.preparation !== undefined) {
    releaseSetKeys(input.preparation, ['sourceCommit', 'runId', 'runAttempt', 'artifactId', 'bindingArtifactId', 'planSha256'], 'Go observer preparation')
    requireSha(input.preparation.sourceCommit, 'Go observer preparation source')
    for (const [value, label] of [[input.preparation.runId, 'Go observer preparation run ID'], [input.preparation.runAttempt, 'Go observer preparation attempt'], [input.preparation.artifactId, 'Go observer preparation artifact ID'], [input.preparation.bindingArtifactId, 'Go observer preparation binding artifact ID']]) requireFuturePositiveId(value, label)
    requireArchiveSha(input.preparation.planSha256, 'Go observer preparation plan SHA-256')
    if (input.planSha256 !== undefined) requireEqual(input.preparation.planSha256, input.planSha256, 'Go observer preparation plan mismatch')
  }
  releaseSetKeys(input.observer, ['runId', 'runAttempt', 'workflowPath', 'sourceCommit'], 'Go observer context')
  requireFuturePositiveId(input.observer.runId, 'Go observer run ID')
  requireFuturePositiveId(input.observer.runAttempt, 'Go observer attempt')
  requireEqual(input.observer.workflowPath, RELEASE_SET_WORKFLOW, 'Go observer workflow mismatch')
  requireSha(input.observer.sourceCommit, 'Go observer source')
  releaseSetKeys(input.toolPaths, ['go', 'git', 'python3'], 'Go observer tool paths')
  for (const [name, value] of Object.entries(input.toolPaths)) npmSafePath(value, `Go observer ${name} path`)
  return { ...input, descriptor }
}

const goObserverRun = async (run, command, arguments_, options, stage, deadlineControl) => {
  const bounded = { ...options, timeout: Math.min(options.timeout ?? Number.POSITIVE_INFINITY, npmDeadlineRemaining(deadlineControl.now, deadlineControl.deadline)), killSignal: 'SIGTERM' }
  let result
  try { result = await run(command, arguments_, bounded) } catch { fail(`go-observe-${stage}-failed`) }
  if (!result || result.exitCode !== 0) fail(`go-observe-${stage}-failed`)
  npmCheckDeadline(deadlineControl.now, deadlineControl.deadline)
  return result
}

const goObserverRunRaw = async (run, command, arguments_, options, stage, deadlineControl) => {
  const bounded = { ...options, timeout: Math.min(options.timeout ?? Number.POSITIVE_INFINITY, npmDeadlineRemaining(deadlineControl.now, deadlineControl.deadline)), killSignal: 'SIGTERM' }
  let result
  try { result = await run(command, arguments_, bounded) } catch (error) { result = { exitCode: 1, stdout: '', stderr: String(error?.message ?? error), processError: true } }
  npmCheckDeadline(deadlineControl.now, deadlineControl.deadline)
  if (!result || typeof result !== 'object') fail(`go-observe-${stage}-failed`)
  return result
}

const goObserverIncomplete = ({ input, sourceCommit, tagRef, stage, status, reason }) => ({
  schemaVersion: 1,
  kind: 'go-public-observation',
  state: 'incomplete',
  complete: false,
  repository: EXPECTED_REPOSITORY,
  repositoryId: EXPECTED_REPOSITORY_ID,
  registry: 'proxy.golang.org',
  module: input.descriptor.module,
  version: input.descriptor.version,
  tag: input.descriptor.tag,
  sourceCommit,
  planSha256: input.planSha256,
  preparation: input.preparation,
  observer: input.observer,
  absence: { stage, status, reason, ref: tagRef },
  auth: { requested: false, uploadAttempted: false },
})

const goObserverSleep = async (sleep, now, deadline, label) => {
  if (now() >= deadline) return false
  const remaining = deadline - now()
  await sleep(Math.min(30_000, Math.max(1, remaining)))
  if (now() >= deadline) return false
  return true
}

const goObserverIs404 = (result, descriptor) => {
  if (result?.processError || result?.exitCode === 0 || typeof result?.stdout !== 'string') return false
  let payload
  try { payload = JSON.parse(result.stdout) } catch { return false }
  if (payload?.Path !== descriptor.module || payload?.Version !== descriptor.version || typeof payload?.Error !== 'string') return false
  const diagnostic = payload.Error.split(/\r?\n/, 1)[0]
  return ['info', 'mod', 'zip'].some(kind => diagnostic === `${descriptor.module}@${descriptor.version}: reading ${goProxyOrigin}/${descriptor.module}/@v/${descriptor.version}.${kind}: 404 Not Found`)
}

const goObserverEnv = ({ root, proxy, goCache, goPath, goEnv, proxyMode }) => ({
  PATH: process.env.PATH ?? '',
  TMPDIR: root,
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  GOPROXY: proxyMode === 'direct' ? 'direct' : goProxyOrigin,
  GOSUMDB: goSumOrigin,
  GOPRIVATE: '',
  GONOPROXY: '',
  GONOSUMDB: '',
  GOPATH: goPath,
  GOMODCACHE: proxy,
  GOCACHE: goCache,
  GOWORK: 'off',
  GOTOOLCHAIN: 'local',
  GOFLAGS: '',
  GOENV: goEnv,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
})

const goObserverJson = (result, stage) => {
  if (!result || typeof result.stdout !== 'string') fail(`go-observe-${stage}-output-invalid`)
  try { return JSON.parse(result.stdout) } catch { fail(`go-observe-${stage}-json-invalid`) }
}

const goObserverPath = async (path, root, label) => {
  if (typeof path !== 'string' || !path.startsWith('/')) fail(`${label} path is not absolute`)
  const canonicalRoot = await realpath(root)
  const canonicalPath = await realpath(path)
  if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) fail(`${label} path escaped isolated root`)
  return canonicalPath
}

const goObserverReceipt = (receipt, descriptor, expectedCommit, root, label) => {
  const required = ['Path', 'Version', 'Info', 'GoMod', 'Zip', 'Dir', 'Sum', 'GoModSum']
  if (receipt?.Error || required.some(key => typeof receipt?.[key] !== 'string' || receipt[key].length === 0) || receipt?.Origin === null || typeof receipt?.Origin !== 'object') fail(`go-observe-${label}-receipt-incomplete`)
  requireEqual(receipt.Path, descriptor.module, `Go ${label} module mismatch`)
  requireEqual(receipt.Version, descriptor.version, `Go ${label} version mismatch`)
  if (receipt.Reuse === true) fail(`Go ${label} reused cached result`)
  const origin = receipt.Origin
  requireEqual(origin?.VCS, 'git', `Go ${label} origin VCS mismatch`)
  requireEqual(origin?.URL, goRepositoryUrl, `Go ${label} origin URL mismatch`)
  requireEqual(origin?.Hash, expectedCommit, `Go ${label} origin source mismatch`)
  requireEqual(origin?.Ref, `refs/tags/${descriptor.tag}`, `Go ${label} origin ref mismatch`)
  requireEqual(origin?.Subdir, 'packages/go', `Go ${label} origin subdirectory mismatch`)
  if (!/^h1:[A-Za-z0-9+/]{43}=?$/.test(receipt.Sum) || !/^h1:[A-Za-z0-9+/]{43}=?$/.test(receipt.GoModSum)) fail(`go-observe-${label}-checksum-invalid`)
  return { ...receipt, origin, root, label }
}

const goObserverZipEvidence = async (zipPath, descriptor, root, execution) => {
  const records = await archiveMemberRecords(zipPath, 'zip', execution)
  const prefix = `${descriptor.module}@${descriptor.version}/`
  const expected = Object.fromEntries(descriptor.inventory.files.map(file => [file.path, file.sha256]))
  const seen = new Map()
  for (const record of records) {
    const member = record.name
    if (member === prefix.slice(0, -1)) continue
    if (!member.startsWith(prefix)) fail('Go module ZIP has an unexpected root')
    const relative = member.slice(prefix.length)
    if (record.type === 'directory' || !relative) continue
    if (seen.has(relative) || expected[relative] === undefined) fail('Go module ZIP member set mismatch')
    const bytes = await commandBuffer('unzip', ['-p', zipPath, member], execution)
    const digest = sha256Hex(bytes)
    requireEqual(digest, expected[relative], `Go module inventory mismatch for ${relative}`)
    seen.set(relative, digest)
  }
  if (seen.size !== Object.keys(expected).length || Object.keys(expected).some(path => !seen.has(path))) fail('Go module ZIP member set mismatch')
  const goModBytes = await commandBuffer('unzip', ['-p', zipPath, `${prefix}go.mod`], execution)
  const goMod = goModBytes.toString('utf8')
  if (!new RegExp(`^module ${goModuleName}$`, 'm').test(goMod)) fail('Go module ZIP go.mod identity mismatch')
  return { members: [...seen.keys()].sort(), inventory: Object.fromEntries([...seen.entries()].sort()), goModSha256: sha256Hex(goModBytes) }
}

/** Observe Go proxy/direct source bytes and run an isolated real consumer. */
export async function observeGoModule(input, adapters = {}) {
  const outputFile = await npmInvalidateOutput(input?.outputFile, input?.workDir, 'Go observer output file', 'go-public-observation')
  const normalized = goObserverInput(input)
  const run = adapters.run ?? npmDefaultRun
  const commitRename = adapters.rename ?? rename
  const now = adapters.now ?? (() => performance.now())
  const sleep = adapters.sleep ?? (milliseconds => new Promise(resolve_ => setTimeout(resolve_, milliseconds)))
  const workDir = npmSafePath(input.workDir, 'Go observer work directory')
  if ((await readdir(workDir, { withFileTypes: true })).length !== 0) fail('go-observe-work-directory-not-fresh')
  const deadline = now() + 600_000
  const deadlineControl = { now, deadline }
  const sourceCommit = normalized.descriptor.sourceCommit
  const tagRef = `refs/tags/${normalized.descriptor.tag}`
  const root = await realpath(workDir)
  const shared = { PATH: process.env.PATH ?? '', TMPDIR: root, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
  const gitRoot = join(root, 'git')
  await mkdir(gitRoot)
  const gitEnv = { ...shared, HOME: join(gitRoot, 'home'), GIT_TERMINAL_PROMPT: '0' }
  await mkdir(gitEnv.HOME)
  const gitCommand = input.toolPaths.git
  const tagRead = async stage => {
    let absentAttempts = 0
    while (true) {
      const result = await goObserverRunRaw(run, gitCommand, ['-C', gitRoot, 'ls-remote', '--refs', goRepositoryUrl, tagRef], { cwd: root, env: gitEnv }, stage, deadlineControl)
      if (result.exitCode !== 0) fail(`go-observe-${stage}-failed`)
      const line = String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
      if (line.length === 0) {
        if (absentAttempts++ >= goObserverMaxPropagationRetries) return goObserverIncomplete({ input: normalized, sourceCommit, tagRef, stage, status: 404, reason: 'tag-absent' })
        if (!await goObserverSleep(sleep, now, deadline, `${stage}-tag-absent`)) return goObserverIncomplete({ input: normalized, sourceCommit, tagRef, stage, status: 404, reason: 'tag-absent' })
        continue
      }
      if (line.length !== 1) fail(`go-observe-${stage}-tag-ambiguous`)
      const [commit, ref] = line[0].split(/\s+/)
      requireEqual(ref, tagRef, `Go ${stage} tag ref mismatch`)
      requireSha(commit, `Go ${stage} tag commit`)
      requireEqual(commit, sourceCommit, `Go ${stage} tag source mismatch`)
      return { commit, ref }
    }
  }
  const tag = await tagRead('tag-initial')
  if (tag?.state === 'incomplete') return tag
  const pythonVersionResult = await goObserverRun(run, input.toolPaths.python3, ['--version'], { cwd: root, env: shared }, 'python-version', deadlineControl)
  const pythonVersion = String(pythonVersionResult.stdout || pythonVersionResult.stderr).trim()
  if (!/^Python 3\.12\./.test(pythonVersion)) fail('go-observe-python-tool-version-mismatch')
  const runtimes = ['proxy', 'direct'].map(kind => {
    const runtimeRoot = join(root, kind)
    const consumer = join(runtimeRoot, 'consumer')
    const goPath = join(runtimeRoot, 'gopath')
    const goCache = join(runtimeRoot, 'gocache')
    const moduleCache = join(runtimeRoot, 'modcache')
    const goEnv = join(runtimeRoot, 'goenv')
    return { kind, runtimeRoot, consumer, goPath, goCache, moduleCache, goEnv, env: goObserverEnv({ root: runtimeRoot, proxy: moduleCache, goCache, goPath, goEnv, proxyMode: kind }) }
  })
  for (const runtime of runtimes) {
    await mkdir(runtime.consumer, { recursive: true }); await mkdir(runtime.goPath, { recursive: true }); await mkdir(runtime.goCache, { recursive: true }); await mkdir(runtime.moduleCache, { recursive: true }); await writeFile(runtime.goEnv, '')
    const version = await goObserverRun(run, input.toolPaths.go, ['version'], { cwd: runtime.consumer, env: runtime.env }, `${runtime.kind}-version`, deadlineControl)
    if (!/^go version go1\.22\./.test(String(version.stdout).trim())) fail(`go-observe-${runtime.kind}-tool-version-mismatch`)
    const runtimeVersion = String(version.stdout).trim()
    await writeFile(join(runtime.consumer, 'go.mod'), `module example.invalid/${runtime.kind}-consumer\n\ngo 1.22\n\nrequire ${normalized.descriptor.module} ${normalized.descriptor.version}\n`)
    let downloaded
    let absentAttempts = 0
    while (true) {
      const rawDownload = await goObserverRunRaw(run, input.toolPaths.go, ['mod', 'download', '-json', `${normalized.descriptor.module}@${normalized.descriptor.version}`], { cwd: runtime.consumer, env: runtime.env }, `${runtime.kind}-download`, deadlineControl)
      if (rawDownload.exitCode === 0) {
        downloaded = rawDownload
        break
      }
      if (!goObserverIs404(rawDownload, normalized.descriptor)) fail(`go-observe-${runtime.kind}-download-failed`)
      if (absentAttempts++ >= goObserverMaxPropagationRetries) return goObserverIncomplete({ input: normalized, sourceCommit, tagRef, stage: `${runtime.kind}-download`, status: 404, reason: 'module-absent' })
      if (!await goObserverSleep(sleep, now, deadline, `${runtime.kind}-download-absent`)) return goObserverIncomplete({ input: normalized, sourceCommit, tagRef, stage: `${runtime.kind}-download`, status: 404, reason: 'module-absent' })
    }
    const receipt = goObserverJson(downloaded, `${runtime.kind}-download`)
    const checked = goObserverReceipt(receipt, normalized.descriptor, sourceCommit, runtime.moduleCache, runtime.kind)
    checked.info = await goObserverPath(receipt.Info, runtime.moduleCache, `${runtime.kind} info`)
    checked.goMod = await goObserverPath(receipt.GoMod, runtime.moduleCache, `${runtime.kind} go.mod`)
    checked.zip = await goObserverPath(receipt.Zip, runtime.moduleCache, `${runtime.kind} ZIP`)
    checked.dir = await goObserverPath(receipt.Dir, runtime.moduleCache, `${runtime.kind} module directory`)
    const infoBytes = await readFile(checked.info)
    let info
    try { info = JSON.parse(infoBytes.toString('utf8')) } catch { fail(`go-observe-${runtime.kind}-info-invalid`) }
    requireEqual(info?.Version, normalized.descriptor.version, `Go ${runtime.kind} info version mismatch`)
    const goMod = await readFile(checked.goMod, 'utf8')
    if (!new RegExp(`^module ${goModuleName}$`, 'm').test(goMod)) fail(`Go ${runtime.kind} go.mod identity mismatch`)
    checked.infoSha256 = sha256Hex(infoBytes)
    checked.goModSha256 = sha256Hex(goMod)
    checked.zipSha256 = sha256Hex(await readFile(checked.zip))
    checked.archive = await goObserverZipEvidence(checked.zip, normalized.descriptor, runtime.moduleCache, { commandMap: { python3: input.toolPaths.python3 }, execFile: async (command, args, options) => npmBoundedExecFile(command, args, { ...options, env: { ...runtime.env, PATH: process.env.PATH ?? '' }, timeout: Math.min(options.timeout ?? Number.POSITIVE_INFINITY, npmDeadlineRemaining(now, deadline)), killSignal: 'SIGTERM' }) })
    requireEqual(checked.goModSha256, checked.archive.goModSha256, `Go ${runtime.kind} go.mod differs from ZIP member`)
    checked.runtime = runtime
    checked.runtimeVersion = runtimeVersion
    runtime.checked = checked
    await writeFile(join(runtime.consumer, 'main.go'), `package main\nimport _ "${normalized.descriptor.module}"\nfunc main() {}\n`)
    await goObserverRun(run, input.toolPaths.go, ['mod', 'tidy'], { cwd: runtime.consumer, env: runtime.env }, `${runtime.kind}-tidy`, deadlineControl)
    await goObserverRun(run, input.toolPaths.go, ['mod', 'download', 'all'], { cwd: runtime.consumer, env: runtime.env }, `${runtime.kind}-download-all`, deadlineControl)
    const consumer = await goObserverRun(run, input.toolPaths.go, ['run', '.'], { cwd: runtime.consumer, env: runtime.env }, `${runtime.kind}-consumer`, deadlineControl)
    runtime.consumerExitCode = consumer.exitCode
    checked.consumerExitCode = consumer.exitCode
  }
  const moved = await tagRead('tag-recheck')
  if (moved?.state === 'incomplete') return moved
  const proxy = runtimes[0].checked; const direct = runtimes[1].checked
  const receipt = { schemaVersion: 1, kind: 'go-public-observation', state: 'observed', complete: true, repository: EXPECTED_REPOSITORY, repositoryId: EXPECTED_REPOSITORY_ID, registry: 'proxy.golang.org', module: normalized.descriptor.module, version: normalized.descriptor.version, tag: normalized.descriptor.tag, sourceCommit, planSha256: input.planSha256, preparation: input.preparation, observer: input.observer, tooling: { pythonVersion }, tag: { ...tag, recheck: moved }, proxy: { runtimeVersion: proxy.runtimeVersion, origin: proxy.origin, infoSha256: proxy.infoSha256, goModSha256: proxy.goModSha256, sum: proxy.Sum, goModSum: proxy.GoModSum, zipSha256: proxy.zipSha256, members: proxy.archive.members, inventory: proxy.archive.inventory, consumerExitCode: proxy.consumerExitCode }, direct: { runtimeVersion: direct.runtimeVersion, origin: direct.origin, infoSha256: direct.infoSha256, goModSha256: direct.goModSha256, sum: direct.Sum, goModSum: direct.GoModSum, zipSha256: direct.zipSha256, members: direct.archive.members, inventory: direct.archive.inventory, consumerExitCode: direct.consumerExitCode }, auth: { requested: false, uploadAttempted: false }, observedAt: new Date().toISOString() }
  if (canonicalJson(proxy.archive.inventory) !== canonicalJson(direct.archive.inventory) || proxy.Sum !== direct.Sum || proxy.GoModSum !== direct.GoModSum) fail('go-observe-proxy-direct-semantic-mismatch')
  const temporaryOutput = `${outputFile}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  try {
    npmCheckDeadline(now, deadline)
    await writeFile(temporaryOutput, `${canonicalJson(receipt)}\n`, { flag: 'wx' })
    npmCheckDeadline(now, deadline)
    await commitRename(temporaryOutput, outputFile)
    npmCheckDeadline(now, deadline)
  } catch (error) {
    await rm(temporaryOutput, { force: true }).catch(() => {})
    await rm(outputFile, { force: true }).catch(() => {})
    throw error
  }
  return receipt
}

const githubApiOrigin = 'https://api.github.com'
const githubAllowedRedirectHosts = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com'])
const githubDynamicProofRoles = new Set(['go-proof', 'npm-proof', 'pypi-proof', 'rubygems-proof', 'rust-proof', 'tag-proof', 'release-set-proof-manifest'])
const githubRedirectHostAllowed = hostname => githubAllowedRedirectHosts.has(hostname) || (hostname.endsWith('.blob.core.windows.net') && hostname.length > '.blob.core.windows.net'.length)

const releaseSetReceiptRole = filename => {
  if (!RELEASE_SET_RECEIPT_FILENAMES.includes(filename)) fail(`Unknown release-set receipt filename ${filename}`)
  return RELEASE_SET_RECEIPT_ARTIFACT_ROLES[filename]
}

const releaseSetReceiptArtifactName = (filename, runId, runAttempt) =>
  `release-set-${releaseSetReceiptRole(filename)}-${runId}-${runAttempt}`

const releaseSetSnapshotArtifactName = (runId, runAttempt) =>
  `release-set-proof-receipts-${runId}-${runAttempt}`

const releaseSetCheckpointArtifactName = (runId, runAttempt) =>
  `release-set-proof-manifest-${runId}-${runAttempt}`

const releaseSetRunIdentity = (value, label = 'Release-set producer') => {
  releaseSetKeys(value, ['repository', 'repositoryId', 'workflowPath', 'sourceCommit', 'runId', 'runAttempt', 'ref', 'event'], label)
  requireEqual(value.repository, EXPECTED_REPOSITORY, `${label} repository mismatch`)
  requireEqual(String(value.repositoryId), EXPECTED_REPOSITORY_ID, `${label} repository ID mismatch`)
  requireEqual(value.workflowPath, RELEASE_SET_WORKFLOW, `${label} workflow mismatch`)
  requireSha(value.sourceCommit, `${label} source commit`)
  requireFuturePositiveId(value.runId, `${label} run ID`)
  requireFuturePositiveId(value.runAttempt, `${label} attempt`)
  requireEqual(value.ref, 'refs/heads/main', `${label} ref mismatch`)
  requireEqual(value.event, 'workflow_dispatch', `${label} event mismatch`)
  return { ...value, repositoryId: String(value.repositoryId), runId: String(value.runId), runAttempt: String(value.runAttempt) }
}

const releaseSetArtifactBinding = (value, label = 'Release-set artifact binding') => {
  releaseSetKeys(value, ['artifactId', 'artifactName', 'sha256', 'sizeInBytes', 'producer'], label)
  const artifactId = requireFuturePositiveId(value.artifactId, `${label} ID`)
  releaseSetString(value.artifactName, `${label} name`)
  const sha256 = requireArchiveSha(value.sha256, `${label} SHA-256`)
  if (!Number.isSafeInteger(value.sizeInBytes) || value.sizeInBytes <= 0) fail(`${label} size is invalid`)
  const producer = releaseSetRunIdentity(value.producer, `${label} producer`)
  return { artifactId, artifactName: value.artifactName, sha256, sizeInBytes: value.sizeInBytes, producer }
}

const releaseSetPreparationTuple = (value, label = 'Release-set preparation') => {
  releaseSetKeys(value, ['sourceCommit', 'runId', 'runAttempt', 'artifactId', 'bindingArtifactId', 'planSha256'], label)
  requireSha(value.sourceCommit, `${label} source commit`)
  for (const [field, text] of [['runId', 'run ID'], ['runAttempt', 'attempt'], ['artifactId', 'artifact ID'], ['bindingArtifactId', 'binding artifact ID']]) requireFuturePositiveId(value[field], `${label} ${text}`)
  requireArchiveSha(value.planSha256, `${label} plan SHA-256`)
  return { ...value, runId: String(value.runId), runAttempt: String(value.runAttempt), artifactId: String(value.artifactId), bindingArtifactId: String(value.bindingArtifactId) }
}

const releaseSetManifestKeys = [
  'schemaVersion', 'kind', 'repository', 'repositoryId', 'sourceCommit', 'versions',
  'planSha256', 'preparation', 'snapshot', 'receipts', 'receiptArtifacts', 'state',
]

const releaseSetTagRead = (value, label) => {
  releaseSetKeys(value, ['ref', 'type', 'sha', 'recheck'], label)
  requireEqual(value.type, 'commit', `${label} type mismatch`)
  requireSha(value.sha, `${label} commit`)
  releaseSetKeys(value.recheck, ['ref', 'type', 'sha'], `${label} recheck`)
  requireEqual(value.recheck.ref, value.ref, `${label} recheck ref mismatch`)
  requireEqual(value.recheck.type, 'commit', `${label} recheck type mismatch`)
  requireEqual(value.recheck.sha, value.sha, `${label} recheck commit mismatch`)
  return value
}

const releaseSetValidateRunRecord = (run, identity, { current = false } = {}) => {
  const expected = releaseSetRunIdentity(identity, 'Release-set run identity')
  requireEqual(run?.id, Number(expected.runId), 'Release-set run ID mismatch')
  requireEqual(run?.run_attempt, Number(expected.runAttempt), 'Release-set run attempt mismatch')
  requireEqual(run?.repository?.full_name, EXPECTED_REPOSITORY, 'Release-set run repository mismatch')
  requireEqual(String(run?.repository?.id), EXPECTED_REPOSITORY_ID, 'Release-set run repository ID mismatch')
  requireEqual(run?.head_sha, expected.sourceCommit, 'Release-set run source mismatch')
  requireEqual(run?.head_branch, 'main', 'Release-set run branch mismatch')
  requireEqual(run?.event, 'workflow_dispatch', 'Release-set run event mismatch')
  if (run?.path !== undefined) requireEqual(run.path, RELEASE_SET_WORKFLOW, 'Release-set run workflow mismatch')
  if (run?.status === 'completed') {
    if (!['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'skipped'].includes(run.conclusion)) fail('Release-set terminal run conclusion is invalid')
  } else if (current && run?.status === 'in_progress' && run?.conclusion == null) {
    // The current immutable source artifact may be observed while its producer is running.
  } else {
    fail('Release-set producer run is active or incomplete')
  }
  return { id: Number(expected.runId), runAttempt: Number(expected.runAttempt), status: run.status, conclusion: run.conclusion ?? null }
}

const releaseSetAssertBindingIdentity = (binding, expected) => {
  const normalized = releaseSetArtifactBinding(binding)
  requireEqual(normalized.artifactId, String(expected.artifactId), 'Release-set artifact binding ID mismatch')
  requireEqual(normalized.artifactName, expected.artifactName, 'Release-set artifact binding name mismatch')
  requireEqual(normalized.sha256, expected.sha256, 'Release-set artifact binding digest mismatch')
  requireEqual(normalized.sizeInBytes, expected.sizeInBytes, 'Release-set artifact binding size mismatch')
  requireEqual(canonicalJson(normalized.producer), canonicalJson(releaseSetRunIdentity(expected.producer, 'Release-set expected producer')), 'Release-set artifact producer mismatch')
  return normalized
}

/** Read only the explicitly inherited descriptor used by the completion job. */
export async function readReleaseSetGithubReadTokenFd(fdValue = process.env.RELEASE_SET_GITHUB_READ_TOKEN_FD) {
  if (typeof fdValue !== 'string' || !/^(?:[3-9]|[1-9][0-9]{1,9})$/.test(fdValue)) fail('Release-set GitHub read capability FD is invalid')
  const fd = Number(fdValue)
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 2147483647) fail('Release-set GitHub read capability FD is invalid')
  const path = `/dev/fd/${fd}`
  let content
  let timeoutId
  const controller = new AbortController()
  try {
    content = await Promise.race([
      readFile(path, { encoding: 'utf8', signal: controller.signal }),
      new Promise((_, reject) => { timeoutId = setTimeout(() => { controller.abort(); reject(new Error('capability-timeout')) }, 5_000) }),
    ])
  } catch {
    fail('Release-set GitHub read capability is unavailable')
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    try { closeSync(fd) } catch {}
  }
  const token = String(content).replace(/\n$/, '')
  if (token.length === 0 || token.length > 8192 || /[^\x21-\x7e]/.test(token) || /\s/.test(token)) fail('Release-set GitHub read capability is malformed')
  return token
}

const githubCapabilityRequest = (request, token) => async (url, options = {}) => {
  const parsed = (() => { try { return new URL(url) } catch { return undefined } })()
  const canonical = parsed?.protocol === 'https:' && parsed.origin === githubApiOrigin && parsed.pathname.startsWith(`/repos/${EXPECTED_REPOSITORY}/`)
  if (options.method !== undefined && options.method !== 'GET') fail('Release-set GitHub observer allows GET only')
  const headers = { ...(options.headers ?? {}) }
  if (canonical) headers.authorization = `Bearer ${token}`
  else delete headers.authorization
  return request(url, { ...options, method: 'GET', headers })
}

const releaseSetObserverIdentity = (observer, sourceCommit) => {
  releaseSetKeys(observer, ['runId', 'runAttempt', 'workflowPath', 'sourceCommit', 'repository', 'repositoryId', 'ref', 'event'], 'Release-set current observer')
  const identity = {
    repository: observer.repository ?? EXPECTED_REPOSITORY,
    repositoryId: observer.repositoryId ?? EXPECTED_REPOSITORY_ID,
    workflowPath: observer.workflowPath,
    sourceCommit: observer.sourceCommit ?? sourceCommit,
    runId: observer.runId,
    runAttempt: observer.runAttempt,
    ref: observer.ref ?? 'refs/heads/main',
    event: observer.event ?? 'workflow_dispatch',
  }
  return releaseSetRunIdentity(identity, 'Release-set current observer')
}

const githubObserverApiJson = async (request, url, deadlineControl, stage) => {
  const response = await githubObserverRequest(request, url, deadlineControl, stage)
  if (response.status !== 200) fail(`github-observe-${stage}-http-${response.status}`)
  return githubObserverJson(response, stage)
}

const githubArtifactZipBytes = async (request, artifactId, deadlineControl, stage) => {
  const initial = `${githubApiOrigin}/repos/${EXPECTED_REPOSITORY}/actions/artifacts/${artifactId}/zip`
  let current = initial
  const redirects = []
  for (let index = 0; index < 4; index += 1) {
    const response = await githubObserverRequest(request, current, deadlineControl, `${stage}-${index + 1}`, 'application/vnd.github+json')
    if (response.status === 200) return { bytes: npmResponseBody(response), redirects }
    if (![301, 302, 303, 307, 308].includes(response.status)) fail(`github-observe-${stage}-http-${response.status}`)
    const location = response.headers?.location ?? response.headers?.Location
    let target
    try { target = new URL(location, current) } catch { fail(`github-observe-${stage}-redirect-invalid`) }
    const currentOrigin = new URL(current).origin
    if (target.protocol !== 'https:' || (!githubRedirectHostAllowed(target.hostname) && target.origin !== currentOrigin) || redirects.includes(target.href)) fail(`github-observe-${stage}-redirect-unsafe`)
    redirects.push(target.href)
    current = target.href
  }
  fail(`github-observe-${stage}-redirect-limit`)
}

const githubArtifactMetadata = async (request, binding, deadlineControl, expectedProducer, stage) => {
  const checked = releaseSetArtifactBinding(binding, `Release-set ${stage} binding`)
  const url = `${githubApiOrigin}/repos/${EXPECTED_REPOSITORY}/actions/artifacts/${checked.artifactId}`
  const metadata = await githubObserverApiJson(request, url, deadlineControl, `${stage}-metadata`)
  requireEqual(metadata?.id, Number(checked.artifactId), `Release-set ${stage} returned artifact ID mismatch`)
  requireEqual(metadata?.name, checked.artifactName, `Release-set ${stage} returned artifact name mismatch`)
  requireEqual(metadata?.expired, false, `Release-set ${stage} artifact is expired`)
  if (!Number.isSafeInteger(metadata?.size_in_bytes) || metadata.size_in_bytes <= 0) fail(`Release-set ${stage} artifact size is invalid`)
  requireEqual(metadata.size_in_bytes, checked.sizeInBytes, `Release-set ${stage} artifact size mismatch`)
  requireEqual(metadata?.digest, `sha256:${checked.sha256}`, `Release-set ${stage} artifact digest mismatch`)
  requireEqual(metadata?.archive_download_url, `${githubApiOrigin}/repos/${EXPECTED_REPOSITORY}/actions/artifacts/${checked.artifactId}/zip`, `Release-set ${stage} artifact URL mismatch`)
  requireEqual(metadata?.workflow_run?.id, Number(checked.producer.runId), `Release-set ${stage} producer run mismatch`)
  requireEqual(String(metadata?.workflow_run?.repository_id), EXPECTED_REPOSITORY_ID, `Release-set ${stage} producer repository mismatch`)
  if (metadata?.workflow_run?.head_repository_id !== undefined) requireEqual(String(metadata.workflow_run.head_repository_id), EXPECTED_REPOSITORY_ID, `Release-set ${stage} producer source repository mismatch`)
  requireEqual(metadata?.workflow_run?.head_sha, checked.producer.sourceCommit, `Release-set ${stage} producer source mismatch`)
  requireEqual(metadata?.workflow_run?.head_branch, 'main', `Release-set ${stage} producer branch mismatch`)
  if (metadata?.workflow_run?.path !== undefined) requireEqual(metadata.workflow_run.path, RELEASE_SET_WORKFLOW, `Release-set ${stage} producer workflow mismatch`)
  if (expectedProducer !== undefined) requireEqual(canonicalJson(checked.producer), canonicalJson(releaseSetRunIdentity(expectedProducer, `Release-set ${stage} expected producer`)), `Release-set ${stage} producer identity mismatch`)
  return { binding: checked, metadata }
}

const githubArtifactMembers = async (zipBytes, workDir, expectedNames, stage) => {
  const zipFile = join(workDir, `${stage}-${process.pid}-${Math.random().toString(16).slice(2)}.zip`)
  await writeFile(zipFile, zipBytes, { flag: 'wx' })
  const members = await archiveMemberRecords(zipFile, 'zip')
  const expected = [...expectedNames]
  if (members.length !== expected.length || members.some(member => member.type !== 'file') || members.some(member => !expected.includes(member.name)) || new Set(members.map(member => member.name)).size !== members.length) fail(`Release-set ${stage} ZIP members do not match the exact receipt layout`)
  const bytes = new Map()
  for (const member of members) bytes.set(member.name, await commandBuffer('unzip', ['-p', zipFile, member.name]))
  return { zipFile, members: members.map(member => member.name).sort(), bytes }
}

const releaseSetReceiptObserver = (value, label, plan, { observerSourceCommit = plan.sourceCommit } = {}) => {
  releaseSetKeys(value, ['runId', 'runAttempt', 'workflowPath', 'sourceCommit'], label)
  requireFuturePositiveId(value.runId, `${label} run ID`)
  requireFuturePositiveId(value.runAttempt, `${label} attempt`)
  requireEqual(value.workflowPath, RELEASE_SET_WORKFLOW, `${label} workflow mismatch`)
  requireEqual(value.sourceCommit, observerSourceCommit, `${label} source mismatch`)
  return { repository: EXPECTED_REPOSITORY, repositoryId: EXPECTED_REPOSITORY_ID, workflowPath: RELEASE_SET_WORKFLOW, sourceCommit: value.sourceCommit, runId: String(value.runId), runAttempt: String(value.runAttempt), ref: 'refs/heads/main', event: 'workflow_dispatch' }
}

const validateReleaseSetRecoveryOptions = (options = {}) => {
  const recoveryOverrideKeys = ['context', 'contextSha256', 'observerSourceCommit', 'observerSources', 'publisherSources', 'historicalReceiptFiles']
  if (options.recovery !== true) {
    if (recoveryOverrideKeys.some(key => options[key] !== undefined)) fail('Release-set recovery overrides require recovery mode with the validated publication recovery context')
    return options
  }
  if (options.context === undefined) fail('Release-set recovery requires the validated publication recovery context')
  const suppliedContext = options.context
  const context = validatePublicationRecoveryContext(suppliedContext, { requireCiProof: true })
  requireArchiveSha(options.contextSha256, 'Release-set recovery context hash')
  requireEqual(options.contextSha256, context.contextSha256, 'Release-set recovery context hash is not authenticated')
  requireEqual(options.observerSourceCommit, context.controlCommit, 'Release-set recovery observer source is not authenticated')
  for (const [label, sources] of [['observer', options.observerSources], ['publisher', options.publisherSources]]) {
    if (sources === undefined) continue
    releaseSetObject(sources, `Release-set recovery ${label} source map`)
    for (const source of Object.values(sources)) requireEqual(source === context.controlCommit || source === context.sourceM, true, `Release-set recovery ${label} source is outside the authenticated M/C cohort`)
  }
  return { ...options, context: suppliedContext, contextSha256: context.contextSha256, observerSourceCommit: context.controlCommit }
}

const releaseSetReceiptCommon = (receipt, kind, plan, preparation, options = {}) => {
  options = validateReleaseSetRecoveryOptions(options)
  if (options.recovery) {
    requireArchiveSha(options.contextSha256, `${kind} recovery context hash`)
    requireSha(options.observerSourceCommit, `${kind} recovery observer source`)
  }
  releaseSetObject(receipt, `${kind} release receipt`)
  for (const key of ['schemaVersion', 'kind', 'state', 'repository', 'repositoryId', 'planSha256', 'preparation', 'observer', 'auth', 'observedAt']) if (!Object.hasOwn(receipt, key)) fail(`${kind} release receipt is missing ${key}`)
  requireEqual(receipt.schemaVersion, 1, `${kind} receipt schema mismatch`)
  requireEqual(receipt.kind, kind, `${kind} receipt kind mismatch`)
  requireEqual(receipt.state, 'observed', `${kind} receipt state is incomplete`)
  requireEqual(receipt.repository, EXPECTED_REPOSITORY, `${kind} receipt repository mismatch`)
  requireEqual(String(receipt.repositoryId), EXPECTED_REPOSITORY_ID, `${kind} receipt repository ID mismatch`)
  requireEqual(receipt.planSha256, releaseSetPlanDigest(plan), `${kind} receipt plan mismatch`)
  const checkedPreparation = releaseSetPreparationTuple(receipt.preparation, `${kind} receipt preparation`)
  requireEqual(canonicalJson(checkedPreparation), canonicalJson(releaseSetPreparationTuple(preparation, `${kind} expected preparation`)), `${kind} receipt preparation mismatch`)
  const observer = releaseSetReceiptObserver(receipt.observer, `${kind} receipt observer`, plan, { ...options, observerSourceCommit: options.observerSources?.[kind === 'rubygems-public-observation' ? 'rubygems-proof.json' : kind === 'npm-public-observation' ? 'npm-proof.json' : kind === 'pypi-public-observation' ? 'pypi-proof.json' : kind === 'rust-artifact-observation' ? 'rust-proof.json' : kind === 'tag-public-observation' ? 'tag-proof.json' : 'go-proof.json'] ?? options.observerSourceCommit })
  releaseSetKeys(receipt.auth, ['requested', 'uploadAttempted', ...(options.recovery && kind === 'pypi-public-observation' ? ['uploadOutcome'] : [])], `${kind} receipt auth`)
  if (options.recovery && kind === 'pypi-public-observation') {
    requireEqual(receipt.auth.requested === true || receipt.auth.requested === false, true, `${kind} receipt auth state is malformed`)
    requireEqual(receipt.auth.uploadAttempted, receipt.auth.requested, `${kind} receipt upload/auth state mismatch`)
  } else {
    requireEqual(receipt.auth.requested, false, `${kind} receipt requested credentials`)
    requireEqual(receipt.auth.uploadAttempted, false, `${kind} receipt attempted an upload`)
  }
  if (typeof receipt.observedAt !== 'string' || Number.isNaN(Date.parse(receipt.observedAt))) fail(`${kind} receipt timestamp is invalid`)
  if (options.recovery) {
    const filename = kind === 'rubygems-public-observation' ? 'rubygems-proof.json' : kind === 'npm-public-observation' ? 'npm-proof.json' : kind === 'pypi-public-observation' ? 'pypi-proof.json' : kind === 'rust-artifact-observation' ? 'rust-proof.json' : kind === 'tag-public-observation' ? 'tag-proof.json' : 'go-proof.json'
    const historical = options.historicalReceiptFiles?.includes(filename) === true
    if (receipt.recoveryContextSha256 === undefined) {
      if (!historical || options.observerSources?.[filename] !== plan.sourceCommit) fail(`${kind} receipt lacks an authenticated recovery context`)
    } else requireEqual(receipt.recoveryContextSha256, options.contextSha256, `${kind} receipt recovery context mismatch`)
  }
  return { observer, preparation: checkedPreparation }
}

const releaseSetExpectedGoInventory = plan => Object.fromEntries(plan.go.inventory.files.map(file => [file.path, file.sha256]))

const releaseSetValidateReceipt = (receipt, filename, { plan, preparation, recoveryOptions = {} }) => {
  const artifactByKind = Object.fromEntries(plan.artifacts.map(artifact => [artifact.kind, artifact]))
  if (filename === 'npm-proof.json') {
    releaseSetKeys(receipt, ['schemaVersion', 'kind', 'state', 'repository', 'repositoryId', 'planSha256', 'preparation', 'observer', 'auth', 'observedAt', 'descriptor', 'registry', 'publisher', 'provenance', 'toolVersions', 'consumer', ...(recoveryOptions.recovery ? ['recoveryContextSha256'] : [])], 'npm receipt')
    releaseSetReceiptCommon(receipt, 'npm-public-observation', plan, preparation, recoveryOptions)
    releaseSetKeys(receipt.descriptor, ['kind', 'filename', 'name', 'version', 'expectedSha256', 'observedSha256', 'observedSRI'], 'npm receipt descriptor')
    const expected = artifactByKind.npm
    requireEqual(receipt.descriptor.kind, expected.kind, 'npm receipt descriptor kind mismatch')
    requireEqual(receipt.descriptor.filename, expected.filename, 'npm receipt descriptor filename mismatch')
    requireEqual(receipt.descriptor.name, expected.name, 'npm receipt descriptor name mismatch')
    requireEqual(receipt.descriptor.version, expected.version, 'npm receipt descriptor version mismatch')
    requireEqual(receipt.descriptor.expectedSha256, expected.sha256, 'npm receipt prepared digest mismatch')
    requireEqual(receipt.descriptor.observedSha256, expected.sha256, 'npm receipt observed digest mismatch')
    releaseSetKeys(receipt.publisher, ['repository', 'repositoryId', 'sourceCommit', 'workflowPath', 'ref', 'event', 'environment', 'publisherRunId', 'publisherAttempt', 'invocation'], 'npm receipt publisher')
    requireEqual(receipt.publisher.repository, EXPECTED_REPOSITORY, 'npm receipt publisher repository mismatch')
    requireEqual(String(receipt.publisher.repositoryId), EXPECTED_REPOSITORY_ID, 'npm receipt publisher repository ID mismatch')
    requireEqual(receipt.publisher.sourceCommit, plan.sourceCommit, 'npm receipt publisher source mismatch')
    requireEqual(receipt.publisher.workflowPath, RELEASE_SET_WORKFLOW, 'npm receipt publisher workflow mismatch')
    requireEqual(receipt.publisher.ref, 'refs/heads/main', 'npm receipt publisher ref mismatch')
    requireEqual(receipt.publisher.event, 'workflow_dispatch', 'npm receipt publisher event mismatch')
    requireEqual(receipt.publisher.environment, 'npm', 'npm receipt publisher environment mismatch')
    requireFuturePositiveId(receipt.publisher.publisherRunId, 'npm receipt publisher run ID')
    requireFuturePositiveId(receipt.publisher.publisherAttempt, 'npm receipt publisher attempt')
    requireEqual(receipt.provenance?.invocation, receipt.publisher.invocation, 'npm receipt invocation mismatch')
    requireEqual(receipt.provenance?.certificateClaims?.['1.3.6.1.4.1.57264.1.13'], plan.sourceCommit, 'npm receipt provenance source mismatch')
    requireEqual(receipt.provenance?.certificateClaims?.['1.3.6.1.4.1.57264.1.20'], 'workflow_dispatch', 'npm receipt provenance event mismatch')
    requireEqual(receipt.provenance?.certificateClaims?.['1.3.6.1.4.1.57264.1.21'], receipt.publisher.invocation, 'npm receipt provenance invocation mismatch')
    if (receipt.consumer?.audit?.exitCode !== 0 || receipt.consumer?.audit?.invalid !== 0 || receipt.consumer?.audit?.missing !== 0 || !(receipt.consumer?.audit?.verifiedTargetCount > 0) || receipt.consumer?.smoke?.exitCodes?.install !== 0 || receipt.consumer?.smoke?.exitCodes?.require !== 0 || receipt.consumer?.smoke?.exitCodes?.import !== 0) fail('npm receipt consumer proof is incomplete')
  } else if (filename === 'pypi-proof.json') {
    releaseSetKeys(receipt, ['schemaVersion', 'kind', 'state', 'complete', 'repository', 'repositoryId', 'planSha256', 'preparation', 'observer', 'auth', 'observedAt', 'version', 'publishers', 'metadata', 'files', 'consumers', ...(recoveryOptions.recovery ? ['recoveryContextSha256'] : [])], 'PyPI receipt')
    releaseSetReceiptCommon(receipt, 'pypi-public-observation', plan, preparation, recoveryOptions)
    requireEqual(receipt.complete, true, 'PyPI receipt is incomplete')
    requireEqual(receipt.version, plan.versions.nonRustVersion, 'PyPI receipt version mismatch')
    const expectedFiles = new Map(plan.artifacts.filter(artifact => artifact.kind.startsWith('pypi')).map(artifact => [artifact.filename, artifact]))
    if (!Array.isArray(receipt.files) || receipt.files.length !== expectedFiles.size || !receipt.publishers || typeof receipt.publishers !== 'object') fail('PyPI receipt file set is incomplete')
    const seen = new Set()
    for (const file of receipt.files) {
      releaseSetKeys(file, ['filename', 'kind', 'url', 'sha256', 'provenanceUrl', 'certificateClaims', 'environmentClaimsPresent', 'subject', 'publisher'], 'PyPI receipt file')
      if (seen.has(file.filename) || !expectedFiles.has(file.filename)) fail('PyPI receipt file set is invalid')
      seen.add(file.filename)
      requireEqual(file.sha256, expectedFiles.get(file.filename).sha256, `PyPI receipt ${file.filename} digest mismatch`)
      requireEqual(receipt.publishers[file.filename] !== undefined, true, `PyPI receipt ${file.filename} publisher missing`)
      requireEqual(canonicalJson(file.publisher), canonicalJson(receipt.publishers[file.filename]), `PyPI receipt ${file.filename} publisher mismatch`)
      if (recoveryOptions.recovery) {
        const expectedPublisher = recoveryOptions.publisherSources?.[file.filename]
        if (expectedPublisher !== undefined) requireEqual(file.publisher.sourceCommit, expectedPublisher, `PyPI receipt ${file.filename} publisher source mismatch`)
        else requireEqual(file.publisher.sourceCommit === plan.sourceCommit || file.publisher.sourceCommit === recoveryOptions.observerSourceCommit, true, `PyPI receipt ${file.filename} publisher source is outside M/C`)
        requireFuturePositiveId(file.publisher.publisherRunId, `PyPI receipt ${file.filename} publisher run ID`)
        requireFuturePositiveId(file.publisher.publisherAttempt, `PyPI receipt ${file.filename} publisher attempt`)
        requireEqual(file.certificateClaims?.['1.3.6.1.4.1.57264.1.13'], file.publisher.sourceCommit, `PyPI receipt ${file.filename} certificate source mismatch`)
      }
    }
    if (seen.size !== expectedFiles.size || receipt.consumers?.wheel?.exitCode !== 0 || receipt.consumers?.sdist?.exitCode !== 0) fail('PyPI receipt consumer proof is incomplete')
  } else if (filename === 'rubygems-proof.json') {
    releaseSetKeys(receipt, ['schemaVersion', 'kind', 'state', 'complete', 'repository', 'repositoryId', 'planSha256', 'preparation', 'observer', 'auth', 'observedAt', 'version', 'metadata', 'download', 'archive', 'consumers', ...(recoveryOptions.recovery ? ['recoveryContextSha256'] : [])], 'RubyGems receipt')
    releaseSetReceiptCommon(receipt, 'rubygems-public-observation', plan, preparation, recoveryOptions)
    requireEqual(receipt.complete, true, 'RubyGems receipt is incomplete')
    requireEqual(receipt.version, plan.versions.nonRustVersion, 'RubyGems receipt version mismatch')
    const expected = artifactByKind.rubygems
    requireEqual(receipt.archive?.filename, expected.filename, 'RubyGems receipt filename mismatch')
    requireEqual(receipt.archive?.sha256, expected.sha256, 'RubyGems receipt digest mismatch')
    if (!Array.isArray(receipt.archive?.members)) fail('RubyGems receipt member evidence is missing')
    releaseSetMemberSet(receipt.archive.members, expected.files, 'RubyGems receipt archive')
    for (const runtime of ['ruby31', 'ruby34']) {
      const proof = receipt.consumers?.[runtime]
      if (proof?.exitCode !== 0 || proof.base64Version !== '0.2.0' || proof.digestKeccakVersion !== '0.0.7' || !Array.isArray(proof.nativeExtensionFiles) || proof.nativeExtensionFiles.length === 0) fail(`RubyGems receipt ${runtime} consumer proof is incomplete`)
    }
  } else if (filename === 'rust-proof.json') {
    releaseSetKeys(receipt, ['schemaVersion', 'kind', 'state', 'complete', 'repository', 'repositoryId', 'planSha256', 'preparation', 'observer', 'auth', 'observedAt', 'registry', 'mode', 'version', 'metadata', 'download', 'archive', ...(recoveryOptions.recovery ? ['recoveryContextSha256'] : [])], 'Rust receipt')
    releaseSetReceiptCommon(receipt, 'rust-artifact-observation', plan, preparation, recoveryOptions)
    requireEqual(receipt.complete, true, 'Rust receipt is incomplete')
    requireEqual(receipt.registry, 'crates.io', 'Rust receipt registry mismatch')
    requireEqual(receipt.mode, plan.rust.mode, 'Rust receipt mode mismatch')
    requireEqual(receipt.version, plan.rust.version, 'Rust receipt version mismatch')
    requireEqual(receipt.metadata?.checksum, plan.rust.sha256, 'Rust receipt metadata checksum mismatch')
    requireEqual(receipt.metadata?.yanked, false, 'Rust receipt yanked state mismatch')
    requireEqual(receipt.download?.sha256, plan.rust.sha256, 'Rust receipt download digest mismatch')
    requireEqual(receipt.archive?.sha256, plan.rust.sha256, 'Rust receipt archive digest mismatch')
    if (plan.rust.reuse?.sizeInBytes !== undefined) requireEqual(receipt.download?.sizeInBytes, plan.rust.reuse.sizeInBytes, 'Rust receipt download size mismatch')
    if (plan.rust.mode === 'reuse') requireEqual(receipt.archive?.sourceCommit, plan.rust.sourceCommit, 'Rust receipt reuse source mismatch')
  } else if (filename === 'tag-proof.json') {
    releaseSetKeys(receipt, ['schemaVersion', 'kind', 'state', 'complete', 'repository', 'repositoryId', 'planSha256', 'preparation', 'observer', 'auth', 'observedAt', 'tags', ...(recoveryOptions.recovery ? ['recoveryContextSha256'] : [])], 'Tag receipt')
    releaseSetReceiptCommon(receipt, 'tag-public-observation', plan, preparation, recoveryOptions)
    requireEqual(receipt.complete, true, 'Tag receipt is incomplete')
    releaseSetTagRead(receipt.tags?.release, 'Release tag receipt')
    releaseSetTagRead(receipt.tags?.go, 'Go tag receipt')
    requireEqual(receipt.tags.release.ref, `refs/tags/${plan.tags.release}`, 'Release tag receipt ref mismatch')
    requireEqual(receipt.tags.go.ref, `refs/tags/${plan.tags.go}`, 'Go tag receipt ref mismatch')
    requireEqual(receipt.tags.release.sha, plan.sourceCommit, 'Release tag receipt source mismatch')
    requireEqual(receipt.tags.go.sha, plan.sourceCommit, 'Go tag receipt source mismatch')
  } else if (filename === 'go-proof.json') {
    releaseSetKeys(receipt, ['schemaVersion', 'kind', 'state', 'complete', 'repository', 'repositoryId', 'registry', 'module', 'version', 'tag', 'sourceCommit', 'planSha256', 'preparation', 'observer', 'tooling', 'proxy', 'direct', 'auth', 'observedAt', ...(recoveryOptions.recovery ? ['recoveryContextSha256'] : [])], 'Go receipt')
    releaseSetReceiptCommon(receipt, 'go-public-observation', plan, preparation, recoveryOptions)
    requireEqual(receipt.complete, true, 'Go receipt is incomplete')
    requireEqual(receipt.module, plan.go.module, 'Go receipt module mismatch')
    requireEqual(receipt.version, plan.go.version, 'Go receipt version mismatch')
    requireEqual(receipt.sourceCommit, plan.sourceCommit, 'Go receipt source mismatch')
    const expectedInventory = releaseSetExpectedGoInventory(plan)
    for (const label of ['proxy', 'direct']) {
      const branch = receipt[label]
      if (branch?.consumerExitCode !== 0 || !branch?.origin || branch.origin.Hash !== plan.sourceCommit || branch.origin.Ref !== `refs/tags/${plan.go.tag}` || branch.origin.Subdir !== 'packages/go') fail(`Go receipt ${label} proof is incomplete`)
      requireEqual(canonicalJson(branch.inventory), canonicalJson(expectedInventory), `Go receipt ${label} inventory mismatch`)
      if (branch.sum !== undefined && receipt.proxy?.sum !== undefined) requireEqual(branch.sum, receipt.proxy.sum, `Go receipt ${label} checksum mismatch`)
    }
    requireEqual(canonicalJson(receipt.proxy.inventory), canonicalJson(receipt.direct.inventory), 'Go receipt proxy/direct inventory mismatch')
  } else fail(`Unknown release-set receipt ${filename}`)
  return receipt
}

export function validateReleaseSetProofReceipts({ plan, preparation, receipts, receiptBytes, recoveryOptions = {} }) {
  recoveryOptions = validateReleaseSetRecoveryOptions(recoveryOptions)
  const normalized = validateReleaseSetPlan(plan)
  const checkedPreparation = releaseSetPreparationTuple(preparation, 'Release-set proof preparation')
  if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) fail('Release-set proof receipts are missing')
  const names = Object.keys(receipts).sort()
  if (names.length !== RELEASE_SET_RECEIPT_FILENAMES.length || names.some((name, index) => name !== [...RELEASE_SET_RECEIPT_FILENAMES].sort()[index])) fail('Release-set proof receipt set is incomplete')
  const digests = {}
  const normalizedReceipts = {}
  for (const filename of RELEASE_SET_RECEIPT_FILENAMES) {
    const value = receipts[filename]
    const bytes = receiptBytes?.[filename] ?? Buffer.from(`${canonicalJson(value)}\n`)
    if (!Buffer.isBuffer(bytes)) fail(`Release-set ${filename} raw bytes are invalid`)
    let parsed = value
    if (parsed === undefined) { try { parsed = JSON.parse(bytes.toString('utf8')) } catch { fail(`Release-set ${filename} JSON is invalid`) } }
    releaseSetValidateReceipt(parsed, filename, { plan: normalized, preparation: checkedPreparation, recoveryOptions })
    digests[filename] = sha256Hex(bytes)
    normalizedReceipts[filename] = parsed
  }
  return { receipts: normalizedReceipts, receiptDigests: Object.fromEntries(Object.entries(digests).sort()), preparation: checkedPreparation }
}

export function validateReleaseSetProofManifest(manifest, { plan, preparation } = {}) {
  releaseSetKeys(manifest, releaseSetManifestKeys, 'Release-set proof manifest')
  const normalized = validateReleaseSetPlan(plan)
  requireEqual(manifest.schemaVersion, 2, 'Release-set proof manifest schema mismatch')
  requireEqual(manifest.kind, 'erpc-sdk-release-set-proof-manifest', 'Release-set proof manifest kind mismatch')
  requireEqual(manifest.repository, EXPECTED_REPOSITORY, 'Release-set proof manifest repository mismatch')
  requireEqual(String(manifest.repositoryId), EXPECTED_REPOSITORY_ID, 'Release-set proof manifest repository ID mismatch')
  requireEqual(manifest.sourceCommit, normalized.sourceCommit, 'Release-set proof manifest source mismatch')
  releaseSetKeys(manifest.versions, ['nonRustVersion', 'rustVersion'], 'Release-set proof manifest versions')
  requireEqual(manifest.versions.nonRustVersion, normalized.versions.nonRustVersion, 'Release-set proof manifest non-Rust version mismatch')
  requireEqual(manifest.versions.rustVersion, normalized.versions.rustVersion, 'Release-set proof manifest Rust version mismatch')
  requireEqual(manifest.planSha256, releaseSetPlanDigest(normalized), 'Release-set proof manifest plan mismatch')
  const checkedPreparation = releaseSetPreparationTuple(manifest.preparation, 'Release-set proof manifest preparation')
  if (preparation !== undefined) requireEqual(canonicalJson(checkedPreparation), canonicalJson(releaseSetPreparationTuple(preparation, 'Expected release-set preparation')), 'Release-set proof manifest preparation mismatch')
  const snapshot = releaseSetArtifactBinding(manifest.snapshot, 'Release-set proof snapshot')
  requireEqual(snapshot.artifactName, releaseSetSnapshotArtifactName(snapshot.producer.runId, snapshot.producer.runAttempt), 'Release-set proof snapshot name mismatch')
  if (manifest.state !== 'complete') fail('Release-set proof manifest state is incomplete')
  const receiptNames = Object.keys(manifest.receipts ?? {}).sort()
  const expectedNames = [...RELEASE_SET_RECEIPT_FILENAMES].sort()
  if (receiptNames.length !== expectedNames.length || receiptNames.some((name, index) => name !== expectedNames[index])) fail('Release-set proof manifest receipt set is incomplete')
  const artifactNames = Object.keys(manifest.receiptArtifacts ?? {}).sort()
  if (artifactNames.length !== expectedNames.length || artifactNames.some((name, index) => name !== expectedNames[index])) fail('Release-set proof manifest receipt artifact set is incomplete')
  const receiptDigests = {}
  const receiptArtifacts = {}
  for (const filename of RELEASE_SET_RECEIPT_FILENAMES) {
    receiptDigests[filename] = requireArchiveSha(manifest.receipts[filename], `Release-set proof ${filename} digest`)
    const binding = releaseSetArtifactBinding(manifest.receiptArtifacts[filename], `Release-set proof ${filename} artifact`)
    requireEqual(binding.artifactName, releaseSetReceiptArtifactName(filename, binding.producer.runId, binding.producer.runAttempt), `Release-set proof ${filename} artifact name mismatch`)
    receiptArtifacts[filename] = binding
  }
  return { ...manifest, repositoryId: EXPECTED_REPOSITORY_ID, preparation: checkedPreparation, snapshot, receipts: Object.fromEntries(Object.entries(receiptDigests).sort()), receiptArtifacts: Object.fromEntries(Object.entries(receiptArtifacts).sort()) }
}

export function buildReleaseSetProofManifest({ plan, preparation, snapshot, receipts, receiptBytes, receiptArtifacts, recoveryOptions = {} }) {
  recoveryOptions = validateReleaseSetRecoveryOptions(recoveryOptions)
  const normalized = validateReleaseSetPlan(plan)
  const checked = validateReleaseSetProofReceipts({ plan: normalized, preparation, receipts, receiptBytes, recoveryOptions })
  const snapshotBinding = releaseSetArtifactBinding(snapshot, 'Release-set proof snapshot')
  requireEqual(snapshotBinding.artifactName, releaseSetSnapshotArtifactName(snapshotBinding.producer.runId, snapshotBinding.producer.runAttempt), 'Release-set proof snapshot name mismatch')
  if (!receiptArtifacts || typeof receiptArtifacts !== 'object' || Array.isArray(receiptArtifacts)) fail('Release-set proof receipt artifact bindings are missing')
  const actualBindings = {}
  for (const filename of RELEASE_SET_RECEIPT_FILENAMES) {
    actualBindings[filename] = releaseSetArtifactBinding(receiptArtifacts[filename], `Release-set proof ${filename} artifact`)
    requireEqual(actualBindings[filename].artifactName, releaseSetReceiptArtifactName(filename, actualBindings[filename].producer.runId, actualBindings[filename].producer.runAttempt), `Release-set proof ${filename} artifact name mismatch`)
  }
  const manifest = {
    schemaVersion: 2,
    kind: 'erpc-sdk-release-set-proof-manifest',
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    sourceCommit: normalized.sourceCommit,
    versions: { nonRustVersion: normalized.versions.nonRustVersion, rustVersion: normalized.versions.rustVersion },
    planSha256: releaseSetPlanDigest(normalized),
    preparation: checked.preparation,
    snapshot: snapshotBinding,
    receipts: checked.receiptDigests,
    receiptArtifacts: Object.fromEntries(Object.entries(actualBindings).sort()),
    state: 'complete',
  }
  return validateReleaseSetProofManifest(manifest, { plan: normalized, preparation: checked.preparation })
}

const githubRunAttempt = async (request, producer, deadlineControl, stage, current = false) => {
  const identity = releaseSetRunIdentity(producer, `${stage} expected producer`)
  const url = `${githubApiOrigin}/repos/${EXPECTED_REPOSITORY}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`
  const run = await githubObserverApiJson(request, url, deadlineControl, `${stage}-run`)
  return releaseSetValidateRunRecord(run, identity, { current })
}

const githubObserveReleaseSetArtifact = async ({ request, binding, expectedProducer, deadlineControl, workDir, expectedMembers, stage, current = false }) => {
  const checked = releaseSetArtifactBinding(binding, `Release-set ${stage} binding`)
  await githubRunAttempt(request, checked.producer, deadlineControl, stage, current)
  const actual = await githubArtifactMetadata(request, checked, deadlineControl, expectedProducer, stage)
  const zip = await githubArtifactZipBytes(request, checked.artifactId, deadlineControl, stage)
  requireEqual(sha256Hex(zip.bytes), checked.sha256, `Release-set ${stage} raw ZIP digest mismatch`)
  requireEqual(zip.bytes.length, checked.sizeInBytes, `Release-set ${stage} raw ZIP size mismatch`)
  const extracted = await githubArtifactMembers(zip.bytes, workDir, expectedMembers, stage)
  const actualBinding = { ...checked, sha256: sha256Hex(zip.bytes), sizeInBytes: zip.bytes.length }
  return { binding: actualBinding, metadata: actual.metadata, zip, extracted }
}

/** Authenticate a bounded subset of original one-member receipt artifacts before tag or Release effects. */
export async function observeReleaseSetReceiptArtifacts({ plan, preparation, receiptArtifacts, filenames, observer, workDir, request, now = () => performance.now(), currentProducer = true, recoveryOptions = {} }) {
  recoveryOptions = validateReleaseSetRecoveryOptions(recoveryOptions)
  const normalized = validateReleaseSetPlan(plan)
  const checkedPreparation = releaseSetPreparationTuple(preparation, 'Release-set receipt preparation')
  const names = filenames === undefined ? ['npm-proof.json', 'pypi-proof.json', 'rubygems-proof.json'] : [...filenames]
  releaseSetKeys(receiptArtifacts, names, 'Release-set receipt artifact map')
  const root = npmSafePath(workDir, 'Release-set receipt work directory')
  if ((await readdir(root, { withFileTypes: true })).length !== 0) fail('Release-set receipt work directory is not fresh')
  const observerIdentity = releaseSetObserverIdentity(observer, normalized.sourceCommit)
  const deadlineControl = { now, deadline: now() + 600_000 }
  const receipts = {}; const receiptBytes = {}; const actualBindings = {}; const observedRuns = new Map()
  for (const filename of names) {
    const binding = releaseSetArtifactBinding(receiptArtifacts[filename], `Release-set ${filename} binding`)
    const sameCurrent = binding.producer.runId === observerIdentity.runId && binding.producer.runAttempt === observerIdentity.runAttempt
    const producerKey = binding.producer.runId + '/' + binding.producer.runAttempt
    if (!observedRuns.has(producerKey)) observedRuns.set(producerKey, await githubRunAttempt(request, binding.producer, deadlineControl, `release-set-${releaseSetReceiptRole(filename)}`, currentProducer && sameCurrent))
    const observed = await githubObserveReleaseSetArtifact({ request, binding, expectedProducer: binding.producer, deadlineControl, workDir: root, expectedMembers: [filename], stage: `receipt-${releaseSetReceiptRole(filename)}`, current: currentProducer && sameCurrent })
    const bytes = observed.extracted.bytes.get(filename)
    let receipt
    try { receipt = JSON.parse(bytes.toString('utf8')) } catch { fail(`Release-set ${filename} receipt JSON is invalid`) }
    releaseSetValidateReceipt(receipt, filename, { plan: normalized, preparation: checkedPreparation, recoveryOptions })
    const expectedObserverSource = recoveryOptions.observerSources?.[filename] ?? recoveryOptions.observerSourceCommit
    const receiptObserver = releaseSetReceiptObserver(receipt.observer, `Release-set ${filename} receipt observer`, normalized, { observerSourceCommit: expectedObserverSource })
    requireEqual(canonicalJson(receiptObserver), canonicalJson(observed.binding.producer), `Release-set ${filename} producer lineage mismatch`)
    receipts[filename] = receipt; receiptBytes[filename] = bytes; actualBindings[filename] = observed.binding
  }
  return { receipts, receiptBytes, receiptArtifacts: actualBindings, producerRuns: Object.fromEntries(observedRuns) }
}

const releaseSetSelector = selector => {
  releaseSetKeys(selector, ['mode', 'snapshot', 'receiptArtifacts', 'checkpoint'], 'Release-set proof selector')
  if (!['current', 'preserved-manifest', 'preserved-checkpoint'].includes(selector.mode)) fail('Release-set proof selector mode is invalid')
  if (selector.mode === 'current') {
    if (selector.snapshot === undefined || selector.receiptArtifacts === undefined || selector.checkpoint !== undefined) fail('Current release-set selector requires snapshot and receipt artifacts')
    releaseSetArtifactBinding(selector.snapshot, 'Release-set current snapshot')
  } else if (selector.mode === 'preserved-checkpoint') {
    if (selector.checkpoint === undefined || selector.snapshot !== undefined || selector.receiptArtifacts !== undefined) fail('Preserved checkpoint selector requires only checkpoint')
    releaseSetArtifactBinding(selector.checkpoint, 'Release-set manifest checkpoint')
  } else if (selector.snapshot !== undefined || selector.receiptArtifacts !== undefined || selector.checkpoint !== undefined) fail('Preserved manifest selector cannot carry source bindings')
  return selector
}

/** Authenticate the six source receipts and the immutable receipt-only snapshot. */
export async function observeReleaseSetProofSnapshot({ plan, preparation, selector, observer, workDir, request, now = () => performance.now(), currentProducer = true, recoveryOptions = {} }) {
  recoveryOptions = validateReleaseSetRecoveryOptions(recoveryOptions)
  const normalized = validateReleaseSetPlan(plan)
  const checkedPreparation = releaseSetPreparationTuple(preparation, 'Release-set snapshot preparation')
  const checkedSelector = releaseSetSelector(selector)
  const root = npmSafePath(workDir, 'Release-set snapshot work directory')
  if ((await readdir(root, { withFileTypes: true })).length !== 0) fail('Release-set snapshot work directory is not fresh')
  const deadlineControl = { now, deadline: now() + 600_000 }
  if (checkedSelector.mode === 'preserved-manifest') fail('Preserved manifest selector is verified by the Release observer')
  const producerIdentity = checkedSelector.mode === 'current'
    ? releaseSetRunIdentity(checkedSelector.snapshot.producer, 'Release-set snapshot producer')
    : releaseSetRunIdentity(checkedSelector.checkpoint.producer, 'Release-set checkpoint producer')
  if (observer !== undefined && checkedSelector.mode === 'current') {
    const currentIdentity = releaseSetObserverIdentity(observer, normalized.sourceCommit)
    requireEqual(canonicalJson(currentIdentity), canonicalJson(producerIdentity), 'Release-set current snapshot producer is not the current observer')
  }
  const sourceBindings = checkedSelector.mode === 'current' ? checkedSelector.receiptArtifacts : undefined
  const snapshotBinding = checkedSelector.mode === 'current' ? checkedSelector.snapshot : undefined
  if (checkedSelector.mode === 'preserved-checkpoint') {
    const checkpoint = await githubObserveReleaseSetArtifact({ request, binding: checkedSelector.checkpoint, deadlineControl, workDir: root, expectedMembers: ['release-set-proof-manifest.json'], stage: 'manifest-checkpoint', current: false })
    const bytes = checkpoint.extracted.bytes.get('release-set-proof-manifest.json')
    let manifest
    try { manifest = JSON.parse(bytes.toString('utf8')) } catch { fail('Release-set checkpoint manifest JSON is invalid') }
    const validated = validateReleaseSetProofManifest(manifest, { plan: normalized, preparation: checkedPreparation })
    const nestedRoot = join(root, 'checkpoint-lineage')
    await mkdir(nestedRoot)
    const nested = await observeReleaseSetProofSnapshot({ plan: normalized, preparation: checkedPreparation, selector: { mode: 'current', snapshot: validated.snapshot, receiptArtifacts: validated.receiptArtifacts }, observer: undefined, workDir: nestedRoot, request, now, currentProducer: false, recoveryOptions })
    requireEqual(canonicalJson(nested.manifest), canonicalJson(validated), 'Release-set checkpoint manifest lineage changed')
    return { ...nested, checkpointManifestBytes: bytes }
  }
  releaseSetKeys(sourceBindings, RELEASE_SET_RECEIPT_FILENAMES, 'Release-set source receipt artifact map')
  await githubRunAttempt(request, producerIdentity, deadlineControl, 'release-set-snapshot', currentProducer)
  const snapshotExpectedName = releaseSetSnapshotArtifactName(producerIdentity.runId, producerIdentity.runAttempt)
  requireEqual(snapshotBinding.artifactName, snapshotExpectedName, 'Release-set snapshot artifact name mismatch')
  const snapshot = await githubObserveReleaseSetArtifact({ request, binding: snapshotBinding, expectedProducer: producerIdentity, deadlineControl, workDir: root, expectedMembers: [...RELEASE_SET_RECEIPT_FILENAMES], stage: 'proof-snapshot', current: currentProducer })
  const receipts = {}
  const receiptBytes = {}
  const actualReceiptBindings = {}
  const observedProducerRuns = new Map()
  for (const filename of RELEASE_SET_RECEIPT_FILENAMES) {
    const binding = releaseSetArtifactBinding(sourceBindings[filename], `Release-set ${filename} binding`)
    const expectedName = releaseSetReceiptArtifactName(filename, binding.producer.runId, binding.producer.runAttempt)
    requireEqual(binding.artifactName, expectedName, `Release-set ${filename} artifact name mismatch`)
    const sameCurrent = binding.producer.runId === producerIdentity.runId && binding.producer.runAttempt === producerIdentity.runAttempt
    if (!observedProducerRuns.has(`${binding.producer.runId}/${binding.producer.runAttempt}`)) {
      observedProducerRuns.set(`${binding.producer.runId}/${binding.producer.runAttempt}`, await githubRunAttempt(request, binding.producer, deadlineControl, `release-set-${releaseSetReceiptRole(filename)}`, currentProducer && sameCurrent))
    }
    const observed = await githubObserveReleaseSetArtifact({ request, binding, expectedProducer: binding.producer, deadlineControl, workDir: root, expectedMembers: [filename], stage: `receipt-${releaseSetReceiptRole(filename)}`, current: currentProducer && sameCurrent })
    const bytes = observed.extracted.bytes.get(filename)
    const snapshotBytes = snapshot.extracted.bytes.get(filename)
    requireEqual(Buffer.compare(bytes, snapshotBytes), 0, `Release-set ${filename} differs from snapshot receipt bytes`)
    try { receipts[filename] = JSON.parse(bytes.toString('utf8')) } catch { fail(`Release-set ${filename} receipt JSON is invalid`) }
    receiptBytes[filename] = bytes
    actualReceiptBindings[filename] = observed.binding
  }
  const checkedReceipts = validateReleaseSetProofReceipts({ plan: normalized, preparation: checkedPreparation, receipts, receiptBytes, recoveryOptions })
  for (const filename of RELEASE_SET_RECEIPT_FILENAMES) {
    const receiptObserver = releaseSetReceiptObserver(checkedReceipts.receipts[filename].observer, `Release-set ${filename} receipt observer`, normalized, { ...recoveryOptions, observerSourceCommit: recoveryOptions.observerSources?.[filename] ?? recoveryOptions.observerSourceCommit })
    requireEqual(canonicalJson(receiptObserver), canonicalJson(actualReceiptBindings[filename].producer), `Release-set ${filename} producer lineage mismatch`)
  }
  const manifest = buildReleaseSetProofManifest({ plan: normalized, preparation: checkedPreparation, snapshot: snapshot.binding, receipts: checkedReceipts.receipts, receiptBytes, receiptArtifacts: actualReceiptBindings, recoveryOptions })
  return { selector: checkedSelector, snapshot: snapshot.binding, receiptArtifacts: actualReceiptBindings, receipts: checkedReceipts.receipts, receiptBytes, receiptDigests: checkedReceipts.receiptDigests, manifest, producerRuns: Object.fromEntries(observedProducerRuns) }
}

/** Bind a caller descriptor to the authenticated preparation plan and bytes before GitHub reads. */

const githubObserverAsset = asset => {
  releaseSetKeys(asset, ['role', 'filename', 'sha256', 'sizeInBytes'], 'GitHub observer asset')
  if (typeof asset.role !== 'string' || asset.role.length === 0) fail('GitHub observer asset role is invalid')
  safeRelativePath(asset.filename)
  requireArchiveSha(asset.sha256, `GitHub observer ${asset.role} SHA-256`)
  if (!Number.isSafeInteger(asset.sizeInBytes) || asset.sizeInBytes <= 0) fail(`GitHub observer ${asset.role} size is invalid`)
  return asset
}

const githubObserverDescriptor = descriptor => {
  releaseSetKeys(descriptor, ['repository', 'repositoryId', 'releaseTag', 'title', 'bodySha256', 'sourceCommit', 'assets', 'releaseId', 'requirePublic', 'prerelease', 'latest'], 'GitHub observer descriptor')
  requireEqual(descriptor.repository, EXPECTED_REPOSITORY, 'GitHub observer repository mismatch')
  requireEqual(String(descriptor.repositoryId), EXPECTED_REPOSITORY_ID, 'GitHub observer repository ID mismatch')
  if (typeof descriptor.releaseTag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(descriptor.releaseTag)) fail('GitHub observer release tag is invalid')
  releaseSetString(descriptor.title, 'GitHub observer release title')
  requireArchiveSha(descriptor.bodySha256, 'GitHub observer release body SHA-256')
  requireSha(descriptor.sourceCommit, 'GitHub observer source commit')
  if (descriptor.prerelease !== false) fail('GitHub observer prerelease intent must be false')
  if (descriptor.latest !== undefined && typeof descriptor.latest !== 'boolean') fail('GitHub observer Latest intent must be boolean')
  if (!Array.isArray(descriptor.assets) || descriptor.assets.length === 0) fail('GitHub observer asset set is empty')
  const assets = descriptor.assets.map(githubObserverAsset)
  if (new Set(assets.map(asset => asset.role)).size !== assets.length || new Set(assets.map(asset => asset.filename)).size !== assets.length) fail('GitHub observer asset roles or filenames are duplicated')
  if (descriptor.releaseId !== undefined) requireFuturePositiveId(descriptor.releaseId, 'GitHub observer release ID')
  if (descriptor.requirePublic !== undefined && typeof descriptor.requirePublic !== 'boolean') fail('GitHub observer requirePublic must be boolean')
  return { ...descriptor, assets }
}

const githubObserverInput = input => {
  releaseSetKeys(input, ['plan', 'descriptor', 'planSha256', 'preparation', 'observer', 'workDir', 'outputFile', 'snapshot', 'publicRead', 'requireSnapshot', 'recoveryOptions'], 'GitHub observer input')
  const descriptor = githubObserverDescriptor(input.descriptor)
  if (input.plan !== undefined) validateReleaseSetPlan(input.plan)
  if (input.planSha256 !== undefined) requireArchiveSha(input.planSha256, 'GitHub observer plan SHA-256')
  if (input.preparation !== undefined) {
    releaseSetKeys(input.preparation, ['sourceCommit', 'runId', 'runAttempt', 'artifactId', 'bindingArtifactId', 'planSha256'], 'GitHub observer preparation')
    requireSha(input.preparation.sourceCommit, 'GitHub observer preparation source')
    for (const [value, label] of [[input.preparation.runId, 'GitHub observer preparation run ID'], [input.preparation.runAttempt, 'GitHub observer preparation attempt'], [input.preparation.artifactId, 'GitHub observer preparation artifact ID'], [input.preparation.bindingArtifactId, 'GitHub observer preparation binding artifact ID']]) requireFuturePositiveId(value, label)
    requireArchiveSha(input.preparation.planSha256, 'GitHub observer preparation plan SHA-256')
    if (input.planSha256 !== undefined) requireEqual(input.preparation.planSha256, input.planSha256, 'GitHub observer preparation plan mismatch')
  }
  releaseSetKeys(input.observer, ['runId', 'runAttempt', 'workflowPath', 'sourceCommit'], 'GitHub observer context')
  requireFuturePositiveId(input.observer.runId, 'GitHub observer run ID')
  requireFuturePositiveId(input.observer.runAttempt, 'GitHub observer attempt')
  requireEqual(input.observer.workflowPath, RELEASE_SET_WORKFLOW, 'GitHub observer workflow mismatch')
  requireSha(input.observer.sourceCommit, 'GitHub observer source')
  if (input.snapshot !== undefined && input.plan !== undefined && input.snapshot.mode !== undefined) releaseSetSelector(input.snapshot)
  return { ...input, descriptor, requireSnapshot: input.requireSnapshot === true || descriptor.assets.some(asset => githubDynamicProofRoles.has(asset.role)) }
}

/** Bind a caller descriptor to the authenticated preparation plan and bytes before GitHub reads. */
export async function validateGitHubReleaseDescriptor({ plan, descriptor, artifactDirectory }) {
  const normalized = validateReleaseSetPlan(plan)
  const checked = githubObserverDescriptor(descriptor)
  requireEqual(checked.repository, normalized.repository, 'GitHub observer descriptor repository does not match plan')
  requireEqual(String(checked.repositoryId), String(normalized.repositoryId), 'GitHub observer descriptor repository ID does not match plan')
  requireEqual(checked.releaseTag, normalized.tags.release, 'GitHub observer descriptor tag does not match plan')
  requireEqual(checked.title, normalized.githubRelease.title, 'GitHub observer descriptor title does not match plan')
  requireEqual(checked.bodySha256, normalized.githubRelease.bodySha256, 'GitHub observer descriptor body does not match plan')
  requireEqual(checked.sourceCommit, normalized.sourceCommit, 'GitHub observer descriptor source does not match plan')
  requireEqual(checked.latest ?? false, normalized.githubRelease.latest ?? false, 'GitHub observer Latest intent does not match plan')
  const expectedAssets = new Map(normalized.approval.publicAssets.map(asset => [asset.role, asset.filename]))
  const actualAssets = new Map(checked.assets.map(asset => [asset.role, asset.filename]))
  if (expectedAssets.size !== actualAssets.size || [...expectedAssets].some(([role, filename]) => actualAssets.get(role) !== filename)) fail('GitHub observer descriptor asset inventory does not match plan')
  const staticFiles = new Map(normalized.artifacts.map(artifact => [artifact.kind, { filename: artifact.filename, sha256: artifact.sha256 }]))
  if (normalized.rust.mode === 'publish') staticFiles.set('rust-crate', { filename: normalized.rust.archive.filename, sha256: normalized.rust.sha256 })
  staticFiles.set('release-body', { filename: 'release-body.md', sha256: sha256Hex(normalized.githubRelease.body) })
  staticFiles.set('go-inventory', { filename: 'go-inventory.json', sha256: sha256Hex(`${canonicalJson(normalized.go.inventory)}\n`) })
  const dynamicRoles = []
  for (const asset of checked.assets) {
    const staticFile = staticFiles.get(asset.role)
    if (!staticFile) { dynamicRoles.push(asset.role); continue }
    requireEqual(asset.filename, staticFile.filename, `GitHub observer static ${asset.role} filename mismatch`)
    const preparedPath = join(await realpath(artifactDirectory), staticFile.filename)
    const preparedStat = await stat(preparedPath)
    requireEqual(await sha256File(preparedPath), staticFile.sha256, `GitHub observer prepared ${asset.role} bytes mismatch`)
    requireEqual(asset.sha256, staticFile.sha256, `GitHub observer descriptor ${asset.role} hash mismatch`)
    requireEqual(asset.sizeInBytes, preparedStat.size, `GitHub observer descriptor ${asset.role} size mismatch`)
  }
  return { descriptor: checked, dynamicRoles }
}

const githubApplyReleaseSetDynamicHashes = (descriptor, evidence) => {
  const checked = githubObserverDescriptor(descriptor)
  if (!evidence || typeof evidence !== 'object') fail('GitHub observer release-set evidence is missing')
  const receiptBytes = evidence.receiptBytes ?? {}
  const manifestBytes = Buffer.from(`${canonicalJson(evidence.manifest)}\n`)
  const assets = checked.assets.map(asset => {
    let bytes
    if (asset.role === 'release-set-proof-manifest') bytes = manifestBytes
    else if (githubDynamicProofRoles.has(asset.role)) bytes = receiptBytes[asset.filename]
    if (bytes === undefined) return asset
    if (!Buffer.isBuffer(bytes)) fail(`GitHub observer dynamic ${asset.role} bytes are invalid`)
    return { ...asset, sha256: sha256Hex(bytes), sizeInBytes: bytes.length }
  })
  return { descriptor: { ...checked, assets } }
}

const githubObserverSnapshot = async (snapshot, request, deadlineControl, workDir) => {
  releaseSetKeys(snapshot, ['manifestUrl', 'manifestSha256', 'archiveUrl', 'archiveId', 'archiveSha256', 'members'], 'GitHub observer snapshot')
  if (typeof snapshot.manifestUrl !== 'string' || !snapshot.manifestUrl.startsWith(`${githubApiOrigin}/`)) fail('GitHub observer snapshot manifest URL is invalid')
  if (typeof snapshot.archiveUrl !== 'string' || !snapshot.archiveUrl.startsWith(`${githubApiOrigin}/repos/${EXPECTED_REPOSITORY}/actions/artifacts/`)) fail('GitHub observer snapshot archive URL is invalid')
  requireFuturePositiveId(snapshot.archiveId, 'GitHub observer snapshot archive ID')
  requireArchiveSha(snapshot.manifestSha256, 'GitHub observer snapshot manifest SHA-256')
  requireArchiveSha(snapshot.archiveSha256, 'GitHub observer snapshot archive SHA-256')
  if (!Array.isArray(snapshot.members) || snapshot.members.length === 0) fail('GitHub observer snapshot members are empty')
  const manifestResponse = await githubObserverRequest(request, snapshot.manifestUrl, deadlineControl, 'snapshot-manifest')
  if (manifestResponse.status !== 200) fail(`github-observe-snapshot-manifest-http-${manifestResponse.status}`)
  const manifestBytes = npmResponseBody(manifestResponse); requireEqual(sha256Hex(manifestBytes), snapshot.manifestSha256, 'GitHub observer snapshot manifest bytes mismatch')
  let manifest
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) } catch { fail('github-observe-snapshot-manifest-json-invalid') }
  if (manifest?.sourceCommit !== undefined) requireSha(manifest.sourceCommit, 'GitHub observer snapshot source commit')
  const archiveResponse = await githubObserverRequest(request, snapshot.archiveUrl, deadlineControl, 'snapshot-archive', 'application/vnd.github+json')
  if (archiveResponse.status !== 200) fail(`github-observe-snapshot-archive-http-${archiveResponse.status}`)
  const archiveBytes = npmResponseBody(archiveResponse); requireEqual(sha256Hex(archiveBytes), snapshot.archiveSha256, 'GitHub observer snapshot archive bytes mismatch')
  const archivePath = join(workDir, 'github-proof-snapshot.zip'); await writeFile(archivePath, archiveBytes, { flag: 'wx' })
  const members = await archiveEntries(archivePath, 'zip')
  const expected = new Map(snapshot.members.map(member => { releaseSetKeys(member, ['path', 'sha256'], 'GitHub observer snapshot member'); return [safeRelativePath(member.path), requireArchiveSha(member.sha256, `GitHub observer snapshot member ${member.path}`)] }))
  for (const [member, expectedSha] of expected) requireEqual(manifest?.receipts?.[member], expectedSha, `GitHub observer snapshot manifest ${member} binding mismatch`)
  if (new Set(expected.keys()).size !== expected.size || members.length !== expected.size || members.some(member => !expected.has(member))) fail('GitHub observer snapshot member set mismatch')
  for (const [member, expectedSha] of expected) requireEqual(sha256Hex(await commandBuffer('unzip', ['-p', archivePath, member])), expectedSha, `GitHub observer snapshot member ${member} mismatch`)
  return { manifestSha256: snapshot.manifestSha256, archiveId: Number(snapshot.archiveId), archiveSha256: snapshot.archiveSha256, members: [...expected.keys()].sort() }
}

const githubObserverHeaders = Object.freeze({ 'user-agent': RELEASE_USER_AGENT, accept: 'application/vnd.github+json' })
const githubAnonymousHeaders = Object.freeze({ 'user-agent': RELEASE_USER_AGENT, accept: 'application/vnd.github+json' })

const githubAnonymousDefaultRequest = async (url, options = {}) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
  try {
    const response = await fetch(url, { method: 'GET', headers: options.headers ?? {}, redirect: 'manual', signal: controller.signal })
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) }
  } catch {
    fail('github-observe-anonymous-http-failed')
  } finally {
    clearTimeout(timer)
  }
}

const githubObserverRequest = async (request, url, deadlineControl, stage, accept = 'application/vnd.github+json', baseHeaders = githubObserverHeaders) => {
  let response
  try { response = await request(url, { method: 'GET', headers: { ...baseHeaders, accept }, timeoutMs: Math.min(60_000, npmDeadlineRemaining(deadlineControl.now, deadlineControl.deadline)), deadline: deadlineControl.deadline }) } catch { fail(`github-observe-${stage}-http-failed`) }
  npmCheckDeadline(deadlineControl.now, deadlineControl.deadline)
  if (!response || !Number.isInteger(response.status)) fail(`github-observe-${stage}-response-invalid`)
  return response
}

const githubObserverEffectiveLatest = async (request, descriptor, observedRelease, deadlineControl, stage, requestHelper = githubObserverRequest) => {
  const response = await requestHelper(request, `${githubApiOrigin}/repos/${descriptor.repository}/releases/latest`, deadlineControl, stage)
  if (response.status === 404) return false
  if (response.status !== 200) fail(`github-observe-${stage}-http-${response.status}`)
  const latest = githubObserverJson(response, `${stage}-json`)
  if (!Number.isSafeInteger(latest?.id) || latest.id <= 0) fail(`github-observe-${stage}-id-invalid`)
  return latest.id === observedRelease.id
}

const githubObserverAnonymousRequest = (request, url, deadlineControl, stage, accept = 'application/vnd.github+json') => githubObserverRequest(request, url, deadlineControl, stage, accept, githubAnonymousHeaders)

const githubObserverJson = (response, stage) => {
  try { return JSON.parse(npmResponseBody(response).toString('utf8')) } catch { fail(`github-observe-${stage}-json-invalid`) }
}

const githubObserverPages = async (request, firstUrl, deadlineControl, stage, requestHelper = githubObserverRequest) => {
  const pages = []
  let url = firstUrl
  for (let page = 0; page < 100; page += 1) {
    const response = await requestHelper(request, url, deadlineControl, `${stage}-page-${page + 1}`)
    if (response.status !== 200) fail(`github-observe-${stage}-http-${response.status}`)
    const payload = githubObserverJson(response, `${stage}-page-${page + 1}`)
    if (!Array.isArray(payload)) fail(`github-observe-${stage}-page-invalid`)
    pages.push(...payload)
    const link = response.headers?.link ?? response.headers?.Link
    const next = typeof link === 'string' ? link.split(',').map(value => value.match(/<([^>]+)>;\s*rel="?next"?/i)?.[1]).find(Boolean) : undefined
    if (next) {
      let nextUrl
      try { nextUrl = new URL(next, url) } catch { fail(`github-observe-${stage}-pagination-invalid`) }
      const first = new URL(firstUrl)
      if (nextUrl.origin !== first.origin || nextUrl.pathname !== first.pathname || nextUrl.username || nextUrl.password || nextUrl.hash) fail(`github-observe-${stage}-pagination-invalid`)
      const allowed = new Set(['page', 'per_page'])
      if ([...nextUrl.searchParams.keys()].some(key => !allowed.has(key)) || nextUrl.searchParams.get('per_page') !== '100' || !/^[1-9][0-9]*$/.test(nextUrl.searchParams.get('page') ?? '')) fail(`github-observe-${stage}-pagination-invalid`)
      url = nextUrl.href; continue
    }
    if (payload.length < 100) return pages
    const separator = firstUrl.includes('?') ? '&' : '?'
    url = `${firstUrl}${separator}page=${page + 2}`
  }
  fail(`github-observe-${stage}-pagination-unbounded`)
}

const githubObserverAssetMap = (records, descriptor) => {
  if (!Array.isArray(records)) fail('GitHub observer asset response is invalid')
  const expected = new Map(descriptor.assets.map(asset => [asset.filename, asset]))
  const actual = new Map()
  const ids = new Set()
  for (const record of records) {
    if (!Number.isSafeInteger(record?.id) || record.id <= 0 || typeof record.name !== 'string' || actual.has(record.name)) fail('GitHub observer asset identity is invalid')
    if (!expected.has(record.name)) fail('GitHub observer asset set contains an unexpected member')
    if (ids.has(record.id)) fail('GitHub observer asset IDs are duplicated')
    ids.add(record.id)
    if (record.digest !== undefined && typeof record.digest !== 'string') fail('GitHub observer asset digest is invalid')
    if (record.size !== undefined && (!Number.isSafeInteger(record.size) || record.size < 0)) fail('GitHub observer asset size is invalid')
    actual.set(record.name, { id: record.id, name: record.name, expected: expected.get(record.name), apiDigest: record.digest, apiSize: record.size })
  }
  return { expected, actual }
}

const githubObserverRelease = (release, descriptor) => {
  if (!Number.isSafeInteger(release?.id) || release.id <= 0) fail('GitHub observer release ID is invalid')
  requireEqual(release.id, Number(descriptor.releaseId), 'GitHub observer release ID mismatch')
  requireEqual(release.tag_name, descriptor.releaseTag, 'GitHub observer release tag mismatch')
  requireEqual(release.name, descriptor.title, 'GitHub observer release title mismatch')
  requireEqual(sha256Hex(String(release.body ?? '')), descriptor.bodySha256, 'GitHub observer release body mismatch')
  if (typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') fail('GitHub observer release state is invalid')
  if (release.prerelease !== false) fail('GitHub observer release prerelease state is invalid')
  if (release.target_commitish !== descriptor.sourceCommit && release.target_commitish !== descriptor.releaseTag) fail('GitHub observer release source mismatch')
  return { id: release.id, tag: release.tag_name, title: release.name, bodySha256: sha256Hex(String(release.body ?? '')), draft: release.draft === true, prerelease: release.prerelease === true, latest: release.latest ?? release.make_latest ?? release.is_latest, targetCommitish: release.target_commitish }
}

const githubObserverNamedTagSource = async (request, descriptor, tagName, deadlineControl, stage, requestHelper = githubObserverRequest) => {
  const tagUrl = `${githubApiOrigin}/repos/${descriptor.repository}/git/ref/tags/${encodeURIComponent(tagName)}`
  const response = await requestHelper(request, tagUrl, deadlineControl, stage)
  if (response.status !== 200) fail(`github-observe-${stage}-http-${response.status}`)
  const payload = githubObserverJson(response, stage)
  requireEqual(payload?.ref, `refs/tags/${tagName}`, `GitHub observer ${stage} tag ref mismatch`)
  requireEqual(payload?.object?.type, 'commit', `GitHub observer ${stage} tag type mismatch`)
  requireEqual(payload?.object?.sha, descriptor.sourceCommit, `GitHub observer ${stage} tag source mismatch`)
  return { ref: payload.ref, type: payload.object.type, sha: payload.object.sha }
}

const githubObserverTagSource = async (request, descriptor, deadlineControl, stage, requestHelper = githubObserverRequest) => githubObserverNamedTagSource(request, descriptor, descriptor.releaseTag, deadlineControl, stage, requestHelper)

const githubObserverRedirectBytes = async (request, url, deadlineControl, stage, requestHelper = githubObserverRequest) => {
  let current = url
  const redirects = []
  for (let count = 0; count < 4; count += 1) {
    const response = await requestHelper(request, current, deadlineControl, `${stage}-${count + 1}`, 'application/octet-stream')
    if (response.status === 200) return { response, redirects }
    if (![301, 302, 303, 307, 308].includes(response.status)) fail(`github-observe-${stage}-http-${response.status}`)
    const location = response.headers?.location ?? response.headers?.Location
    let target
    try { target = new URL(location, current) } catch { fail(`github-observe-${stage}-redirect-invalid`) }
    if (target.protocol !== 'https:' || (!githubRedirectHostAllowed(target.hostname) && target.origin !== new URL(current).origin) || redirects.includes(target.href)) fail(`github-observe-${stage}-redirect-unsafe`)
    redirects.push(target.href); current = target.href
  }
  fail(`github-observe-${stage}-redirect-limit`)
}

const githubObserverPublicRead = async (publicRead, descriptor, observedRelease, observedAssets, anonymousRequest, deadlineControl) => {
  const publicDescriptor = { ...descriptor, releaseId: observedRelease.id }
  let releases
  try {
    releases = await githubObserverPages(anonymousRequest, `${githubApiOrigin}/repos/${descriptor.repository}/releases?per_page=100`, deadlineControl, 'public-release-list', githubObserverAnonymousRequest)
  } catch (error) {
    if (String(error?.message ?? error).includes('npm-observe-deadline-exceeded')) throw error
    return { complete: false, reason: 'public-release-list-unavailable', anonymous: true }
  }
  const matches = releases.filter(item => item?.tag_name === descriptor.releaseTag)
  if (matches.length !== 1) return { complete: false, reason: matches.length === 0 ? 'public-release-absent' : 'public-release-ambiguous', anonymous: true }
  const listed = matches[0]
  if (!Number.isSafeInteger(listed.id) || listed.id <= 0 || listed.id !== observedRelease.id) return { complete: false, reason: 'public-release-id-mismatch', anonymous: true }
  const releaseUrl = `${githubApiOrigin}/repos/${descriptor.repository}/releases/${listed.id}`
  const releaseResponse = await githubObserverAnonymousRequest(anonymousRequest, releaseUrl, deadlineControl, 'public-release')
  if (releaseResponse.status !== 200) return { complete: false, reason: 'public-release-unavailable', anonymous: true }
  const release = githubObserverRelease(githubObserverJson(releaseResponse, 'public-release'), publicDescriptor)
  if (release.draft || release.prerelease) return { complete: false, reason: 'public-release-not-publishable', anonymous: true }
  const tagSource = await githubObserverTagSource(anonymousRequest, publicDescriptor, deadlineControl, 'public-tag-source', githubObserverAnonymousRequest)
  const initialAssets = githubObserverAssetMap(await githubObserverPages(anonymousRequest, `${githubApiOrigin}/repos/${descriptor.repository}/releases/${listed.id}/assets?per_page=100`, deadlineControl, 'public-asset-list', githubObserverAnonymousRequest), publicDescriptor)
  const expectedAssets = new Map(descriptor.assets.map(asset => [asset.filename, asset]))
  const observedByName = new Map(observedAssets.map(asset => [asset.filename, asset]))
  const observedMissingAssets = [...expectedAssets.keys()].filter(filename => !observedByName.has(filename))
  const publicMissingAssets = [...expectedAssets.keys()].filter(filename => !initialAssets.actual.has(filename))
  if (observedMissingAssets.length > 0 || publicMissingAssets.length > 0) return { complete: false, reason: 'public-assets-incomplete', anonymous: true, missingAssets: [...new Set([...observedMissingAssets, ...publicMissingAssets])].sort(), observedMissingAssets, publicMissingAssets }
  if (initialAssets.actual.size !== expectedAssets.size || [...expectedAssets].some(([filename, asset]) => {
    const observed = observedByName.get(filename)
    const record = initialAssets.actual.get(filename)
    return !observed || !record || record.id !== observed.id || observed.sha256 !== asset.sha256 || observed.sizeInBytes !== asset.sizeInBytes || record.apiDigest !== `sha256:${asset.sha256}` || record.apiSize !== asset.sizeInBytes
  })) return { complete: false, reason: 'public-asset-metadata-mismatch', anonymous: true }
  const publicAssets = []
  for (const [filename, expected] of expectedAssets) {
    const record = initialAssets.actual.get(filename)
    const downloaded = await githubObserverRedirectBytes(anonymousRequest, `${githubApiOrigin}/repos/${descriptor.repository}/releases/assets/${record.id}`, deadlineControl, `public-asset-${record.id}`, githubObserverAnonymousRequest)
    const bytes = npmResponseBody(downloaded.response)
    const observedSha256 = sha256Hex(bytes)
    requireEqual(observedSha256, expected.sha256, `GitHub observer public asset ${filename} bytes mismatch`)
    requireEqual(bytes.length, expected.sizeInBytes, `GitHub observer public asset ${filename} size mismatch`)
    requireEqual(record.apiDigest, `sha256:${observedSha256}`, `GitHub observer public asset ${filename} API digest mismatch`)
    requireEqual(record.apiSize, bytes.length, `GitHub observer public asset ${filename} API size mismatch`)
    publicAssets.push({ filename, id: record.id, sha256: observedSha256, sizeInBytes: bytes.length })
  }
  const finalAssets = githubObserverAssetMap(await githubObserverPages(anonymousRequest, `${githubApiOrigin}/repos/${descriptor.repository}/releases/${listed.id}/assets?per_page=100`, deadlineControl, 'public-asset-final-list', githubObserverAnonymousRequest), publicDescriptor)
  if (finalAssets.actual.size !== initialAssets.actual.size || [...initialAssets.actual.entries()].some(([filename, item]) => {
    const final = finalAssets.actual.get(filename)
    return !final || final.id !== item.id || final.apiDigest !== item.apiDigest || final.apiSize !== item.apiSize
  })) return { complete: false, reason: 'public-asset-metadata-changed', anonymous: true }
  for (const asset of publicAssets) {
    const finalRecord = finalAssets.actual.get(asset.filename)
    const finalDownload = await githubObserverRedirectBytes(anonymousRequest, `${githubApiOrigin}/repos/${descriptor.repository}/releases/assets/${finalRecord.id}`, deadlineControl, `public-asset-final-${finalRecord.id}`, githubObserverAnonymousRequest)
    const finalBytes = npmResponseBody(finalDownload.response)
    requireEqual(sha256Hex(finalBytes), asset.sha256, `GitHub observer public asset ${asset.filename} changed after reread`)
    requireEqual(finalBytes.length, asset.sizeInBytes, `GitHub observer public asset ${asset.filename} final size mismatch`)
    requireEqual(finalRecord.apiSize, finalBytes.length, `GitHub observer public asset ${asset.filename} final API size mismatch`)
  }
  const finalReleaseResponse = await githubObserverAnonymousRequest(anonymousRequest, releaseUrl, deadlineControl, 'public-release-final-reread')
  if (finalReleaseResponse.status !== 200) return { complete: false, reason: 'public-release-final-unavailable', anonymous: true }
  const finalRelease = githubObserverRelease(githubObserverJson(finalReleaseResponse, 'public-release-final-reread'), publicDescriptor)
  if (finalRelease.id !== release.id || finalRelease.tag !== release.tag || finalRelease.title !== release.title || finalRelease.bodySha256 !== release.bodySha256 || finalRelease.targetCommitish !== release.targetCommitish || finalRelease.draft !== release.draft || finalRelease.prerelease !== release.prerelease || finalRelease.latest !== release.latest) return { complete: false, reason: 'public-release-changed', anonymous: true }
  const finalTagSource = await githubObserverTagSource(anonymousRequest, publicDescriptor, deadlineControl, 'public-tag-final', githubObserverAnonymousRequest)
  if (finalTagSource.sha !== tagSource.sha || finalTagSource.ref !== tagSource.ref || finalTagSource.type !== tagSource.type) return { complete: false, reason: 'public-tag-changed', anonymous: true }
  const effectiveLatest = await githubObserverEffectiveLatest(anonymousRequest, publicDescriptor, finalRelease, deadlineControl, 'public-effective-latest', githubObserverAnonymousRequest)
  if (effectiveLatest !== (publicDescriptor.latest === true)) return { complete: false, reason: 'public-latest-mismatch', anonymous: true }
  return { complete: true, anonymous: true, release: { id: release.id, tag: release.tag, title: release.title, bodySha256: release.bodySha256, targetCommitish: release.targetCommitish }, assets: publicAssets.sort((a, b) => a.filename.localeCompare(b.filename)), requestedByCaller: publicRead !== undefined }
}


/** Observe an existing GitHub release and assets through GET-only operations. */
export async function observeGitHubRelease(input, adapters = {}) {
  const outputFile = await npmInvalidateOutput(input?.outputFile, input?.workDir, 'GitHub observer output file', 'github-public-observation')
  const normalized = githubObserverInput(input)
  const baseRequest = adapters.request ?? npmDefaultRequest
  const anonymousRequest = adapters.anonymousRequest
  const request = adapters.githubReadToken === undefined ? baseRequest : githubCapabilityRequest(baseRequest, adapters.githubReadToken)
  const now = adapters.now ?? (() => performance.now())
  const workDir = npmSafePath(input.workDir, 'GitHub observer work directory')
  if ((await readdir(workDir, { withFileTypes: true })).length !== 0) fail('github-observe-work-directory-not-fresh')
  const deadlineControl = { now, deadline: now() + 600_000 }
  let snapshotEvidence
  let legacySnapshot
  if (normalized.plan === undefined && normalized.snapshot !== undefined) {
    legacySnapshot = await githubObserverSnapshot(normalized.snapshot, request, deadlineControl, workDir)
  }
  if (normalized.plan !== undefined && normalized.snapshot !== undefined && normalized.snapshot.mode !== 'preserved-manifest') {
    if (normalized.plan === undefined) fail('Release-set GitHub observer requires the validated plan for snapshot lineage')
    snapshotEvidence = await observeReleaseSetProofSnapshot({
      plan: normalized.plan,
      preparation: normalized.preparation,
      selector: normalized.snapshot,
      observer: normalized.observer,
      workDir,
      request,
      now,
      currentProducer: normalized.snapshot.mode === 'current',
      recoveryOptions: input.recoveryOptions ?? {},
    })
    normalized.descriptor = githubApplyReleaseSetDynamicHashes(normalized.descriptor, snapshotEvidence).descriptor
  }
  const repositoryPath = `/repos/${normalized.descriptor.repository}`
  const releaseListUrl = `${githubApiOrigin}${repositoryPath}/releases?per_page=100`
  const releases = await githubObserverPages(request, releaseListUrl, deadlineControl, 'release-list')
  const matches = releases.filter(release => release?.tag_name === normalized.descriptor.releaseTag)
  if (matches.length === 0) {
    if (normalized.descriptor.releaseId !== undefined) return { schemaVersion: 1, kind: 'github-public-observation', state: 'conflict', complete: false, reason: 'expected-release-id-not-found', repository: EXPECTED_REPOSITORY, repositoryId: EXPECTED_REPOSITORY_ID, tag: normalized.descriptor.releaseTag, sourceCommit: normalized.descriptor.sourceCommit, planSha256: input.planSha256, auth: { requested: false, uploadAttempted: false } }
    return { schemaVersion: 1, kind: 'github-public-observation', state: 'absent', complete: false, repository: EXPECTED_REPOSITORY, repositoryId: EXPECTED_REPOSITORY_ID, tag: normalized.descriptor.releaseTag, sourceCommit: normalized.descriptor.sourceCommit, planSha256: input.planSha256, auth: { requested: false, uploadAttempted: false } }
  }
  if (matches.length !== 1) fail('github-observe-release-match-ambiguous')
  const listedId = matches[0]?.id
  if (!Number.isSafeInteger(listedId) || listedId <= 0) fail('github-observe-release-ID-invalid')
  if (normalized.descriptor.releaseId !== undefined) requireEqual(listedId, Number(normalized.descriptor.releaseId), 'GitHub observer listed release ID mismatch')
  const releaseUrl = `${githubApiOrigin}${repositoryPath}/releases/${listedId}`
  const releaseResponse = await githubObserverRequest(request, releaseUrl, deadlineControl, 'release-reread')
  if (releaseResponse.status !== 200) fail(`github-observe-release-reread-http-${releaseResponse.status}`)
  const releasePayload = githubObserverJson(releaseResponse, 'release-reread')
  const release = githubObserverRelease(releasePayload, { ...normalized.descriptor, releaseId: listedId })
  const tagSource = await githubObserverTagSource(request, normalized.descriptor, deadlineControl, 'tag-source')
  const goTagSource = normalized.plan === undefined
    ? undefined
    : await githubObserverNamedTagSource(request, normalized.descriptor, normalized.plan.tags.go, deadlineControl, 'go-tag-source')
  if (release.targetCommitish !== normalized.descriptor.sourceCommit && release.targetCommitish !== normalized.descriptor.releaseTag) fail('GitHub observer source mismatch')
  const assetsUrl = `${githubApiOrigin}${repositoryPath}/releases/${listedId}/assets?per_page=100`
  if (normalized.snapshot?.mode === 'preserved-manifest') {
    if (normalized.plan === undefined || normalized.preparation === undefined) fail('Preserved manifest observation requires the validated plan and preparation')
    const listedAssets = await githubObserverPages(request, assetsUrl, deadlineControl, 'manifest-asset-list')
    const manifestRecords = listedAssets.filter(record => record?.name === 'release-set-proof-manifest.json')
    if (manifestRecords.length !== 1 || !Number.isSafeInteger(manifestRecords[0]?.id) || manifestRecords[0].id <= 0) return { schemaVersion: 1, kind: 'github-public-observation', state: 'incomplete', complete: false, reason: 'manifest-asset-missing', repository: EXPECTED_REPOSITORY, repositoryId: EXPECTED_REPOSITORY_ID, tag: normalized.descriptor.releaseTag, sourceCommit: normalized.descriptor.sourceCommit, planSha256: input.planSha256, auth: { requested: false, uploadAttempted: false } }
    const manifestDownload = await githubObserverRedirectBytes(request, `${githubApiOrigin}${repositoryPath}/releases/assets/${manifestRecords[0].id}`, deadlineControl, 'manifest-asset')
    const manifestBytes = npmResponseBody(manifestDownload.response)
    if (manifestRecords[0].digest !== undefined) requireEqual(manifestRecords[0].digest, `sha256:${sha256Hex(manifestBytes)}`, 'Release-set public manifest API digest mismatch')
    if (manifestRecords[0].size !== undefined) requireEqual(manifestRecords[0].size, manifestBytes.length, 'Release-set public manifest API size mismatch')
    let manifest
    try { manifest = JSON.parse(manifestBytes.toString('utf8')) } catch { fail('Release-set public manifest JSON is invalid') }
    const validatedManifest = validateReleaseSetProofManifest(manifest, { plan: normalized.plan, preparation: normalized.preparation })
    const nested = await observeReleaseSetProofSnapshot({ plan: normalized.plan, preparation: normalized.preparation, selector: { mode: 'current', snapshot: validatedManifest.snapshot, receiptArtifacts: validatedManifest.receiptArtifacts }, workDir, request, now, currentProducer: false, recoveryOptions: input.recoveryOptions ?? {} })
    requireEqual(Buffer.compare(Buffer.from(`${canonicalJson(nested.manifest)}\n`), manifestBytes), 0, 'Release-set public manifest bytes changed')
    snapshotEvidence = nested
    normalized.descriptor = githubApplyReleaseSetDynamicHashes(normalized.descriptor, snapshotEvidence).descriptor
  }
  const snapshot = snapshotEvidence === undefined ? legacySnapshot : {
    mode: snapshotEvidence.selector.mode,
    artifactId: snapshotEvidence.snapshot.artifactId,
    artifactName: snapshotEvidence.snapshot.artifactName,
    sha256: snapshotEvidence.snapshot.sha256,
    sizeInBytes: snapshotEvidence.snapshot.sizeInBytes,
    manifestSha256: sha256Hex(Buffer.from(`${canonicalJson(snapshotEvidence.manifest)}\n`)),
  }
  const initialAssets = githubObserverAssetMap(await githubObserverPages(request, assetsUrl, deadlineControl, 'asset-list'), normalized.descriptor)
  const missing = normalized.descriptor.assets.filter(asset => !initialAssets.actual.has(asset.filename)).map(asset => asset.filename)
  const observation = { release, assets: [], missing }
  if (initialAssets.actual.size !== normalized.descriptor.assets.length && missing.length === 0) fail('github-observe-asset-set-ambiguous')
  for (const descriptorAsset of normalized.descriptor.assets) {
    const record = initialAssets.actual.get(descriptorAsset.filename)
    if (!record) continue
    const downloadUrl = `${githubApiOrigin}${repositoryPath}/releases/assets/${record.id}`
    const downloaded = await githubObserverRedirectBytes(request, downloadUrl, deadlineControl, `asset-${record.id}`)
    const bytes = npmResponseBody(downloaded.response)
    const observedSha256 = sha256Hex(bytes)
    requireEqual(observedSha256, descriptorAsset.sha256, `GitHub observer asset ${descriptorAsset.filename} bytes mismatch`)
    requireEqual(bytes.length, descriptorAsset.sizeInBytes, `GitHub observer asset ${descriptorAsset.filename} size mismatch`)
    if (record.apiDigest !== undefined) requireEqual(record.apiDigest, `sha256:${observedSha256}`, `GitHub observer asset ${descriptorAsset.filename} API digest mismatch`)
    if (record.apiSize !== undefined) requireEqual(record.apiSize, bytes.length, `GitHub observer asset ${descriptorAsset.filename} API size mismatch`)
    observation.assets.push({ role: descriptorAsset.role, filename: descriptorAsset.filename, id: record.id, sha256: observedSha256, sizeInBytes: bytes.length })
  }
  const finalAssets = githubObserverAssetMap(await githubObserverPages(request, assetsUrl, deadlineControl, 'asset-final-list'), normalized.descriptor)
  if (finalAssets.actual.size !== initialAssets.actual.size || [...finalAssets.actual.entries()].some(([name, item]) => {
    const initial = initialAssets.actual.get(name)
    return initial?.id !== item.id || initial?.apiDigest !== item.apiDigest || initial?.apiSize !== item.apiSize
  })) fail('github-observe-asset-identity-changed')
  for (const observed of observation.assets) {
    const finalRecord = finalAssets.actual.get(observed.filename)
    const finalDownload = await githubObserverRedirectBytes(request, `${githubApiOrigin}${repositoryPath}/releases/assets/${finalRecord.id}`, deadlineControl, `asset-final-${finalRecord.id}`)
    const finalBytes = npmResponseBody(finalDownload.response)
    requireEqual(sha256Hex(finalBytes), observed.sha256, `GitHub observer asset ${observed.filename} changed after reread`)
    requireEqual(finalBytes.length, observed.sizeInBytes, `GitHub observer asset ${observed.filename} final size mismatch`)
    if (finalRecord.apiSize !== undefined) requireEqual(finalRecord.apiSize, finalBytes.length, `GitHub observer asset ${observed.filename} final API size mismatch`)
  }
  const finalReleaseResponse = await githubObserverRequest(request, releaseUrl, deadlineControl, 'release-final-reread')
  if (finalReleaseResponse.status !== 200) fail(`github-observe-release-final-http-${finalReleaseResponse.status}`)
  const finalRelease = githubObserverRelease(githubObserverJson(finalReleaseResponse, 'release-final-reread'), { ...normalized.descriptor, releaseId: listedId })
  const finalTagSource = await githubObserverTagSource(request, normalized.descriptor, deadlineControl, 'tag-final')
  const finalGoTagSource = goTagSource === undefined
    ? undefined
    : await githubObserverNamedTagSource(request, normalized.descriptor, normalized.plan.tags.go, deadlineControl, 'go-tag-final')
  if (finalTagSource.sha !== tagSource.sha || finalTagSource.ref !== tagSource.ref || finalTagSource.type !== tagSource.type) fail('github-observe-tag-changed')
  if (goTagSource !== undefined && (finalGoTagSource.sha !== goTagSource.sha || finalGoTagSource.ref !== goTagSource.ref || finalGoTagSource.type !== goTagSource.type)) fail('github-observe-go-tag-changed')
  if (finalRelease.bodySha256 !== release.bodySha256 || finalRelease.targetCommitish !== release.targetCommitish || finalRelease.draft !== release.draft || finalRelease.latest !== release.latest) fail('github-observe-release-changed')
  const effectiveLatest = await githubObserverEffectiveLatest(request, normalized.descriptor, finalRelease, deadlineControl, 'effective-latest')
  if (effectiveLatest !== (normalized.descriptor.latest === true)) fail('github-observe-effective-latest-mismatch')
  const snapshotRequired = (normalized.plan === undefined ? normalized.requireSnapshot === true : normalized.snapshot === undefined && normalized.requireSnapshot === true)
  const state = snapshotRequired ? 'incomplete' : release.draft ? 'matching-draft' : 'matching-public'
  const publicRequested = normalized.descriptor.requirePublic === true || input.publicRead !== undefined
  const publicRead = publicRequested
    ? typeof anonymousRequest === 'function' && anonymousRequest !== baseRequest
      ? await githubObserverPublicRead(input.publicRead ?? {}, normalized.descriptor, release, observation.assets, anonymousRequest, deadlineControl)
      : { complete: false, anonymous: true, reason: 'anonymous-read-unavailable' }
    : undefined
  const complete = (snapshotEvidence !== undefined || legacySnapshot !== undefined || normalized.plan === undefined) && !snapshotRequired && !release.draft && missing.length === 0 && observation.assets.length === normalized.descriptor.assets.length && (publicRead?.anonymous === true && publicRead?.complete === true)
  const receipt = { schemaVersion: 1, kind: 'github-public-observation', state, complete, snapshotRequired, repository: EXPECTED_REPOSITORY, repositoryId: EXPECTED_REPOSITORY_ID, release, assets: observation.assets.sort((a, b) => a.filename.localeCompare(b.filename)), missingAssets: missing, snapshot, publicRead, planSha256: input.planSha256, preparation: input.preparation, observer: input.observer, auth: { requested: false, uploadAttempted: false }, observedAt: new Date().toISOString() }
  if (!complete) return receipt
  const temporaryOutput = `${outputFile}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  npmCheckDeadline(now, deadlineControl.deadline)
  await writeFile(temporaryOutput, `${canonicalJson(receipt)}\n`, { flag: 'wx' })
  try { npmCheckDeadline(now, deadlineControl.deadline); await rename(temporaryOutput, outputFile); npmCheckDeadline(now, deadlineControl.deadline) } catch (error) { await rm(temporaryOutput, { force: true }).catch(() => {}); await rm(outputFile, { force: true }).catch(() => {}); throw error }
  return receipt
}

export function validateReleaseSetPreparationMetadata({ plan, run, artifact, bindingArtifact, expected }) {
  const normalized = validateReleaseSetPlan(plan)
  const runId = requireFuturePositiveId(expected.runId, 'Release-set preparation run ID')
  const runAttempt = requireFuturePositiveId(expected.runAttempt, 'Release-set preparation attempt')
  const artifactId = requireFuturePositiveId(expected.artifactId, 'Release-set preparation artifact ID')
  const bindingArtifactId = requireFuturePositiveId(expected.bindingArtifactId, 'Release-set binding artifact ID')
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

const releaseSetExecutionContextFromEnv = () => ({
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
})

const optionalReleaseSetEnv = name => process.env[name] === undefined || process.env[name] === '' ? undefined : process.env[name]

const run = async arguments_ => {
  if (arguments_[0] === '--release-set-ci-select') {
    requireExactInternalMode(arguments_, '--release-set-ci-select')
    const selection = selectFoundationCIRun({
      workflow: JSON.parse(await readFile(env('RELEASE_SET_CI_WORKFLOW_FILE'), 'utf8')),
      runs: JSON.parse(await readFile(env('RELEASE_SET_CI_RUNS_FILE'), 'utf8')),
      expected: { sourceCommit: env('EXPECTED_COMMIT') },
    })
    await writeFile(env('RELEASE_SET_CI_SELECTION_FILE'), `${canonicalJson(selection)}\n`)
    console.log(`release-set-ci-selection=${canonicalJson(selection)}`)
    return
  }

  if (arguments_[0] === '--release-set-ci-proof') {
    requireExactInternalMode(arguments_, '--release-set-ci-proof')
    const evidence = validateReleaseSetCIEvidence({
      workflow: JSON.parse(await readFile(env('RELEASE_SET_CI_WORKFLOW_FILE'), 'utf8')),
      runs: JSON.parse(await readFile(env('RELEASE_SET_CI_RUNS_FILE'), 'utf8')),
      selection: JSON.parse(await readFile(env('RELEASE_SET_CI_SELECTION_FILE'), 'utf8')),
      recheck: JSON.parse(await readFile(env('RELEASE_SET_CI_RECHECK_FILE'), 'utf8')),
      jobs: JSON.parse(await readFile(env('RELEASE_SET_CI_JOBS_FILE'), 'utf8')),
    }, env('EXPECTED_COMMIT'))
    await writeFile(env('RELEASE_SET_CI_EVIDENCE_FILE'), `${canonicalJson({
      workflow: JSON.parse(await readFile(env('RELEASE_SET_CI_WORKFLOW_FILE'), 'utf8')),
      runs: JSON.parse(await readFile(env('RELEASE_SET_CI_RUNS_FILE'), 'utf8')),
      selection: JSON.parse(await readFile(env('RELEASE_SET_CI_SELECTION_FILE'), 'utf8')),
      recheck: JSON.parse(await readFile(env('RELEASE_SET_CI_RECHECK_FILE'), 'utf8')),
      jobs: JSON.parse(await readFile(env('RELEASE_SET_CI_JOBS_FILE'), 'utf8')),
    })}\n`)
    console.log(`release-set-ci-proof=${canonicalJson(evidence)}`)
    return
  }

  if (arguments_[0] === '--release-set-prepare-guard') {
    requireExactInternalMode(arguments_, '--release-set-prepare-guard')
    const context = releaseSetExecutionContextFromEnv()
    const template = JSON.parse(await readFile(env('RELEASE_SET_PLAN_TEMPLATE_FILE'), 'utf8'))
    validateReleaseSetTemplateIdentity(template, context)
    if (process.env.RELEASE_SET_CI_EVIDENCE_FILE === undefined) fail('Release-set preparation requires actual CI evidence')
    validateReleaseSetCIEvidence(JSON.parse(await readFile(process.env.RELEASE_SET_CI_EVIDENCE_FILE, 'utf8')), context.expectedCommit)
    if (optionalReleaseSetEnv('RELEASE_SET_PLAN_SHA256') !== undefined) requireArchiveSha(optionalReleaseSetEnv('RELEASE_SET_PLAN_SHA256'), 'Release-set reviewed plan digest')
    console.log('release-set-prepare-guard-passed')
    return
  }

  if (arguments_[0] === '--release-set-preflight') {
    requireExactInternalMode(arguments_, '--release-set-preflight')
    const plan = JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8'))
    const responses = JSON.parse(await readFile(env('RELEASE_SET_PREFLIGHT_INPUT_FILE'), 'utf8'))
    const result = classifyReleaseSetPreflight({ plan, responses })
    await writeFile(env('RELEASE_SET_PREFLIGHT_OUTPUT_FILE'), `${canonicalJson(result)}\n`)
    console.log(`release-set-preflight=${sha256Hex(canonicalJson(result))}`)
    return
  }

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
    const digest = releaseSetPlanDigest(plan)
    if (optionalReleaseSetEnv('RELEASE_SET_PLAN_SHA256') !== undefined) requireEqual(optionalReleaseSetEnv('RELEASE_SET_PLAN_SHA256'), digest, 'Release-set reviewed plan digest mismatch')
    console.log(`release-set-plan=${digest}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-context') {
    requireExactInternalMode(arguments_, '--publication-recovery-context')
    const runtime = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_RUNTIME_FILE'), 'utf8'))
    const originalRun = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PUBLICATION_RUN_FILE'), 'utf8'))
    const jobsPayload = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PUBLICATION_JOBS_FILE'), 'utf8'))
    const jobs = Array.isArray(jobsPayload) ? jobsPayload : jobsPayload.jobs
    const outcomes = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PUBLICATION_OUTCOMES_FILE'), 'utf8'))
    validatePublicationRecoveryOriginalPublication({ run: originalRun, jobs, outcomes })
    const preparation = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PREPARATION_FILE'), 'utf8'))
    const ciProof = process.env.PUBLICATION_RECOVERY_CI_PROOF_FILE === undefined
      ? undefined
      : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_CI_PROOF_FILE, 'utf8'))
    const sourceCiProof = process.env.PUBLICATION_RECOVERY_SOURCE_CI_PROOF_FILE === undefined
      ? undefined
      : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_SOURCE_CI_PROOF_FILE, 'utf8'))
    const context = buildPublicationRecoveryContext({
      runtime,
      preparation,
      originalPublication: { runId: String(originalRun.id), runAttempt: String(originalRun.run_attempt), sourceCommit: originalRun.head_sha, workflowPath: originalRun.path, status: originalRun.status, conclusion: originalRun.conclusion, jobOutcomes: jobs, outcomes },
      recoveryRun: { runId: env('GITHUB_RUN_ID'), runAttempt: env('GITHUB_RUN_ATTEMPT') },
      ciProof,
      sourceCiProof,
    })
    validatePublicationRecoveryContext(context, { requireCiProof: ciProof !== undefined })
    await writeFile(env('PUBLICATION_RECOVERY_CONTEXT_OUTPUT_FILE'), `${canonicalJson(context)}\n`)
    console.log(`publication-recovery-context=${context.contextSha256}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-context-verify') {
    requireExactInternalMode(arguments_, '--publication-recovery-context-verify')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: process.env.PUBLICATION_RECOVERY_REQUIRE_CI_PROOF === 'true' })
    console.log(`publication-recovery-context-verified=${context.contextSha256}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-bundle') {
    requireExactInternalMode(arguments_, '--publication-recovery-bundle')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const plan = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PLAN_FILE'), 'utf8'))
    const binding = process.env.PUBLICATION_RECOVERY_BINDING_FILE === undefined
      ? undefined
      : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_BINDING_FILE, 'utf8'))
    const evidence = await validatePublicationRecoveryBundle({ plan, artifactDirectory: env('PUBLICATION_RECOVERY_ARTIFACT_DIR'), binding, bindingArtifactId: process.env.PUBLICATION_RECOVERY_BINDING_ARTIFACT_ID, bundleZip: process.env.PUBLICATION_RECOVERY_BUNDLE_ZIP_FILE, bindingZip: process.env.PUBLICATION_RECOVERY_BINDING_ZIP_FILE, bundleMetadata: process.env.PUBLICATION_RECOVERY_BUNDLE_METADATA_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_BUNDLE_METADATA_FILE, 'utf8')), bindingMetadata: process.env.PUBLICATION_RECOVERY_BINDING_METADATA_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_BINDING_METADATA_FILE, 'utf8')), bindingDirectory: process.env.PUBLICATION_RECOVERY_BINDING_DIR })
    if (process.env.PUBLICATION_RECOVERY_BUNDLE_OUTPUT_FILE !== undefined) await writeFile(process.env.PUBLICATION_RECOVERY_BUNDLE_OUTPUT_FILE, `${canonicalJson(evidence)}\n`)
    console.log(`publication-recovery-bundle=${evidence.planSha256}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-preflight') {
    requireExactInternalMode(arguments_, '--publication-recovery-preflight')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const result = classifyPublicationRecoveryPreflight({ ...JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PREFLIGHT_INPUT_FILE'), 'utf8')), controlCommit: context.controlCommit })
    await writeFile(env('PUBLICATION_RECOVERY_PREFLIGHT_OUTPUT_FILE'), `${canonicalJson(result)}\n`)
    console.log(`publication-recovery-preflight=${canonicalJson({ state: result.state, missing: result.missing })}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-receipt') {
    requireExactInternalMode(arguments_, '--publication-recovery-receipt')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    const kind = env('PUBLICATION_RECOVERY_RECEIPT_KIND')
    const receipt = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_RECEIPT_FILE'), 'utf8'))
    const expected = kind === 'npm' ? PUBLICATION_RECOVERY_NPM_SHA256 : kind === 'rubygems' ? PUBLICATION_RECOVERY_RUBYGEMS_SHA256 : kind === 'rust' ? RUST_011_REUSE_SHA256 : undefined
    validatePublicationRecoveryReceipt(receipt, { kind, context, expectedSha256: expected, pypiPublisherSource: kind === 'pypi' ? context.controlCommit : undefined })
    console.log(`publication-recovery-receipt=${kind}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-npm-observe') {
    requireExactInternalMode(arguments_, '--publication-recovery-npm-observe')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PLAN_FILE'), 'utf8')))
    const receipt = await observeNpmRelease({
      descriptor: plan.artifacts.find(artifact => artifact.kind === 'npm'),
      planSha256: PUBLICATION_RECOVERY_PLAN_SHA256,
      preparation: context.preparation,
      publisher: JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PUBLISHER_FILE'), 'utf8')),
      observer: { runId: env('PUBLICATION_RECOVERY_OBSERVER_RUN_ID'), runAttempt: env('PUBLICATION_RECOVERY_OBSERVER_ATTEMPT'), workflowPath: RELEASE_SET_WORKFLOW, sourceCommit: context.controlCommit },
      recoveryContext: context,
      workDir: env('PUBLICATION_RECOVERY_WORK_DIR'),
      outputFile: env('PUBLICATION_RECOVERY_OUTPUT_FILE'),
      toolPaths: { node: env('PUBLICATION_RECOVERY_NODE'), npmCli: env('PUBLICATION_RECOVERY_NPM_CLI'), python: env('PUBLICATION_RECOVERY_PYTHON') },
    })
    console.log(`publication-recovery-npm=${receipt.descriptor.observedSha256}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-pypi-observe') {
    requireExactInternalMode(arguments_, '--publication-recovery-pypi-observe')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PLAN_FILE'), 'utf8')))
    const receipt = await observePyPIRelease({
      descriptors: { 'pypi-wheel': plan.artifacts.find(artifact => artifact.kind === 'pypi-wheel'), 'pypi-sdist': plan.artifacts.find(artifact => artifact.kind === 'pypi-sdist') },
      planSha256: PUBLICATION_RECOVERY_PLAN_SHA256,
      preparation: context.preparation,
      publishers: JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PUBLISHERS_FILE'), 'utf8')),
      publisherSources: process.env.PUBLICATION_RECOVERY_PUBLISHER_SOURCES_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_PUBLISHER_SOURCES_FILE, 'utf8')),
      observer: { runId: env('PUBLICATION_RECOVERY_OBSERVER_RUN_ID'), runAttempt: env('PUBLICATION_RECOVERY_OBSERVER_ATTEMPT'), workflowPath: RELEASE_SET_WORKFLOW, sourceCommit: context.controlCommit },
      recoveryContext: context,
      workDir: env('PUBLICATION_RECOVERY_WORK_DIR'),
      outputFile: env('PUBLICATION_RECOVERY_OUTPUT_FILE'),
      toolPaths: { python: env('PUBLICATION_RECOVERY_PYTHON') },
    })
    console.log(`publication-recovery-pypi=${receipt.version}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-pypi-existing-observe') {
    requireExactInternalMode(arguments_, '--publication-recovery-pypi-existing-observe')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PLAN_FILE'), 'utf8')))
    const receipt = await observePyPIRelease({
      descriptors: { 'pypi-wheel': plan.artifacts.find(artifact => artifact.kind === 'pypi-wheel'), 'pypi-sdist': plan.artifacts.find(artifact => artifact.kind === 'pypi-sdist') },
      planSha256: PUBLICATION_RECOVERY_PLAN_SHA256,
      preparation: context.preparation,
      publishers: JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PUBLISHERS_FILE'), 'utf8')),
      publisherSources: process.env.PUBLICATION_RECOVERY_PUBLISHER_SOURCES_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_PUBLISHER_SOURCES_FILE, 'utf8')),
      observer: { runId: env('PUBLICATION_RECOVERY_OBSERVER_RUN_ID'), runAttempt: env('PUBLICATION_RECOVERY_OBSERVER_ATTEMPT'), workflowPath: RELEASE_SET_WORKFLOW, sourceCommit: context.controlCommit },
      recoveryContext: context,
      workDir: env('PUBLICATION_RECOVERY_WORK_DIR'),
      outputFile: env('PUBLICATION_RECOVERY_OUTPUT_FILE'),
      toolPaths: { python: env('PUBLICATION_RECOVERY_PYTHON') },
    })
    const enriched = { ...receipt, recoveryContextSha256: context.contextSha256 }
    await writeFile(env('PUBLICATION_RECOVERY_OUTPUT_FILE'), `${canonicalJson(enriched)}\n`)
    console.log(`publication-recovery-pypi-existing=${receipt.version}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-rubygems-observe') {
    requireExactInternalMode(arguments_, '--publication-recovery-rubygems-observe')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PLAN_FILE'), 'utf8')))
    const receipt = await observeRubyGemsRelease({
      descriptor: plan.artifacts.find(artifact => artifact.kind === 'rubygems'),
      planSha256: PUBLICATION_RECOVERY_PLAN_SHA256,
      preparation: context.preparation,
      observer: { runId: env('PUBLICATION_RECOVERY_OBSERVER_RUN_ID'), runAttempt: env('PUBLICATION_RECOVERY_OBSERVER_ATTEMPT'), workflowPath: RELEASE_SET_WORKFLOW, sourceCommit: context.controlCommit },
      recoveryContext: context,
      workDir: env('PUBLICATION_RECOVERY_WORK_DIR'),
      outputFile: env('PUBLICATION_RECOVERY_OUTPUT_FILE'),
      toolPaths: { ruby31: env('PUBLICATION_RECOVERY_RUBY31'), ruby34: env('PUBLICATION_RECOVERY_RUBY34') },
    })
    console.log(`publication-recovery-rubygems=${receipt.download.sha256}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-rust-observe') {
    requireExactInternalMode(arguments_, '--publication-recovery-rust-observe')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PLAN_FILE'), 'utf8')))
    const receipt = await observeRustArtifact({
      descriptor: plan.rust,
      planSha256: PUBLICATION_RECOVERY_PLAN_SHA256,
      preparation: context.preparation,
      observer: { runId: env('PUBLICATION_RECOVERY_OBSERVER_RUN_ID'), runAttempt: env('PUBLICATION_RECOVERY_OBSERVER_ATTEMPT'), workflowPath: RELEASE_SET_WORKFLOW, sourceCommit: context.controlCommit },
      recoveryContext: context,
      workDir: env('PUBLICATION_RECOVERY_WORK_DIR'),
      outputFile: env('PUBLICATION_RECOVERY_OUTPUT_FILE'),
    })
    console.log(`publication-recovery-rust=${receipt.download.sha256}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-go-observe') {
    requireExactInternalMode(arguments_, '--publication-recovery-go-observe')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PLAN_FILE'), 'utf8')))
    const receipt = await observeGoModule({
      descriptor: plan.go,
      planSha256: PUBLICATION_RECOVERY_PLAN_SHA256,
      preparation: context.preparation,
      observer: { runId: env('PUBLICATION_RECOVERY_OBSERVER_RUN_ID'), runAttempt: env('PUBLICATION_RECOVERY_OBSERVER_ATTEMPT'), workflowPath: RELEASE_SET_WORKFLOW, sourceCommit: context.controlCommit },
      workDir: env('PUBLICATION_RECOVERY_WORK_DIR'),
      outputFile: env('PUBLICATION_RECOVERY_OUTPUT_FILE'),
      toolPaths: { go: env('PUBLICATION_RECOVERY_GO'), git: env('PUBLICATION_RECOVERY_GIT'), python3: env('PUBLICATION_RECOVERY_PYTHON') },
    })
    console.log(`publication-recovery-go=${receipt.sourceCommit}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-snapshot') {
    requireExactInternalMode(arguments_, '--publication-recovery-snapshot')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PLAN_FILE'), 'utf8')))
    const snapshot = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_SNAPSHOT_BINDING_FILE'), 'utf8'))
    const receiptArtifacts = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_RECEIPT_ARTIFACTS_FILE'), 'utf8'))
    const publisherSources = process.env.PUBLICATION_RECOVERY_PUBLISHER_SOURCES_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_PUBLISHER_SOURCES_FILE, 'utf8'))
    const observerSources = process.env.PUBLICATION_RECOVERY_OBSERVER_SOURCES_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_OBSERVER_SOURCES_FILE, 'utf8'))
    const token = await readReleaseSetGithubReadTokenFd(process.env.PUBLICATION_RECOVERY_READ_TOKEN_FD)
    const request = githubCapabilityRequest(npmDefaultRequest, token)
    const result = await observeReleaseSetProofSnapshot({ plan, preparation: context.preparation, selector: { mode: 'current', snapshot, receiptArtifacts }, observer: { runId: env('PUBLICATION_RECOVERY_OBSERVER_RUN_ID'), runAttempt: env('PUBLICATION_RECOVERY_OBSERVER_ATTEMPT'), workflowPath: RELEASE_SET_WORKFLOW, sourceCommit: context.controlCommit }, workDir: env('PUBLICATION_RECOVERY_SNAPSHOT_WORK_DIR'), request, currentProducer: true, recoveryOptions: { recovery: true, context, contextSha256: context.contextSha256, observerSourceCommit: context.controlCommit, observerSources, publisherSources, historicalReceiptFiles: ['rubygems-proof.json'] } })
    validateReleaseSetProofManifest(result.manifest, { plan, preparation: context.preparation })
    await writeFile(env('PUBLICATION_RECOVERY_MANIFEST_OUTPUT_FILE'), `${canonicalJson(result.manifest)}\n`)
    const receiptDir = npmSafePath(env('PUBLICATION_RECOVERY_RECEIPT_OUTPUT_DIR'), 'Publication recovery receipt output directory')
    for (const [filename, bytes] of Object.entries(result.receiptBytes)) await writeFile(join(receiptDir, filename), bytes, { flag: 'wx' })
    console.log(`publication-recovery-snapshot=${sha256Hex(canonicalJson(result.manifest))}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-receipts') {
    requireExactInternalMode(arguments_, '--publication-recovery-receipts')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PLAN_FILE'), 'utf8')))
    const receiptArtifacts = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_RECEIPT_ARTIFACTS_FILE'), 'utf8'))
    const publisherSources = process.env.PUBLICATION_RECOVERY_PUBLISHER_SOURCES_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_PUBLISHER_SOURCES_FILE, 'utf8'))
    const observerSources = process.env.PUBLICATION_RECOVERY_OBSERVER_SOURCES_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_OBSERVER_SOURCES_FILE, 'utf8'))
    const token = await readReleaseSetGithubReadTokenFd(process.env.PUBLICATION_RECOVERY_READ_TOKEN_FD)
    const filenames = process.env.PUBLICATION_RECOVERY_RECEIPT_FILENAMES === undefined ? ['npm-proof.json', 'pypi-proof.json', 'rubygems-proof.json'] : process.env.PUBLICATION_RECOVERY_RECEIPT_FILENAMES.split(',').filter(Boolean)
    const result = await observeReleaseSetReceiptArtifacts({ plan, preparation: context.preparation, receiptArtifacts, filenames, observer: { runId: env('PUBLICATION_RECOVERY_OBSERVER_RUN_ID'), runAttempt: env('PUBLICATION_RECOVERY_OBSERVER_ATTEMPT'), workflowPath: RELEASE_SET_WORKFLOW, sourceCommit: context.controlCommit }, workDir: env('PUBLICATION_RECOVERY_RECEIPT_WORK_DIR'), request: githubCapabilityRequest(npmDefaultRequest, token), currentProducer: true, recoveryOptions: { recovery: true, context, contextSha256: context.contextSha256, observerSourceCommit: context.controlCommit, observerSources, publisherSources, historicalReceiptFiles: ['rubygems-proof.json'] } })
    await writeFile(env('PUBLICATION_RECOVERY_RECEIPT_OBSERVATION_FILE'), `${canonicalJson({ receipts: result.receipts, receiptArtifacts: result.receiptArtifacts, producerRuns: result.producerRuns })}\n`)
    console.log(`publication-recovery-receipts=${sha256Hex(canonicalJson(result.receipts))}`)
    return
  }

  if (arguments_[0] === '--publication-recovery-github-observe') {
    requireExactInternalMode(arguments_, '--publication-recovery-github-observe')
    const context = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_CONTEXT_FILE'), 'utf8'))
    validatePublicationRecoveryContext(context, { requireCiProof: true })
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('PUBLICATION_RECOVERY_PLAN_FILE'), 'utf8')))
    const descriptor = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_GITHUB_DESCRIPTOR_FILE'), 'utf8'))
    await validateGitHubReleaseDescriptor({ plan, descriptor, artifactDirectory: env('PUBLICATION_RECOVERY_ARTIFACT_DIR') })
    const snapshot = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_SNAPSHOT_BINDING_FILE'), 'utf8'))
    const receiptArtifacts = JSON.parse(await readFile(env('PUBLICATION_RECOVERY_RECEIPT_ARTIFACTS_FILE'), 'utf8'))
    const publisherSources = process.env.PUBLICATION_RECOVERY_PUBLISHER_SOURCES_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_PUBLISHER_SOURCES_FILE, 'utf8'))
    const observerSources = process.env.PUBLICATION_RECOVERY_OBSERVER_SOURCES_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.PUBLICATION_RECOVERY_OBSERVER_SOURCES_FILE, 'utf8'))
    const token = await readReleaseSetGithubReadTokenFd(process.env.PUBLICATION_RECOVERY_READ_TOKEN_FD)
    const receipt = await observeGitHubRelease({ plan, descriptor, planSha256: PUBLICATION_RECOVERY_PLAN_SHA256, preparation: context.preparation, observer: { runId: env('PUBLICATION_RECOVERY_OBSERVER_RUN_ID'), runAttempt: env('PUBLICATION_RECOVERY_OBSERVER_ATTEMPT'), workflowPath: RELEASE_SET_WORKFLOW, sourceCommit: context.controlCommit }, workDir: env('PUBLICATION_RECOVERY_GITHUB_WORK_DIR'), outputFile: env('PUBLICATION_RECOVERY_GITHUB_OUTPUT_FILE'), snapshot: { mode: 'current', snapshot, receiptArtifacts }, requireSnapshot: true, recoveryOptions: { recovery: true, context, contextSha256: context.contextSha256, observerSourceCommit: context.controlCommit, observerSources, publisherSources, historicalReceiptFiles: ['rubygems-proof.json'] } }, { githubReadToken: token, anonymousRequest: githubAnonymousDefaultRequest })
    if (receipt.complete !== true || receipt.state !== 'matching-public' || receipt.publicRead?.complete !== true) fail('publication-recovery-github-observation-incomplete')
    await writeFile(env('PUBLICATION_RECOVERY_GITHUB_OUTPUT_FILE'), `${canonicalJson(receipt)}\n`)
    console.log(`publication-recovery-github=${sha256Hex(canonicalJson(receipt))}`)
    return
  }

  if (arguments_[0] === '--release-set-prepare') {
    requireExactInternalMode(arguments_, '--release-set-prepare')
    const artifactDirectory = env('RELEASE_SET_ARTIFACT_DIR')
    const planFile = env('RELEASE_SET_PLAN_FILE')
    const context = releaseSetExecutionContextFromEnv()
    let plan
    if (process.env.RELEASE_SET_PLAN_TEMPLATE_FILE !== undefined) {
      plan = await prepareReleaseSetBundle({
        template: JSON.parse(await readFile(process.env.RELEASE_SET_PLAN_TEMPLATE_FILE, 'utf8')),
        artifactDirectory,
        goRoot: env('RELEASE_SET_GO_ROOT'),
        planFile,
        context,
        ciEvidence: process.env.RELEASE_SET_CI_EVIDENCE_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.RELEASE_SET_CI_EVIDENCE_FILE, 'utf8')),
        reviewedPlanSha256: optionalReleaseSetEnv('RELEASE_SET_PLAN_SHA256'),
      })
    } else plan = validateReleaseSetPlan(JSON.parse(await readFile(planFile, 'utf8')))
    validateReleaseSetContext(context, plan)
    const planSha256 = releaseSetPlanDigest(plan)
    if (optionalReleaseSetEnv('RELEASE_SET_PLAN_SHA256') !== undefined) requireEqual(optionalReleaseSetEnv('RELEASE_SET_PLAN_SHA256'), planSha256, 'Release-set reviewed plan digest mismatch')
    const result = { ...(await ingestReleaseSetBundle({ plan, artifactDirectory })), planSha256, prepared: true }
    if (process.env.RELEASE_SET_PREPARED_EVIDENCE_FILE !== undefined) await writeFile(process.env.RELEASE_SET_PREPARED_EVIDENCE_FILE, `${canonicalJson(result)}\n`)
    if (process.env.RELEASE_SET_PLAN_DIGEST_OUTPUT !== undefined) await writeFile(process.env.RELEASE_SET_PLAN_DIGEST_OUTPUT, `${planSha256}\n`)
    console.log(`release-set-prepare=${result.planSha256}`)
    return
  }

  if (arguments_[0] === '--release-set-assemble') {
    requireExactInternalMode(arguments_, '--release-set-assemble')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const preparation = JSON.parse(await readFile(env('RELEASE_SET_PREPARATION_FILE'), 'utf8'))
    const snapshot = JSON.parse(await readFile(env('RELEASE_SET_SNAPSHOT_BINDING_FILE'), 'utf8'))
    const receiptArtifacts = JSON.parse(await readFile(env('RELEASE_SET_RECEIPT_ARTIFACTS_FILE'), 'utf8'))
    const receipts = {}
    const receiptBytes = {}
    for (const filename of RELEASE_SET_RECEIPT_FILENAMES) {
      receiptBytes[filename] = await readFile(join(env('RELEASE_SET_RECEIPTS_DIR'), filename))
      try { receipts[filename] = JSON.parse(receiptBytes[filename].toString('utf8')) } catch { fail(`Release-set ${filename} receipt JSON is invalid`) }
    }
    const manifest = buildReleaseSetProofManifest({ plan, preparation, snapshot, receipts, receiptBytes, receiptArtifacts })
    const outputFile = env('RELEASE_SET_MANIFEST_FILE')
    await writeFile(outputFile, `${canonicalJson(manifest)}\n`, { flag: 'wx' })
    console.log(`release-set-manifest=${sha256Hex(`${canonicalJson(manifest)}\n`)}`)
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
      preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 },
      publisher,
      observer: { runId: env('RELEASE_SET_NPM_OBSERVER_RUN_ID'), runAttempt: env('RELEASE_SET_NPM_OBSERVER_ATTEMPT'), workflowPath: env('RELEASE_SET_NPM_OBSERVER_WORKFLOW'), sourceCommit: observerSource },
      workDir: env('RELEASE_SET_NPM_WORK_DIR'), outputFile,
      toolPaths: { node: env('RELEASE_SET_NPM_NODE'), npmCli: env('RELEASE_SET_NPM_CLI'), python: env('RELEASE_SET_NPM_PYTHON') },
    })
    console.log(`npm-public-observation=${sha256Hex(canonicalJson(receipt))}`)
    return
  }

  if (arguments_[0] === '--release-set-pypi-observe') {
    const outputFile = await npmInvalidateOutput(process.env.RELEASE_SET_PYPI_OUTPUT_FILE, process.env.RELEASE_SET_PYPI_WORK_DIR, 'PyPI observer output file', 'pypi-public-observation')
    requireExactInternalMode(arguments_, '--release-set-pypi-observe')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const planSha256 = env('RELEASE_SET_PLAN_SHA256'); requireEqual(releaseSetPlanDigest(plan), planSha256, 'PyPI observer plan digest mismatch')
    const context = { repository: env('REPOSITORY'), repositoryId: env('REPOSITORY_ID'), eventName: env('EVENT_NAME'), eventRef: env('EVENT_REF'), eventSha: env('EVENT_SHA'), expectedCommit: env('EXPECTED_COMMIT'), checkoutHead: env('CHECKOUT_HEAD'), checkoutStatus: env('CHECKOUT_STATUS'), workflowRef: env('WORKFLOW_REF'), workflowSha: env('WORKFLOW_SHA') }
    validateReleaseSetContext(context, plan)
    const preparedExpected = { runId: env('RELEASE_SET_PREPARED_RUN_ID'), runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'), artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'), bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'), sourceCommit: plan.sourceCommit, bundleName: `release-set-bundle-${plan.sourceCommit}`, bindingName: `release-set-binding-${env('RELEASE_SET_PREPARED_RUN_ID')}-${env('RELEASE_SET_PREPARED_RUN_ATTEMPT')}` }
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    const preparation = await verifyReleaseSetPreparation({ plan, context, run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')), artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')), bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')), binding, bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'), bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'), artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'), bindingDirectory: env('RELEASE_SET_BINDING_DIR'), expected: preparedExpected })
    const observerSource = env('RELEASE_SET_PYPI_OBSERVER_SOURCE'); requireEqual(observerSource, context.eventSha, 'PyPI observer source must bind to execution context')
    const publishers = JSON.parse(await readFile(env('RELEASE_SET_PYPI_PUBLISHERS_FILE'), 'utf8'))
    const receipt = await observePyPIRelease({ descriptors: { 'pypi-wheel': plan.artifacts.find(artifact => artifact.kind === 'pypi-wheel'), 'pypi-sdist': plan.artifacts.find(artifact => artifact.kind === 'pypi-sdist') }, planSha256, preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 }, publishers, observer: { runId: env('RELEASE_SET_PYPI_OBSERVER_RUN_ID'), runAttempt: env('RELEASE_SET_PYPI_OBSERVER_ATTEMPT'), workflowPath: env('RELEASE_SET_PYPI_OBSERVER_WORKFLOW'), sourceCommit: observerSource }, workDir: env('RELEASE_SET_PYPI_WORK_DIR'), outputFile, toolPaths: { python: env('RELEASE_SET_PYPI_PYTHON') } })
    if (receipt.state === 'partial' && optionalReleaseSetEnv('RELEASE_SET_PYPI_PREFLIGHT_ONLY') === 'true') {
      await writeFile(outputFile, `${canonicalJson(receipt)}\n`)
      console.log(`pypi-public-observation-partial=${sha256Hex(canonicalJson(receipt))}`)
      return
    }
    if (receipt.state !== 'observed' || receipt.complete !== true) fail('pypi-public-observation-incomplete')
    console.log(`pypi-public-observation=${sha256Hex(canonicalJson(receipt))}`)
    return
  }

  if (arguments_[0] === '--release-set-rubygems-observe') {
    const outputFile = await npmInvalidateOutput(process.env.RELEASE_SET_RUBYGEMS_OUTPUT_FILE, process.env.RELEASE_SET_RUBYGEMS_WORK_DIR, 'RubyGems observer output file', 'rubygems-public-observation')
    requireExactInternalMode(arguments_, '--release-set-rubygems-observe')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const planSha256 = env('RELEASE_SET_PLAN_SHA256')
    requireEqual(releaseSetPlanDigest(plan), planSha256, 'RubyGems observer plan digest mismatch')
    const context = { repository: env('REPOSITORY'), repositoryId: env('REPOSITORY_ID'), eventName: env('EVENT_NAME'), eventRef: env('EVENT_REF'), eventSha: env('EVENT_SHA'), expectedCommit: env('EXPECTED_COMMIT'), checkoutHead: env('CHECKOUT_HEAD'), checkoutStatus: env('CHECKOUT_STATUS'), workflowRef: env('WORKFLOW_REF'), workflowSha: env('WORKFLOW_SHA') }
    validateReleaseSetContext(context, plan)
    const preparedExpected = { runId: env('RELEASE_SET_PREPARED_RUN_ID'), runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'), artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'), bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'), sourceCommit: plan.sourceCommit, bundleName: `release-set-bundle-${plan.sourceCommit}`, bindingName: `release-set-binding-${env('RELEASE_SET_PREPARED_RUN_ID')}-${env('RELEASE_SET_PREPARED_RUN_ATTEMPT')}` }
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    const preparation = await verifyReleaseSetPreparation({ plan, context, run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')), artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')), bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')), binding, bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'), bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'), artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'), bindingDirectory: env('RELEASE_SET_BINDING_DIR'), expected: preparedExpected })
    const observerSource = env('RELEASE_SET_RUBYGEMS_OBSERVER_SOURCE')
    requireEqual(observerSource, context.eventSha, 'RubyGems observer source must bind to execution context')
    const receipt = await observeRubyGemsRelease({ descriptor: plan.artifacts.find(artifact => artifact.kind === 'rubygems'), planSha256, preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 }, observer: { runId: env('RELEASE_SET_RUBYGEMS_OBSERVER_RUN_ID'), runAttempt: env('RELEASE_SET_RUBYGEMS_OBSERVER_ATTEMPT'), workflowPath: env('RELEASE_SET_RUBYGEMS_OBSERVER_WORKFLOW'), sourceCommit: observerSource }, workDir: env('RELEASE_SET_RUBYGEMS_WORK_DIR'), outputFile, toolPaths: { ruby31: env('RELEASE_SET_RUBYGEMS_RUBY31'), ruby34: env('RELEASE_SET_RUBYGEMS_RUBY34') } })
    console.log(`rubygems-public-observation=${sha256Hex(canonicalJson(receipt))}`)
    return
  }

  if (arguments_[0] === '--release-set-rust-observe') {
    const outputFile = await npmInvalidateOutput(process.env.RELEASE_SET_RUST_OUTPUT_FILE, process.env.RELEASE_SET_RUST_WORK_DIR, 'Rust observer output file', 'rust-artifact-observation')
    requireExactInternalMode(arguments_, '--release-set-rust-observe')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const planSha256 = env('RELEASE_SET_PLAN_SHA256')
    requireEqual(releaseSetPlanDigest(plan), planSha256, 'Rust observer plan digest mismatch')
    const context = { repository: env('REPOSITORY'), repositoryId: env('REPOSITORY_ID'), eventName: env('EVENT_NAME'), eventRef: env('EVENT_REF'), eventSha: env('EVENT_SHA'), expectedCommit: env('EXPECTED_COMMIT'), checkoutHead: env('CHECKOUT_HEAD'), checkoutStatus: env('CHECKOUT_STATUS'), workflowRef: env('WORKFLOW_REF'), workflowSha: env('WORKFLOW_SHA') }
    validateReleaseSetContext(context, plan)
    const preparedExpected = { runId: env('RELEASE_SET_PREPARED_RUN_ID'), runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'), artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'), bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'), sourceCommit: plan.sourceCommit, bundleName: `release-set-bundle-${plan.sourceCommit}`, bindingName: `release-set-binding-${env('RELEASE_SET_PREPARED_RUN_ID')}-${env('RELEASE_SET_PREPARED_RUN_ATTEMPT')}` }
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    const preparation = await verifyReleaseSetPreparation({ plan, context, run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')), artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')), bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')), binding, bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'), bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'), artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'), bindingDirectory: env('RELEASE_SET_BINDING_DIR'), expected: preparedExpected })
    const observerSource = env('RELEASE_SET_RUST_OBSERVER_SOURCE')
    requireEqual(observerSource, context.eventSha, 'Rust observer source must bind to execution context')
    const receipt = await observeRustArtifact({ descriptor: plan.rust, planSha256, preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 }, observer: { runId: env('RELEASE_SET_RUST_OBSERVER_RUN_ID'), runAttempt: env('RELEASE_SET_RUST_OBSERVER_ATTEMPT'), workflowPath: env('RELEASE_SET_RUST_OBSERVER_WORKFLOW'), sourceCommit: observerSource }, workDir: env('RELEASE_SET_RUST_WORK_DIR'), outputFile })
    if (receipt.state !== 'observed' || receipt.complete !== true) fail('rust-public-observation-incomplete')
    console.log(`rust-public-observation=${sha256Hex(canonicalJson(receipt))}`)
    return
  }

  if (arguments_[0] === '--release-set-go-observe') {
    const outputFile = await npmInvalidateOutput(process.env.RELEASE_SET_GO_OUTPUT_FILE, process.env.RELEASE_SET_GO_WORK_DIR, 'Go observer output file', 'go-public-observation')
    requireExactInternalMode(arguments_, '--release-set-go-observe')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const planSha256 = env('RELEASE_SET_PLAN_SHA256'); requireEqual(releaseSetPlanDigest(plan), planSha256, 'Go observer plan digest mismatch')
    const context = { repository: env('REPOSITORY'), repositoryId: env('REPOSITORY_ID'), eventName: env('EVENT_NAME'), eventRef: env('EVENT_REF'), eventSha: env('EVENT_SHA'), expectedCommit: env('EXPECTED_COMMIT'), checkoutHead: env('CHECKOUT_HEAD'), checkoutStatus: env('CHECKOUT_STATUS'), workflowRef: env('WORKFLOW_REF'), workflowSha: env('WORKFLOW_SHA') }
    validateReleaseSetContext(context, plan)
    const preparedExpected = { runId: env('RELEASE_SET_PREPARED_RUN_ID'), runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'), artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'), bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'), sourceCommit: plan.sourceCommit, bundleName: `release-set-bundle-${plan.sourceCommit}`, bindingName: `release-set-binding-${env('RELEASE_SET_PREPARED_RUN_ID')}-${env('RELEASE_SET_PREPARED_RUN_ATTEMPT')}` }
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    const preparation = await verifyReleaseSetPreparation({ plan, context, run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')), artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')), bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')), binding, bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'), bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'), artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'), bindingDirectory: env('RELEASE_SET_BINDING_DIR'), expected: preparedExpected })
    const observerSource = env('RELEASE_SET_GO_OBSERVER_SOURCE'); requireEqual(observerSource, context.eventSha, 'Go observer source must bind to execution context')
    const receipt = await observeGoModule({ descriptor: plan.go, planSha256, preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 }, observer: { runId: env('RELEASE_SET_GO_OBSERVER_RUN_ID'), runAttempt: env('RELEASE_SET_GO_OBSERVER_ATTEMPT'), workflowPath: env('RELEASE_SET_GO_OBSERVER_WORKFLOW'), sourceCommit: observerSource }, workDir: env('RELEASE_SET_GO_WORK_DIR'), outputFile, toolPaths: { go: env('RELEASE_SET_GO_GO'), git: env('RELEASE_SET_GO_GIT'), python3: env('RELEASE_SET_GO_PYTHON') } })
    if (receipt.state !== 'observed' || receipt.complete !== true) fail('go-public-observation-incomplete')
    console.log(`go-public-observation=${sha256Hex(canonicalJson(receipt))}`)
    return
  }

  if (arguments_[0] === '--release-set-receipts-observe') {
    requireExactInternalMode(arguments_, '--release-set-receipts-observe')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const planSha256 = env('RELEASE_SET_PLAN_SHA256'); requireEqual(releaseSetPlanDigest(plan), planSha256, 'Release-set receipt observer plan digest mismatch')
    const context = releaseSetExecutionContextFromEnv(); validateReleaseSetContext(context, plan)
    const preparedExpected = { runId: env('RELEASE_SET_PREPARED_RUN_ID'), runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'), artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'), bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'), sourceCommit: plan.sourceCommit, bundleName: 'release-set-bundle-' + plan.sourceCommit, bindingName: 'release-set-binding-' + env('RELEASE_SET_PREPARED_RUN_ID') + '-' + env('RELEASE_SET_PREPARED_RUN_ATTEMPT') }
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    const preparation = await verifyReleaseSetPreparation({ plan, context, run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')), artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')), bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')), binding, bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'), bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'), artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'), bindingDirectory: env('RELEASE_SET_BINDING_DIR'), expected: preparedExpected })
    const names = env('RELEASE_SET_RECEIPT_NAMES').split(',').map(value => value.trim()).filter(Boolean)
    const receiptArtifacts = JSON.parse(await readFile(env('RELEASE_SET_RECEIPT_ARTIFACTS_FILE'), 'utf8'))
    const token = await readReleaseSetGithubReadTokenFd(process.env.RELEASE_SET_RECEIPT_READ_TOKEN_FD)
    const result = await observeReleaseSetReceiptArtifacts({ plan, preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 }, receiptArtifacts, filenames: names, observer: { runId: env('RELEASE_SET_RECEIPT_OBSERVER_RUN_ID'), runAttempt: env('RELEASE_SET_RECEIPT_OBSERVER_ATTEMPT'), workflowPath: env('RELEASE_SET_RECEIPT_OBSERVER_WORKFLOW'), sourceCommit: env('RELEASE_SET_RECEIPT_OBSERVER_SOURCE') }, workDir: env('RELEASE_SET_RECEIPT_WORK_DIR'), request: githubCapabilityRequest(npmDefaultRequest, token) })
    await writeFile(env('RELEASE_SET_RECEIPTS_OBSERVATION_FILE'), canonicalJson({ schemaVersion: 1, kind: 'release-set-receipts-observation', state: 'observed', complete: true, receiptDigests: Object.fromEntries(Object.entries(result.receiptBytes).map(([name, bytes]) => [name, sha256Hex(bytes)])) }) + '\n')
    console.log('release-set-receipts-observation=' + sha256Hex(canonicalJson(result.receipts)))
    return
  }

  if (arguments_[0] === '--release-set-snapshot-observe') {
    requireExactInternalMode(arguments_, '--release-set-snapshot-observe')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const planSha256 = env('RELEASE_SET_PLAN_SHA256'); requireEqual(releaseSetPlanDigest(plan), planSha256, 'Release-set snapshot observer plan digest mismatch')
    const context = releaseSetExecutionContextFromEnv(); validateReleaseSetContext(context, plan)
    const preparedExpected = { runId: env('RELEASE_SET_PREPARED_RUN_ID'), runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'), artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'), bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'), sourceCommit: plan.sourceCommit, bundleName: 'release-set-bundle-' + plan.sourceCommit, bindingName: 'release-set-binding-' + env('RELEASE_SET_PREPARED_RUN_ID') + '-' + env('RELEASE_SET_PREPARED_RUN_ATTEMPT') }
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    const preparation = await verifyReleaseSetPreparation({ plan, context, run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')), artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')), bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')), binding, bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'), bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'), artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'), bindingDirectory: env('RELEASE_SET_BINDING_DIR'), expected: preparedExpected })
    const snapshot = JSON.parse(await readFile(env('RELEASE_SET_SNAPSHOT_BINDING_FILE'), 'utf8'))
    const receiptArtifacts = JSON.parse(await readFile(env('RELEASE_SET_RECEIPT_ARTIFACTS_FILE'), 'utf8'))
    const token = await readReleaseSetGithubReadTokenFd(process.env.RELEASE_SET_SNAPSHOT_READ_TOKEN_FD)
    const result = await observeReleaseSetProofSnapshot({ plan, preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 }, selector: { mode: 'current', snapshot, receiptArtifacts }, observer: { runId: env('RELEASE_SET_SNAPSHOT_OBSERVER_RUN_ID'), runAttempt: env('RELEASE_SET_SNAPSHOT_OBSERVER_ATTEMPT'), workflowPath: env('RELEASE_SET_SNAPSHOT_OBSERVER_WORKFLOW'), sourceCommit: env('RELEASE_SET_SNAPSHOT_OBSERVER_SOURCE') }, workDir: env('RELEASE_SET_SNAPSHOT_WORK_DIR'), request: githubCapabilityRequest(npmDefaultRequest, token), currentProducer: true })
    await writeFile(env('RELEASE_SET_SNAPSHOT_OBSERVATION_FILE'), canonicalJson(result.manifest) + '\n')
    console.log('release-set-snapshot-observation=' + sha256Hex(canonicalJson(result.manifest)))
    return
  }

  if (arguments_[0] === '--release-set-manifest-observe') {
    requireExactInternalMode(arguments_, '--release-set-manifest-observe')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const planSha256 = env('RELEASE_SET_PLAN_SHA256'); requireEqual(releaseSetPlanDigest(plan), planSha256, 'Release-set manifest observer plan digest mismatch')
    const context = releaseSetExecutionContextFromEnv(); validateReleaseSetContext(context, plan)
    const preparedExpected = { runId: env('RELEASE_SET_PREPARED_RUN_ID'), runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'), artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'), bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'), sourceCommit: plan.sourceCommit, bundleName: 'release-set-bundle-' + plan.sourceCommit, bindingName: 'release-set-binding-' + env('RELEASE_SET_PREPARED_RUN_ID') + '-' + env('RELEASE_SET_PREPARED_RUN_ATTEMPT') }
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    const preparation = await verifyReleaseSetPreparation({ plan, context, run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')), artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')), bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')), binding, bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'), bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'), artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'), bindingDirectory: env('RELEASE_SET_BINDING_DIR'), expected: preparedExpected })
    const manifestBytes = await readFile(env('RELEASE_SET_MANIFEST_FILE')); const manifest = (() => { try { return JSON.parse(manifestBytes.toString('utf8')) } catch { fail('Release-set supplied manifest JSON is invalid') } })(); const validated = validateReleaseSetProofManifest(manifest, { plan, preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 } })
    const token = await readReleaseSetGithubReadTokenFd(process.env.RELEASE_SET_MANIFEST_READ_TOKEN_FD)
    const result = await observeReleaseSetProofSnapshot({ plan, preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 }, selector: { mode: 'current', snapshot: validated.snapshot, receiptArtifacts: validated.receiptArtifacts }, observer: undefined, workDir: env('RELEASE_SET_MANIFEST_WORK_DIR'), request: githubCapabilityRequest(npmDefaultRequest, token), currentProducer: false })
    requireEqual(Buffer.compare(manifestBytes, Buffer.from(`${canonicalJson(result.manifest)}\n`)), 0, 'Release-set supplied manifest differs from authenticated source lineage')
    await writeFile(env('RELEASE_SET_MANIFEST_OBSERVATION_FILE'), canonicalJson(result.manifest) + '\n')
    console.log('release-set-manifest-observation=' + sha256Hex(canonicalJson(result.manifest)))
    return
  }

  if (arguments_[0] === '--release-set-checkpoint-observe') {
    requireExactInternalMode(arguments_, '--release-set-checkpoint-observe')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const planSha256 = env('RELEASE_SET_PLAN_SHA256'); requireEqual(releaseSetPlanDigest(plan), planSha256, 'Release-set checkpoint observer plan digest mismatch')
    const context = releaseSetExecutionContextFromEnv(); validateReleaseSetContext(context, plan)
    const preparedExpected = { runId: env('RELEASE_SET_PREPARED_RUN_ID'), runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'), artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'), bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'), sourceCommit: plan.sourceCommit, bundleName: 'release-set-bundle-' + plan.sourceCommit, bindingName: 'release-set-binding-' + env('RELEASE_SET_PREPARED_RUN_ID') + '-' + env('RELEASE_SET_PREPARED_RUN_ATTEMPT') }
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    const preparation = await verifyReleaseSetPreparation({ plan, context, run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')), artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')), bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')), binding, bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'), bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'), artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'), bindingDirectory: env('RELEASE_SET_BINDING_DIR'), expected: preparedExpected })
    const checkpoint = JSON.parse(await readFile(env('RELEASE_SET_CHECKPOINT_BINDING_FILE'), 'utf8')); const token = await readReleaseSetGithubReadTokenFd(process.env.RELEASE_SET_CHECKPOINT_READ_TOKEN_FD)
    const result = await observeReleaseSetProofSnapshot({ plan, preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 }, selector: { mode: 'preserved-checkpoint', checkpoint }, observer: undefined, workDir: env('RELEASE_SET_CHECKPOINT_WORK_DIR'), request: githubCapabilityRequest(npmDefaultRequest, token), currentProducer: false })
    if (!Buffer.isBuffer(result.checkpointManifestBytes)) fail('Release-set checkpoint observer did not return authenticated manifest bytes')
    await writeFile(env('RELEASE_SET_CHECKPOINT_MANIFEST_OUTPUT_FILE'), result.checkpointManifestBytes)
    const receiptOutputDir = npmSafePath(env('RELEASE_SET_CHECKPOINT_RECEIPT_OUTPUT_DIR'), 'Release-set checkpoint receipt output directory')
    if ((await readdir(receiptOutputDir, { withFileTypes: true })).length !== 0) fail('Release-set checkpoint receipt output directory is not fresh')
    for (const [filename, bytes] of Object.entries(result.receiptBytes ?? {})) {
      if (!RELEASE_SET_RECEIPT_FILENAMES.includes(filename) || !Buffer.isBuffer(bytes)) fail('Release-set checkpoint authenticated receipt bytes are invalid')
      await writeFile(join(receiptOutputDir, filename), bytes, { flag: 'wx' })
    }
    await writeFile(env('RELEASE_SET_CHECKPOINT_OBSERVATION_FILE'), canonicalJson(result.manifest) + '\n')
    console.log('release-set-checkpoint-observation=' + sha256Hex(canonicalJson(result.manifest)))
    return
  }

  if (arguments_[0] === '--release-set-github-observe') {
    const outputFile = await npmInvalidateOutput(process.env.RELEASE_SET_GITHUB_OUTPUT_FILE, process.env.RELEASE_SET_GITHUB_WORK_DIR, 'GitHub observer output file', 'github-public-observation')
    requireExactInternalMode(arguments_, '--release-set-github-observe')
    const plan = validateReleaseSetPlan(JSON.parse(await readFile(env('RELEASE_SET_PLAN_FILE'), 'utf8')))
    const planSha256 = env('RELEASE_SET_PLAN_SHA256'); requireEqual(releaseSetPlanDigest(plan), planSha256, 'GitHub observer plan digest mismatch')
    const context = { repository: env('REPOSITORY'), repositoryId: env('REPOSITORY_ID'), eventName: env('EVENT_NAME'), eventRef: env('EVENT_REF'), eventSha: env('EVENT_SHA'), expectedCommit: env('EXPECTED_COMMIT'), checkoutHead: env('CHECKOUT_HEAD'), checkoutStatus: env('CHECKOUT_STATUS'), workflowRef: env('WORKFLOW_REF'), workflowSha: env('WORKFLOW_SHA') }
    validateReleaseSetContext(context, plan)
    const preparedExpected = { runId: env('RELEASE_SET_PREPARED_RUN_ID'), runAttempt: env('RELEASE_SET_PREPARED_RUN_ATTEMPT'), artifactId: env('RELEASE_SET_PREPARED_ARTIFACT_ID'), bindingArtifactId: env('RELEASE_SET_PREPARED_BINDING_ARTIFACT_ID'), sourceCommit: plan.sourceCommit, bundleName: `release-set-bundle-${plan.sourceCommit}`, bindingName: `release-set-binding-${env('RELEASE_SET_PREPARED_RUN_ID')}-${env('RELEASE_SET_PREPARED_RUN_ATTEMPT')}` }
    const binding = JSON.parse(await readFile(env('RELEASE_SET_BINDING_FILE'), 'utf8'))
    const preparation = await verifyReleaseSetPreparation({ plan, context, run: JSON.parse(await readFile(env('RELEASE_SET_RUN_FILE'), 'utf8')), artifact: JSON.parse(await readFile(env('RELEASE_SET_ARTIFACT_METADATA_FILE'), 'utf8')), bindingArtifact: JSON.parse(await readFile(env('RELEASE_SET_BINDING_METADATA_FILE'), 'utf8')), binding, bundleZip: env('RELEASE_SET_BUNDLE_ZIP_FILE'), bindingZip: env('RELEASE_SET_BINDING_ZIP_FILE'), artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR'), bindingDirectory: env('RELEASE_SET_BINDING_DIR'), expected: preparedExpected })
    const descriptorFile = JSON.parse(await readFile(env('RELEASE_SET_GITHUB_DESCRIPTOR_FILE'), 'utf8')); const snapshot = descriptorFile.snapshot ?? (process.env.RELEASE_SET_GITHUB_SNAPSHOT_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.RELEASE_SET_GITHUB_SNAPSHOT_FILE, 'utf8'))); const { snapshot: _snapshot, ...descriptor } = descriptorFile
    const boundDescriptor = await validateGitHubReleaseDescriptor({ plan, descriptor, artifactDirectory: env('RELEASE_SET_ARTIFACT_DIR') })
    const observerSource = env('RELEASE_SET_GITHUB_OBSERVER_SOURCE'); requireEqual(observerSource, context.eventSha, 'GitHub observer source must bind to execution context')
    if (process.env.GITHUB_RUN_ID !== undefined) requireEqual(String(process.env.GITHUB_RUN_ID), String(process.env.RELEASE_SET_GITHUB_OBSERVER_RUN_ID), 'GitHub observer run ID is not the current execution')
    if (process.env.GITHUB_RUN_ATTEMPT !== undefined) requireEqual(String(process.env.GITHUB_RUN_ATTEMPT), String(process.env.RELEASE_SET_GITHUB_OBSERVER_ATTEMPT), 'GitHub observer attempt is not the current execution')
    const token = await readReleaseSetGithubReadTokenFd()
    const publicRead = process.env.RELEASE_SET_GITHUB_PUBLIC_READ_FILE === undefined ? undefined : JSON.parse(await readFile(process.env.RELEASE_SET_GITHUB_PUBLIC_READ_FILE, 'utf8'))
    const receipt = await observeGitHubRelease({ plan, descriptor: boundDescriptor.descriptor, planSha256, preparation: { sourceCommit: preparation.context.sourceCommit, runId: binding.runId, runAttempt: binding.runAttempt, artifactId: binding.artifactId, bindingArtifactId: preparation.metadata.bindingArtifactId, planSha256: binding.planSha256 }, observer: { runId: env('RELEASE_SET_GITHUB_OBSERVER_RUN_ID'), runAttempt: env('RELEASE_SET_GITHUB_OBSERVER_ATTEMPT'), workflowPath: env('RELEASE_SET_GITHUB_OBSERVER_WORKFLOW'), sourceCommit: observerSource }, workDir: env('RELEASE_SET_GITHUB_WORK_DIR'), outputFile, snapshot, publicRead }, { githubReadToken: token, anonymousRequest: githubAnonymousDefaultRequest })
    if (receipt.state !== 'matching-public' || receipt.complete !== true || receipt.publicRead?.anonymous !== true || receipt.publicRead?.complete !== true) fail('github-public-observation-incomplete')
    console.log(`github-public-observation=${sha256Hex(canonicalJson(receipt))}`)
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
    const expectedVersion = env('EXPECTED_VERSION')
    if (expectedVersion === CURRENT_RUST_VERSION) {
      const archive = await inspectRust011Archive({
        filePath: env('ARCHIVE_FILE'),
        packageList: process.env.PACKAGE_LIST_FILE === undefined ? undefined : await readFile(env('PACKAGE_LIST_FILE'), 'utf8'),
        archiveList: process.env.ARCHIVE_LIST_FILE === undefined ? undefined : await readFile(env('ARCHIVE_LIST_FILE'), 'utf8'),
        suppliedManifest: process.env.MANIFEST_FILE === undefined ? undefined : await readFile(env('MANIFEST_FILE'), 'utf8'),
        suppliedVcsInfo: process.env.VCS_INFO_FILE === undefined ? undefined : await readFile(env('VCS_INFO_FILE'), 'utf8'),
        expectedVersion,
        expectedCommit: env('EXPECTED_COMMIT'),
        expectedArchiveSha256: process.env.APPROVED_SHA256 || undefined,
      })
      if (process.env.ARCHIVE_RESULT_FILE !== undefined) await writeFile(env('ARCHIVE_RESULT_FILE'), `${canonicalJson(archive)}\n`)
      console.log(`archive_sha256=${archive.sha256}`)
      console.log(`Rust 0.11 archive provenance and distribution contents passed (${archive.members.length} members).`)
    } else {
      verifyArchiveContents({
        fileList: await readFile(env('ARCHIVE_LIST_FILE'), 'utf8'),
        manifest: await readFile(env('MANIFEST_FILE'), 'utf8'),
        vcsInfo: await readFile(env('VCS_INFO_FILE'), 'utf8'),
        expectedVersion,
        expectedCommit: env('EXPECTED_COMMIT'),
      })
      console.log('Published crate archive provenance and required files passed.')
    }
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
