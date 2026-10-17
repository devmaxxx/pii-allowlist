import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The examples import the built package by name, so these run only after `pnpm build`.
// Each example lists its own secrets: one that never reaches the "before" output would pass the "after" check for nothing.
const SECRETS: Record<string, string[]> = {
  pino: ['jane@example.com', 'DE123456789', 'Jane Roe', '4111 1111 1111 1111'],
  otel: ['jane@example.com', 's3cr3t', '+14155550123', '203.0.113.7'],
  sentry: ['jane@example.com', '+14155550123', 's3cr3t', '203.0.113.7', 'hunter2', 'session=abc', 'eyJhbGciOiJIUzI1NiJ9'],
}

// Each example starts a fresh Node process, which outlasts the default 5s on a cold Windows runner.
const TIMEOUT = 30_000

function run(name: string): string {
  const file = fileURLToPath(new URL(`../examples/${name}.ts`, import.meta.url))
  return execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', file], { encoding: 'utf8' })
}

describe('examples', () => {
  it.each(Object.entries(SECRETS))('%s leaks nothing after the allowlist', (name, secrets) => {
    const output = run(name)
    const after = output.split(/^--- .*after.*$/m).slice(1).map(part => part.split(/^--- /m)[0]).join('')

    expect(after.trim()).not.toBe('')
    for (const secret of secrets) {
      expect(output).toContain(secret)
      expect(after).not.toContain(secret)
    }
  }, TIMEOUT)
})
