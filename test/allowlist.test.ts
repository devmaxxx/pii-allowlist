import { describe, expect, it } from 'vitest'
import { CIRCULAR, createAllowlist, REDACTED } from '../src'

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
