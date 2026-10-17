import { describe, expect, it } from 'vitest'
import { CIRCULAR, createAllowlist, DEFAULT_TEXT_PATTERNS, REDACTED, TEXT_PATTERNS } from '../src'

const EMAIL = 'jane.roe@example.com'
const PHONE = '+15550100200'

describe('createAllowlist: default deny', () => {
  it('redacts every key it was not told about', () => {
    const allowlist = createAllowlist({ keys: ['orderId'] })

    expect(allowlist.redact({ orderId: 'o_1', email: EMAIL, firstName: 'Jane' })).toEqual({
      orderId: 'o_1',
      email: REDACTED,
      firstName: REDACTED,
    })
  })

  it('redacts everything when the list is empty', () => {
    const allowlist = createAllowlist({ keys: [] })

    expect(allowlist.redact({ a: 1, b: { c: 2 } })).toEqual({ a: REDACTED, b: REDACTED })
  })

  it('redacts a whole subtree whose key is not listed, even if its children are', () => {
    const allowlist = createAllowlist({ keys: ['status'] })

    expect(allowlist.redact({ customer: { status: 'active', email: EMAIL } })).toEqual({
      customer: REDACTED,
    })
  })

  it('applies the list at every depth of an allowlisted subtree', () => {
    const allowlist = createAllowlist({ keys: ['order', 'items', 'sku', 'qty'] })

    expect(
      allowlist.redact({ order: { items: [{ sku: 'A1', qty: 2, giftNote: 'for Jane' }] } }),
    ).toEqual({ order: { items: [{ sku: 'A1', qty: 2, giftNote: REDACTED }] } })
  })

  it('never mutates its input', () => {
    const input = { keep: 1, drop: { secret: 'x' } }
    createAllowlist({ keys: ['keep'] }).redact(input)

    expect(input).toEqual({ keep: 1, drop: { secret: 'x' } })
  })
})

describe('createAllowlist: keys by pattern', () => {
  it('allows a key matched by any pattern', () => {
    const allowlist = createAllowlist({ keys: [], patterns: [/^id$/, /Id$/] })

    expect(allowlist.redact({ id: 1, orderId: 2, email: EMAIL })).toEqual({
      id: 1,
      orderId: 2,
      email: REDACTED,
    })
  })

  it('gives the same verdict every time for a pattern with a global flag', () => {
    const allowlist = createAllowlist({ keys: [], patterns: [/Id$/g] })

    expect([allowlist.has('userId'), allowlist.has('userId'), allowlist.has('userId')]).toEqual([
      true,
      true,
      true,
    ])
  })
})

describe('createAllowlist: what a redacted value becomes', () => {
  it('uses a constant placeholder', () => {
    const allowlist = createAllowlist({ keys: [], redactWith: '***' })

    expect(allowlist.redact({ email: EMAIL })).toEqual({ email: '***' })
  })

  it('uses a function of the key and the value', () => {
    const allowlist = createAllowlist({
      keys: [],
      redactWith: (key, value) => `[${key}: ${typeof value}]`,
    })

    expect(allowlist.redact({ email: EMAIL, age: 41 })).toEqual({
      email: '[email: string]',
      age: '[age: number]',
    })
  })
})

describe('createAllowlist: text inside allowlisted values', () => {
  it('scrubs e-mail addresses and phone numbers by default', () => {
    const allowlist = createAllowlist({ keys: ['message'] })

    expect(allowlist.redact({ message: `no user ${EMAIL}, tried ${PHONE}` })).toEqual({
      message: `no user ${REDACTED}, tried ${REDACTED}`,
    })
  })

  it('applies custom text patterns, with or without a global flag', () => {
    const allowlist = createAllowlist({ keys: ['message'], textPatterns: [/tok_\w+/] })

    expect(allowlist.scrubText('a tok_1 and a tok_2')).toBe(`a ${REDACTED} and a ${REDACTED}`)
  })

  it('keeps strings verbatim when text patterns are turned off', () => {
    const allowlist = createAllowlist({ keys: ['message'], textPatterns: [] })

    expect(allowlist.redact({ message: EMAIL })).toEqual({ message: EMAIL })
  })
})

describe('createAllowlist: awkward shapes', () => {
  it('marks a reference to an ancestor instead of looping', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    const allowlist = createAllowlist({ keys: ['name', 'self'] })

    expect(allowlist.redact(node)).toEqual({ name: 'root', self: CIRCULAR })
  })

  it('walks an object referenced twice from siblings, which is not a cycle', () => {
    const shared = { code: 'E1' }
    const allowlist = createAllowlist({ keys: ['a', 'b', 'code'] })

    expect(allowlist.redact({ a: shared, b: shared })).toEqual({ a: { code: 'E1' }, b: { code: 'E1' } })
  })

  it('replaces an object nested deeper than maxDepth', () => {
    const allowlist = createAllowlist({ keys: ['a'], maxDepth: 2 })

    expect(allowlist.redact({ a: { a: { a: { a: 1 } } } })).toEqual({ a: { a: { a: REDACTED } } })
  })

  it('walks an error by its type, message and stack, which are not enumerable', () => {
    const error = Object.assign(new TypeError(`bad ${EMAIL}`), { email: EMAIL, code: 'E_BAD' })
    const allowlist = createAllowlist({ keys: ['err', 'type', 'message', 'code'] })

    expect(allowlist.redact({ err: error })).toEqual({
      err: { type: 'TypeError', message: `bad ${REDACTED}`, stack: REDACTED, email: REDACTED, code: 'E_BAD' },
    })
  })

  it('replaces maps, sets and buffers whole, whose contents it cannot judge by key', () => {
    const allowlist = createAllowlist({ keys: ['m', 's', 'b'] })

    expect(
      allowlist.redact({ m: new Map([['email', EMAIL]]), s: new Set([EMAIL]), b: new Uint8Array([1]) }),
    ).toEqual({ m: REDACTED, s: REDACTED, b: REDACTED })
  })

  it('keeps numbers, booleans, null and dates under an allowlisted key', () => {
    const at = new Date('2026-01-01T00:00:00Z')
    const allowlist = createAllowlist({ keys: ['n', 'b', 'z', 'at'] })

    expect(allowlist.redact({ n: 1, b: true, z: null, at })).toEqual({ n: 1, b: true, z: null, at })
  })

  it('walks each record of a top-level array', () => {
    const allowlist = createAllowlist({ keys: ['id'] })

    expect(allowlist.redact([{ id: 1, email: EMAIL }, { id: 2 }])).toEqual([
      { id: 1, email: REDACTED },
      { id: 2 },
    ])
  })

  it('copies a __proto__ key as data instead of swapping the prototype', () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "id": 1}') as Record<string, unknown>
    const out = createAllowlist({ keys: ['__proto__', 'polluted', 'id'] }).redactRecord(input)

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    expect((out as { polluted?: unknown }).polluted).toBeUndefined()
  })
})

describe('createAllowlist: pick', () => {
  it('keeps allowlisted entries as they are and drops the rest', () => {
    const allowlist = createAllowlist({ keys: ['route'] })

    expect(allowlist.pick({ route: `/users/${EMAIL}`, email: EMAIL })).toEqual({
      route: `/users/${EMAIL}`,
    })
  })
})

describe('createAllowlist: regressions', () => {
  it('turns a top-level self-referencing array into CIRCULAR instead of overflowing the stack', () => {
    const items: unknown[] = []
    items.push(items)

    expect(createAllowlist({ keys: [] }).redact(items)).toEqual([CIRCULAR])
  })

  it('scrubs a long run of letters in linear time', () => {
    const started = Date.now()
    createAllowlist({ keys: [] }).scrubText('a'.repeat(50_000))

    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('createAllowlist: values that throw when read', () => {
  function throwingGetter(key: string): Record<string, unknown> {
    return Object.defineProperty({ status: 'ok' }, key, {
      enumerable: true,
      get: () => {
        throw new Error('nope')
      },
    })
  }

  it('redacts an allowlisted key whose getter throws and keeps its siblings', () => {
    const allowlist = createAllowlist({ keys: ['status', 'orderId'] })

    expect(allowlist.redact(throwingGetter('orderId'))).toEqual({ status: 'ok', orderId: REDACTED })
    expect(allowlist.redactRecord(throwingGetter('orderId'))).toEqual({ status: 'ok', orderId: REDACTED })
  })

  it('redacts a nested object whose keys cannot be listed', () => {
    const allowlist = createAllowlist({ keys: ['order'] })
    const order = new Proxy({}, {
      ownKeys: () => {
        throw new Error('nope')
      },
    })

    expect(allowlist.redact({ order })).toEqual({ order: REDACTED })
  })

  it('skips an unreadable key in pick', () => {
    expect(createAllowlist({ keys: ['status', 'orderId'] }).pick(throwingGetter('orderId'))).toEqual({ status: 'ok' })
  })
})

describe('createAllowlist: phone numbers as people write them', () => {
  const allowlist = createAllowlist({ keys: ['message'] })

  it.each([
    '+1 (415) 555-0123',
    '+44 20 7946 0958',
    '+49-30-901820',
    '+33.1.23.45.67.89',
  ])('scrubs %s', (phone) => {
    expect(allowlist.scrubText(`call ${phone} today`)).toBe(`call ${REDACTED} today`)
  })

  it('keeps short signed numbers and offsets that are not phone numbers', () => {
    expect(allowlist.scrubText('delta +42, tz +05:30, build +1234')).toBe('delta +42, tz +05:30, build +1234')
  })
})

describe('createAllowlist: error causes', () => {
  it('walks the cause an error was constructed with, which is not enumerable', () => {
    const error = new Error('outer', { cause: Object.assign(new Error(`inner ${EMAIL}`), { email: EMAIL }) })
    const allowlist = createAllowlist({ keys: ['err', 'type', 'message', 'cause'] })

    expect(allowlist.redact({ err: error })).toEqual({
      err: {
        type: 'Error',
        message: 'outer',
        stack: REDACTED,
        cause: { type: 'Error', message: `inner ${REDACTED}`, stack: REDACTED, email: REDACTED },
      },
    })
  })

  it('redacts a cause whose key is not on the list', () => {
    const error = new Error('outer', { cause: { email: EMAIL } })
    const allowlist = createAllowlist({ keys: ['err', 'message'] })

    expect(allowlist.redact({ err: error })).toMatchObject({ err: { cause: REDACTED } })
  })
})

describe('createAllowlist: default text patterns beyond addresses and phones', () => {
  const allowlist = createAllowlist({ keys: [] })
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.c2lnbmF0dXJl'

  it.each([
    ['a card number', 'paid with 4111 1111 1111 1111 ok', `paid with ${REDACTED} ok`],
    ['a card number written with dashes', 'card 5555-5555-5555-4444', `card ${REDACTED}`],
    ['a JSON Web Token', `token ${JWT} expired`, `token ${REDACTED} expired`],
    ['bearer credentials, keeping the scheme', 'Authorization: Bearer abc123.def456', `Authorization: Bearer ${REDACTED}`],
  ])('scrubs %s', (_name, text, expected) => {
    expect(allowlist.scrubText(text)).toBe(expected)
  })

  it('keeps a long digit string that fails the Luhn check', () => {
    expect(allowlist.scrubText('order 4111111111111112 shipped')).toBe('order 4111111111111112 shipped')
  })

  it('leaves IP addresses alone unless asked', () => {
    expect(allowlist.scrubText('from 203.0.113.7')).toBe('from 203.0.113.7')
  })
})

describe('createAllowlist: opt-in IP address patterns', () => {
  const allowlist = createAllowlist({ keys: [], textPatterns: [...DEFAULT_TEXT_PATTERNS, TEXT_PATTERNS.ipv4, TEXT_PATTERNS.ipv6] })

  it.each([
    ['203.0.113.7', REDACTED],
    ['2001:db8::8a2e:370:7334', REDACTED],
    ['2001:0db8:0000:0000:0000:ff00:0042:8329', REDACTED],
    ['::1', REDACTED],
    ['v1.2.3.4.5', 'v1.2.3.4.5'],
    ['12:30:45', '12:30:45'],
    ['999.1.1.1', '999.1.1.1'],
  ])('%s becomes %s', (text, expected) => {
    expect(allowlist.scrubText(text)).toBe(expected)
  })
})

describe('createAllowlist: text matchers', () => {
  it('replaces only the matches a matcher accepts', () => {
    const allowlist = createAllowlist({ keys: [], textPatterns: [{ pattern: /\d+/, accept: match => Number(match) > 100 }] })
    expect(allowlist.scrubText('7 of 1234')).toBe(`7 of ${REDACTED}`)
  })
})

describe('createAllowlist: review regressions in text patterns', () => {
  const allowlist = createAllowlist({ keys: [] })

  it('scrubs a card number followed by another number', () => {
    expect(allowlist.scrubText('card 4111111111111111 5 items')).toBe(`card ${REDACTED} 5 items`)
  })

  it.each([
    ['Basic dXNlcjpwYXNz', `Basic ${REDACTED}`],
    ['Basic authentication failed', 'Basic authentication failed'],
    ['Basic Settings saved', 'Basic Settings saved'],
    ['Bearer abcdefgh1234', `Bearer ${REDACTED}`],
  ])('%s becomes %s', (text, expected) => {
    expect(allowlist.scrubText(text)).toBe(expected)
  })
})
