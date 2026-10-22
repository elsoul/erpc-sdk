import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const typescriptSolana = await readFile(
  new URL('packages/typescript/src/rpc/solana.ts', root),
  'utf8',
)
const typescriptEthereum = await readFile(
  new URL('packages/typescript/src/rpc/ethereum.ts', root),
  'utf8',
)
const typescriptAvalanche = await readFile(
  new URL('packages/typescript/src/rpc/avalanche.ts', root),
  'utf8',
)
const typescriptSubscriptions = await readFile(
  new URL('packages/typescript/src/subscriptions.ts', root),
  'utf8',
)
const rustSolana = await readFile(
  new URL('packages/rust/src/solana.rs', root),
  'utf8',
)
const rustEthereum = await readFile(
  new URL('packages/rust/src/ethereum.rs', root),
  'utf8',
)
const rustAvalanche = await readFile(
  new URL('packages/rust/src/avalanche.rs', root),
  'utf8',
)
const pythonRPC = await readFile(
  new URL('packages/python/src/erpc_sdk/rpc.py', root),
  'utf8',
)
const goMethods = await readFile(
  new URL('packages/go/methods.go', root),
  'utf8',
)
const rubyRPC = await readFile(
  new URL('packages/ruby/lib/erpc_sdk/rpc.rb', root),
  'utf8',
)

const quotedValues = (body) =>
  [...body.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1])

const typescriptCatalog = (source, name) => {
  const body = source.match(
    new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`),
  )?.[1]
  if (!body) throw new Error(`Unable to read TypeScript catalog ${name}`)
  return quotedValues(body)
}

const rustCatalog = (source, name) => {
  const body = source.match(
    new RegExp(`pub const ${name}:[^=]+=\\s*&\\[([\\s\\S]*?)\\];`),
  )?.[1]
  if (!body) throw new Error(`Unable to read Rust catalog ${name}`)
  return quotedValues(body)
}

const pythonCatalog = (source, name) => {
  const body = source.match(
    new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)\\)`, 'm'),
  )?.[1]
  if (body === undefined) {
    throw new Error(`Unable to read Python catalog ${name}`)
  }
  return quotedValues(body)
}

const goCatalog = (source, name) => {
  const body = source.match(
    new RegExp(`var ${name} = \\[\\]string\\{([\\s\\S]*?)\\}`),
  )?.[1]
  if (body === undefined) throw new Error(`Unable to read Go catalog ${name}`)
  return quotedValues(body)
}

const rubyCatalog = (source, name) => {
  const body = source.match(
    new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\.freeze`),
  )?.[1]
  if (body === undefined) throw new Error(`Unable to read Ruby catalog ${name}`)
  return quotedValues(body)
}

const catalogs = [
  ['ETHEREUM_RPC_METHODS', 'EthereumRPCMethods', typescriptEthereum, rustEthereum],
  [
    'ETHEREUM_SUBSCRIPTION_METHODS',
    'EthereumSubscriptionMethods',
    typescriptEthereum,
    rustEthereum,
  ],
  ['SOLANA_RPC_METHODS', 'SolanaRPCMethods', typescriptSolana, rustSolana],
  ['SOLANA_DAS_METHODS', 'SolanaDASMethods', typescriptSolana, rustSolana],
  [
    'SOLANA_HISTORY_METHODS',
    'SolanaHistoryMethods',
    typescriptSolana,
    rustSolana,
  ],
  ['SOLANA_LEADER_METHODS', 'SolanaLeaderMethods', typescriptSolana, rustSolana],
  [
    'SOLANA_ANALYTICS_METHODS',
    'SolanaAnalyticsMethods',
    typescriptSolana,
    rustSolana,
  ],
  [
    'SOLANA_ENHANCED_SUBSCRIPTION_METHODS',
    'SolanaEnhancedSubscriptionMethods',
    typescriptSubscriptions,
    rustSolana,
  ],
  [
    'AVALANCHE_AVAX_METHODS',
    'AvalancheAVAXMethods',
    typescriptAvalanche,
    rustAvalanche,
  ],
  [
    'AVALANCHE_X_CHAIN_METHODS',
    'AvalancheXChainMethods',
    typescriptAvalanche,
    rustAvalanche,
  ],
  [
    'AVALANCHE_P_CHAIN_METHODS',
    'AvalanchePChainMethods',
    typescriptAvalanche,
    rustAvalanche,
  ],
  [
    'AVALANCHE_PROPOSER_VM_METHODS',
    'AvalancheProposerVMMethods',
    typescriptAvalanche,
    rustAvalanche,
  ],
  [
    'AVALANCHE_INFO_METHODS',
    'AvalancheInfoMethods',
    typescriptAvalanche,
    rustAvalanche,
  ],
  [
    'AVALANCHE_INDEX_METHODS',
    'AvalancheIndexMethods',
    typescriptAvalanche,
    rustAvalanche,
  ],
]

for (const [name, goName, typescript, rust] of catalogs) {
  const expected = typescriptCatalog(typescript, name)
  const implementations = [
    ['Rust', rustCatalog(rust, name)],
    ['Python', pythonCatalog(pythonRPC, name)],
    ['Go', goCatalog(goMethods, goName)],
    ['Ruby', rubyCatalog(rubyRPC, name)],
  ]
  for (const [language, actual] of implementations) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `${name} differs between TypeScript and ${language}:\n` +
          `TypeScript: ${expected.join(', ')}\n${language}: ${actual.join(', ')}`,
      )
    }
  }
}

console.log(
  `Verified ${catalogs.length} method catalogs across TypeScript, Rust, Python, Go, and Ruby.`,
)
