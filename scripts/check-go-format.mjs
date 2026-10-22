import { spawnSync } from 'node:child_process'

const result = spawnSync('gofmt', ['-l', 'packages/go'], {
  cwd: new URL('../', import.meta.url),
  encoding: 'utf8',
})
if (result.error) throw result.error
if (result.status !== 0) throw new Error('gofmt failed')

const unformatted = result.stdout.trim()
if (unformatted) {
  throw new Error(`Go files require formatting:\n${unformatted}`)
}

console.log('Go formatting verified.')
