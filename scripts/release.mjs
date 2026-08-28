import { spawnSync } from 'node:child_process'
import { parseReleaseArgument } from './release-version.mjs'

const { goTag, tag, version } = parseReleaseArgument(process.argv.slice(2))

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed`)
  }
  return result
}

run(process.execPath, ['scripts/verify-release.mjs', tag])

const status = run('git', ['status', '--porcelain'], { capture: true })
if (status.stdout.trim()) {
  throw new Error('Release requires a clean working tree')
}
const branch = run('git', ['branch', '--show-current'], { capture: true })
  .stdout.trim()
if (branch !== 'main') throw new Error('Release tags must be created from main')

run('git', ['fetch', '--prune', 'origin', 'main'])
const head = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim()
const remoteHead = run('git', ['rev-parse', 'origin/main'], {
  capture: true,
}).stdout.trim()
if (head !== remoteHead) {
  throw new Error('Local main must exactly match origin/main')
}

for (const releaseTag of [tag, goTag]) {
  const localTag = run(
    'git',
    ['rev-parse', '--verify', `refs/tags/${releaseTag}`],
    { allowFailure: true, capture: true },
  )
  if (localTag.status === 0) {
    throw new Error(`Local tag ${releaseTag} already exists`)
  }
  const remoteTag = run(
    'git',
    ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${releaseTag}`],
    { allowFailure: true, capture: true },
  )
  if (remoteTag.status === 0) {
    throw new Error(`Remote tag ${releaseTag} already exists`)
  }
  if (remoteTag.status !== 2) throw new Error('Unable to inspect remote tags')
}

run('corepack', ['pnpm', 'release:check'])
run('git', ['tag', '-a', tag, '-m', `ERPC SDK ${version}`])
run('git', ['tag', '-a', goTag, '-m', `ERPC Go SDK ${version}`])
run('git', [
  'push',
  '--atomic',
  'origin',
  `refs/tags/${tag}`,
  `refs/tags/${goTag}`,
])

console.log(
  `${tag} and ${goTag} were pushed. The protected release workflow will publish the registry packages.`,
)
