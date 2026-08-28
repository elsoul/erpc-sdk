import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)

for (const relativePath of [
  packageJson.main,
  packageJson.module,
  packageJson.types,
]) {
  await access(new URL(`../${relativePath}`, import.meta.url))
}

const esm = await import('../dist/index.js')
const require = createRequire(import.meta.url)
const cjs = require('../dist/index.cjs')

if (packageJson.name !== '@elsoul/erpc-sdk' || packageJson.private === true) {
  throw new Error('Publishable package identity check failed')
}
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  if (Object.keys(packageJson[field] ?? {}).length > 0) {
    throw new Error(`Unexpected runtime dependency field: ${field}`)
  }
}

if (
  typeof esm.createErpcClient !== 'function' ||
  typeof esm.createErpcCloudClient !== 'function' ||
  typeof esm.CloudCatalogClient !== 'function' ||
  typeof esm.CloudCreditClient !== 'function' ||
  typeof esm.CloudResourcesClient !== 'function' ||
  typeof esm.UsageClient !== 'function'
) {
  throw new Error('ESM export check failed')
}
if (
  typeof cjs.createErpcClient !== 'function' ||
  typeof cjs.createErpcCloudClient !== 'function' ||
  typeof cjs.CloudCatalogClient !== 'function' ||
  typeof cjs.CloudCreditClient !== 'function' ||
  typeof cjs.CloudResourcesClient !== 'function' ||
  typeof cjs.UsageClient !== 'function'
) {
  throw new Error('CommonJS export check failed')
}
if (esm.ETHEREUM_RPC_METHODS.length !== 53) {
  throw new Error('Ethereum method catalog check failed')
}
if (esm.SOLANA_RPC_METHODS.length !== 55) {
  throw new Error('Solana method catalog check failed')
}

const additionalCatalogs = [
  [esm.ETHEREUM_SUBSCRIPTION_METHODS, 2, 'Ethereum subscription'],
  [esm.SOLANA_ANALYTICS_METHODS, 5, 'Solana analytics'],
  [esm.SOLANA_DAS_METHODS, 14, 'Solana indexed asset'],
  [esm.SOLANA_ENHANCED_SUBSCRIPTION_METHODS, 4, 'Solana subscription'],
  [esm.SOLANA_HISTORY_METHODS, 2, 'Solana history'],
  [esm.SOLANA_LEADER_METHODS, 2, 'Solana leader'],
]
for (const [catalog, expectedLength, label] of additionalCatalogs) {
  if (!Array.isArray(catalog) || catalog.length !== expectedLength) {
    throw new Error(`${label} method catalog check failed`)
  }
}

console.log('Package entry points verified.')
