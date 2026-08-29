import { readFile } from 'node:fs/promises'

const tag = process.argv[2]
const root = new URL('../', import.meta.url)
const packageJson = JSON.parse(
  await readFile(new URL('packages/typescript/package.json', root), 'utf8'),
)
const cargoManifest = await readFile(
  new URL('packages/rust/Cargo.toml', root),
  'utf8',
)
const pythonManifest = await readFile(
  new URL('packages/python/pyproject.toml', root),
  'utf8',
)
const goManifest = await readFile(
  new URL('packages/go/go.mod', root),
  'utf8',
)
const rubyManifest = await readFile(
  new URL('packages/ruby/erpc-sdk.gemspec', root),
  'utf8',
)
const rubyVersionSource = await readFile(
  new URL('packages/ruby/lib/erpc_sdk/version.rb', root),
  'utf8',
)
const cargoName = cargoManifest.match(/^name = "([^"]+)"$/m)?.[1]
const cargoVersion = cargoManifest.match(/^version = "([^"]+)"$/m)?.[1]
const pythonName = pythonManifest.match(/^name = "([^"]+)"$/m)?.[1]
const pythonVersion = pythonManifest.match(/^version = "([^"]+)"$/m)?.[1]
const goModule = goManifest.match(/^module (\S+)$/m)?.[1]
const rubyName = rubyManifest.match(/^\s*spec\.name = "([^"]+)"$/m)?.[1]
const rubyVersion = rubyVersionSource.match(/^\s*VERSION = "([^"]+)"$/m)?.[1]
const expectedTag = `v${packageJson.version}`

if (tag && tag !== expectedTag) {
  throw new Error(`Release tag ${tag} must match package version ${expectedTag}`)
}
if (packageJson.name !== '@elsoul/erpc-sdk') {
  throw new Error('Unexpected npm package name')
}
if (cargoName !== 'erpc-sdk') {
  throw new Error('Unexpected crates.io package name')
}
if (pythonName !== 'erpc-sdk') {
  throw new Error('Unexpected PyPI package name')
}
if (goModule !== 'github.com/elsoul/erpc-sdk/packages/go') {
  throw new Error('Unexpected Go module path')
}
if (rubyName !== 'erpc-sdk') {
  throw new Error('Unexpected RubyGems package name')
}
if (
  cargoVersion !== packageJson.version ||
  pythonVersion !== packageJson.version ||
  rubyVersion !== packageJson.version
) {
  throw new Error(
    `Package versions differ: npm=${packageJson.version}, crates.io=${cargoVersion}, ` +
      `PyPI=${pythonVersion}, RubyGems=${rubyVersion}`,
  )
}
if (packageJson.publishConfig?.access !== 'public') {
  throw new Error('The npm package must publish with public access')
}
if (packageJson.publishConfig?.registry !== 'https://registry.npmjs.org/') {
  throw new Error('Unexpected npm registry')
}
if (
  packageJson.repository?.url !==
  'git+https://github.com/elsoul/erpc-sdk.git'
) {
  throw new Error('The repository URL must match the public GitHub repository')
}
if (packageJson.repository?.directory !== 'packages/typescript') {
  throw new Error('Unexpected npm package repository directory')
}
if (!/^publish = \["crates-io"\]$/m.test(cargoManifest)) {
  throw new Error('The Rust crate must be restricted to crates.io')
}
if (!/^license = "MIT"$/m.test(cargoManifest)) {
  throw new Error('Unexpected Rust crate license')
}
if (
  !/^repository = "https:\/\/github\.com\/elsoul\/erpc-sdk"$/m.test(
    cargoManifest,
  )
) {
  throw new Error('Unexpected Rust crate repository')
}
if (!/^requires-python = ">=3\.11"$/m.test(pythonManifest)) {
  throw new Error('Unexpected minimum Python version')
}
if (!/^license = \{ file = "LICENSE" \}$/m.test(pythonManifest)) {
  throw new Error('Unexpected Python package license')
}
if (
  !/^Repository = "https:\/\/github\.com\/elsoul\/erpc-sdk"$/m.test(
    pythonManifest,
  )
) {
  throw new Error('Unexpected Python package repository')
}
if (!/^go 1\.22$/m.test(goManifest)) {
  throw new Error('Unexpected minimum Go version')
}
if (!/^\s*spec\.required_ruby_version = ">= 3\.1"$/m.test(rubyManifest)) {
  throw new Error('Unexpected minimum Ruby version')
}
if (!/^\s*spec\.license = "MIT"$/m.test(rubyManifest)) {
  throw new Error('Unexpected Ruby gem license')
}
if (
  !/^\s*"source_code_uri" => "https:\/\/github\.com\/elsoul\/erpc-sdk",$/m.test(
    rubyManifest,
  )
) {
  throw new Error('Unexpected Ruby gem repository')
}
if (!/^\s*"rubygems_mfa_required" => "true"$/m.test(rubyManifest)) {
  throw new Error('The Ruby gem must require MFA')
}

console.log(
  `${packageJson.name}, ${cargoName}, ${pythonName}, ${goModule}, and ${rubyName}` +
    ` share version ${packageJson.version}` +
    (tag ? ` and match ${tag}.` : '.'),
)
