import type { LoggerOptions } from 'pino'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { createAllowlist, createPathRedactor, REDACTED } from '../src'
import {
  allowlistChildBindings,
  createLogFormatter,
  createMessageSerializer,
  createRequestSerializer,
  DEFAULT_LOG_KEYS,
  responseSerializer,
} from '../src/adapters/pino'

const USER = {
  userId: 'u_01JD2Q0H0C7Q8N4M3K2J1H0G9F',
  firstName: 'Jane',
  lastName: 'Roe',
  name: 'Jane Roe',
  phone: '+15550100200',
  email: 'jane.roe@example.com',
  note: 'call +15550100200 before 9',
}

const PII = [/\+\d{9,15}/, /[\w.]+@[\w.]+\.\w{2,}/]

/** One log line, written by a real pino through the options under test. */
function lineFor(
  options: LoggerOptions,
  log: (logger: pino.Logger) => void,
): Record<string, unknown> {
  const written: string[] = []
  const logger = pino(options, { write: (chunk: string) => written.push(chunk) })
  log(logger)

  expect(written).toHaveLength(1)
  return JSON.parse(written[0] ?? '{}') as Record<string, unknown>
}

const shipped: LoggerOptions = {
  base: undefined,
  formatters: { log: createLogFormatter({ allowlist: createAllowlist({ keys: [...DEFAULT_LOG_KEYS, 'moved'], patterns: [/Id$/] }) }) },
  serializers: { msg: createMessageSerializer() },
}

describe('createLogFormatter', () => {
  it('logs zero personal data from a user payload, and still logs the line', () => {
    const line = lineFor(shipped, logger => logger.info({ ...USER, moved: 3 }, `user ${USER.phone} updated`))
    const text = JSON.stringify(line)

    for (const pattern of PII)
      expect(text).not.toMatch(pattern)
    expect(text).not.toContain('Roe')
    expect(text).not.toContain('Jane')

    expect(line).toMatchObject({
      firstName: REDACTED,
      lastName: REDACTED,
      name: REDACTED,
      phone: REDACTED,
      email: REDACTED,
      note: REDACTED,
      userId: USER.userId,
      moved: 3,
      msg: `user ${REDACTED} updated`,
    })
  })

  it('redacts a key that is not on the default list', () => {
    const line = lineFor({ formatters: { log: createLogFormatter() } }, logger => logger.info({ email: USER.email }))

    expect(line.email).toBe(REDACTED)
  })

  it('redacts a whole subtree whose key nobody allowlisted', () => {
    const line = lineFor(shipped, logger => logger.info({ user: USER }))

    expect(line.user).toBe(REDACTED)
  })

  it('logs an error by its type, scrubbed message and code, and not the properties hung on it', () => {
    const error = Object.assign(new Error(`no user for ${USER.email}`), { code: 'E_NOUSER', phone: USER.phone })
    const line = lineFor(shipped, logger => logger.error(error))

    expect(line.err).toMatchObject({
      type: 'Error',
      message: `no user for ${REDACTED}`,
      code: 'E_NOUSER',
      phone: REDACTED,
    })
    expect(String((line.err as { stack: string }).stack)).toContain('at ')
    expect(JSON.stringify(line.err)).not.toMatch(/example\.com/)
  })

  it('hands pass-through keys to their serializers instead of redacting them', () => {
    const options: LoggerOptions = {
      formatters: { log: createLogFormatter({ passThrough: ['req', 'res'] }) },
      serializers: { req: createRequestSerializer(), res: responseSerializer },
    }
    const line = lineFor(options, logger => logger.info({
      req: { id: 'req-1', method: 'GET', url: '/v1/users?q=x', headers: { cookie: 'sid=1' } },
      res: { statusCode: 200, headers: { 'set-cookie': 'sid=1' } },
      email: USER.email,
    }))

    expect(line).toMatchObject({
      req: { id: 'req-1', method: 'GET', url: `/v1/users?${REDACTED}` },
      res: { statusCode: 200 },
      email: REDACTED,
    })
  })
})

describe('createRequestSerializer and responseSerializer', () => {
  it('keeps the query string out of the URL and the caller out of the line', () => {
    expect(
      createRequestSerializer()({
        id: 'req-1',
        method: 'GET',
        url: '/v1/users?q=%2B15550100200',
        query: { q: '+15550100200' },
        headers: { 'authorization': 'Bearer x', 'x-forwarded-for': '10.0.0.1' },
        remoteAddress: '10.0.0.1',
        remotePort: 51_234,
      }),
    ).toEqual({ id: 'req-1', method: 'GET', url: `/v1/users?${REDACTED}` })

    expect(responseSerializer({ statusCode: 204, headers: { 'set-cookie': 'sid=abc' } })).toEqual({
      statusCode: 204,
    })
  })

  it('cuts a token segment out of the URL', () => {
    const serialize = createRequestSerializer({ redactPath: createPathRedactor({ tokens: ['/f/:token'] }) })

    expect(serialize({ id: 'req-1', method: 'POST', url: '/v1/f/s3cr3t.mac/submissions' })).toEqual({
      id: 'req-1',
      method: 'POST',
      url: '/v1/f/[token]/submissions',
    })
    expect(serialize({ id: 'req-2', method: 'GET', url: '/v1/f/s3cr3t.mac?x=1' })).toEqual({
      id: 'req-2',
      method: 'GET',
      url: `/v1/f/[token]?${REDACTED}`,
    })
  })

  it('scrubs an e-mail address written into the path', () => {
    expect(createRequestSerializer()({ id: 'r', method: 'GET', url: `/v1/users/${USER.email}` }).url).toBe(
      `/v1/users/${REDACTED}`,
    )
  })
})

describe('allowlistChildBindings', () => {
  function childLine(make: (logger: pino.Logger) => pino.Logger): Record<string, unknown> {
    return lineFor(shipped, logger => make(allowlistChildBindings(logger)).info('hello'))
  }

  it('redacts a child logger binding that is not on the list, and keeps one that is', () => {
    const line = childLine(logger => logger.child({ code: 'c_1', email: USER.email, user: USER }))

    expect(line).toMatchObject({ code: 'c_1', email: REDACTED, user: REDACTED })
    expect(JSON.stringify(line)).not.toContain(USER.email)
  })

  it('walks the bindings of a grandchild, and of a child given options', () => {
    const line = childLine(logger => logger.child({ code: 'c_1' }).child({ phone: USER.phone }, { level: 'info' }))

    expect(line).toMatchObject({ code: 'c_1', phone: REDACTED })
  })
})

describe('createLogFormatter: error causes', () => {
  it('logs the cause chain of an error, scrubbed', () => {
    const cause = new Error(`no account for ${USER.email}`)
    const line = lineFor(shipped, logger => logger.error({ err: new Error('signup failed', { cause }) }, 'signup'))

    expect(line.err).toMatchObject({ message: `signup failed: no account for ${REDACTED}` })
    expect(JSON.stringify(line)).not.toContain(USER.email)
  })
})
