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
const cargoName = cargoManifest.match(/^name = "([^"]+)"$/m)?.[1]
const cargoVersion = cargoManifest.match(/^version = "([^"]+)"$/m)?.[1]
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
if (cargoVersion !== packageJson.version) {
  throw new Error(
    `Package versions differ: npm=${packageJson.version}, crates.io=${cargoVersion}`,
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

console.log(
  `${packageJson.name}@${packageJson.version} and ${cargoName}@${cargoVersion}` +
    (tag ? ` match ${tag}.` : ' have matching release identities.'),
)
