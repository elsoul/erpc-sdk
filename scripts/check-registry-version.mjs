import { appendFile, readFile } from 'node:fs/promises'

const registry = process.argv[2]
if (
  registry !== 'npm' &&
  registry !== 'crates' &&
  registry !== 'pypi' &&
  registry !== 'rubygems'
) {
  throw new Error('Registry must be npm, crates, pypi, or rubygems')
}

const packageJson = JSON.parse(
  await readFile(
    new URL('../packages/typescript/package.json', import.meta.url),
    'utf8',
  ),
)
const version = packageJson.version
let published

if (registry === 'npm') {
  const url =
    'https://registry.npmjs.org/' + encodeURIComponent(packageJson.name)
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404) published = false
  else if (!response.ok) {
    throw new Error(`Unable to inspect npm: HTTP ${response.status}`)
  } else {
    const metadata = await response.json()
    published = Object.hasOwn(metadata.versions ?? {}, version)
  }
} else if (registry === 'crates') {
  const response = await fetch(
    'https://crates.io/api/v1/crates/erpc-sdk/versions',
    {
      headers: { accept: 'application/json', 'user-agent': 'erpc-sdk-release' },
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (response.status === 404) published = false
  else if (!response.ok) {
    throw new Error(`Unable to inspect crates.io: HTTP ${response.status}`)
  } else {
    const metadata = await response.json()
    published = (metadata.versions ?? []).some(
      (candidate) => candidate.num === version,
    )
  }
} else if (registry === 'pypi') {
  const response = await fetch('https://pypi.org/pypi/erpc-sdk/json', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404) published = false
  else if (!response.ok) {
    throw new Error(`Unable to inspect PyPI: HTTP ${response.status}`)
  } else {
    const metadata = await response.json()
    published = Object.hasOwn(metadata.releases ?? {}, version)
  }
} else {
  const response = await fetch(
    `https://rubygems.org/api/v1/versions/erpc-sdk.json`,
    {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (response.status === 404) published = false
  else if (!response.ok) {
    throw new Error(`Unable to inspect RubyGems: HTTP ${response.status}`)
  } else {
    const metadata = await response.json()
    published = metadata.some((candidate) => candidate.number === version)
  }
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `published=${String(published)}\nversion=${version}\n`,
  )
}
console.log(
  `${registry} version ${version} is ${published ? 'already published' : 'available'}.`,
)
