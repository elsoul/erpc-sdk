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
  typeof esm.UsageClient !== 'function' ||
  esm.DEFAULT_AVALANCHE_ENDPOINT !== 'https://ava-rpc.erpc.global'
) {
  throw new Error('ESM export check failed')
}
if (
  typeof esm.getTokenAsset !== 'function' ||
  typeof esm.getTokenDeployment !== 'function' ||
  typeof esm.listTokenDeployments !== 'function' ||
  typeof esm.findTokenDeploymentsBySymbol !== 'function' ||
  typeof esm.findTokenDeploymentByAddress !== 'function' ||
  typeof esm.getNativeTokenDeployment !== 'function' ||
  !Array.isArray(esm.TOKEN_ASSETS) ||
  !Array.isArray(esm.TOKEN_DEPLOYMENTS) ||
  !Array.isArray(esm.TOKEN_ALIASES) ||
  !esm.TOKEN_CHAIN_IDS ||
  !esm.tokens ||
  typeof esm.TOKEN_CATALOG_VERSION !== 'string' ||
  typeof esm.TOKEN_CATALOG_AS_OF_DATE !== 'string' ||
  typeof esm.TOKEN_CATALOG_CONTENT_DIGEST !== 'string' ||
  typeof esm.listTokenRankings !== 'function' ||
  !Array.isArray(esm.TOKEN_RANKINGS) ||
  !esm.TOKEN_RANKINGS_METADATA ||
  typeof esm.TOKEN_RANKINGS_CONTENT_DIGEST !== 'string'
) {
  throw new Error('ESM token catalog or ranking export check failed')
}
if (
  typeof cjs.createErpcClient !== 'function' ||
  typeof cjs.createErpcCloudClient !== 'function' ||
  typeof cjs.CloudCatalogClient !== 'function' ||
  typeof cjs.CloudCreditClient !== 'function' ||
  typeof cjs.CloudResourcesClient !== 'function' ||
  typeof cjs.UsageClient !== 'function' ||
  cjs.DEFAULT_AVALANCHE_ENDPOINT !== 'https://ava-rpc.erpc.global'
) {
  throw new Error('CommonJS export check failed')
}
if (
  typeof cjs.getTokenAsset !== 'function' ||
  typeof cjs.getTokenDeployment !== 'function' ||
  typeof cjs.listTokenDeployments !== 'function' ||
  typeof cjs.findTokenDeploymentsBySymbol !== 'function' ||
  typeof cjs.findTokenDeploymentByAddress !== 'function' ||
  typeof cjs.getNativeTokenDeployment !== 'function' ||
  !Array.isArray(cjs.TOKEN_ASSETS) ||
  !Array.isArray(cjs.TOKEN_DEPLOYMENTS) ||
  !Array.isArray(cjs.TOKEN_ALIASES) ||
  !cjs.TOKEN_CHAIN_IDS ||
  !cjs.tokens ||
  typeof cjs.TOKEN_CATALOG_VERSION !== 'string' ||
  typeof cjs.TOKEN_CATALOG_AS_OF_DATE !== 'string' ||
  typeof cjs.TOKEN_CATALOG_CONTENT_DIGEST !== 'string' ||
  typeof cjs.listTokenRankings !== 'function' ||
  !Array.isArray(cjs.TOKEN_RANKINGS) ||
  !cjs.TOKEN_RANKINGS_METADATA ||
  typeof cjs.TOKEN_RANKINGS_CONTENT_DIGEST !== 'string'
) {
  throw new Error('CommonJS token catalog or ranking export check failed')
}

const firstDeployment = esm.getTokenDeployment(esm.tokens.ethereum.ETH)
if (!firstDeployment || typeof firstDeployment.deploymentId !== 'string') {
  throw new Error('Token catalog data check failed')
}
if (esm.getTokenDeployment(firstDeployment.deploymentId) !== firstDeployment) {
  throw new Error('Token catalog lookup check failed')
}
if (cjs.getTokenDeployment(firstDeployment.deploymentId)?.deploymentId !== firstDeployment.deploymentId) {
  throw new Error('CommonJS token catalog lookup check failed')
}
if (esm.findTokenDeploymentsBySymbol(firstDeployment.chainId, firstDeployment.symbol).length === 0) {
  throw new Error('Token catalog symbol lookup check failed')
}
if (esm.listTokenDeployments().length !== esm.TOKEN_DEPLOYMENTS.length) {
  throw new Error('Token catalog list check failed')
}
if (esm.getTokenAsset('__missing__') !== undefined) {
  throw new Error('Token catalog unknown lookup check failed')
}
const emptyRankings = esm.listTokenRankings('')
const unknownRankings = esm.listTokenRankings('unknown:chain')
if (emptyRankings.length !== 0 || unknownRankings.length !== 0) {
  throw new Error('Token ranking unknown lookup check failed')
}
if (!Object.isFrozen(emptyRankings) || !Object.isFrozen(unknownRankings) || !Object.isFrozen(esm.TOKEN_RANKINGS_METADATA)) {
  throw new Error('Token ranking immutability check failed')
}
if (cjs.listTokenRankings('')?.length !== 0) {
  throw new Error('CommonJS token ranking lookup check failed')
}

const client = esm.createErpcClient({
  apiKey: 'package-check',
  fetch: async () => new Response('{}'),
})
if (client.avalanche?.rpc?.endpoint !== 'https://ava-rpc.erpc.global/ava') {
  throw new Error('Avalanche client export check failed')
}
client.close()
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
