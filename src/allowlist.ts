import type { TextPattern } from './text'
import { compileTextPattern, DEFAULT_TEXT_PATTERNS } from './text'

/** The placeholder a value takes when its key is not on the allowlist. */
export const REDACTED = '[redacted]'

/** What a reference back to one of its own ancestors is written as. */
export const CIRCULAR = '[circular]'

const DEFAULT_MAX_DEPTH = 8

/** What a property read that threw yields: a getter or a proxy trap can throw from a plain read. */
const UNREADABLE = Symbol('unreadable')

/** Replaces the value of a key that is not on the allowlist. */
export type RedactFn = (key: string, value: unknown) => unknown

export interface AllowlistOptions {
  /** Keys whose values may leave the process. Matched exactly, at every depth. */
  keys: Iterable<string>
  /** Further keys, by shape: a key passes when any pattern matches it, e.g. `/Id$/`. */
  patterns?: Iterable<RegExp>
  /**
   * What a non-allowlisted value becomes: a constant, or a function of the key and the value.
   * Defaults to {@link REDACTED}. A function that returns the value unchanged defeats the list.
   */
  redactWith?: string | RedactFn
  /**
   * Patterns cut out of every string that survives the walk, replaced with {@link REDACTED}.
   * Defaults to {@link DEFAULT_TEXT_PATTERNS}; pass `[]` to keep strings verbatim.
   */
  textPatterns?: Iterable<TextPattern>
  /**
   * Objects nested deeper than this are replaced whole, allowlisted or not. Defaults to 8; the
   * top-level record is depth 0.
   */
  maxDepth?: number
}

/** A compiled allowlist. Every method is pure: inputs are never mutated. */
export interface Allowlist {
  /** Whether a value under `key` may leave the process. */
  has: (key: string) => boolean
  /**
   * A deep copy of `value` where every property whose key is not allowlisted is replaced, subtree
   * and all. Array items inherit their parent key's verdict. Errors are walked as prototype-less
   * `{ type, message, stack, ...ownProperties }` records; dates are kept; maps, sets and binary buffers
   * are replaced whole; a circular reference becomes {@link CIRCULAR}. A property whose getter throws
   * is redacted, and so is an object whose keys cannot be listed; the walk itself never throws.
   */
  redact: (value: unknown) => unknown
  /** {@link Allowlist.redact} for a record, typed as one. */
  redactRecord: (record: Readonly<Record<string, unknown>>) => Record<string, unknown>
  /** The allowlisted entries of `record` only, unwalked; everything else, an unreadable entry included, is dropped. */
  pick: <V>(record: Readonly<Record<string, V>>) => Record<string, V>
  /** `text` with every text pattern replaced by {@link REDACTED}. */
  scrubText: (text: string) => string
}

/**
 * Compiles an allowlist. Everything not named by `keys` or `patterns` is redacted: a key nobody
 * thought about is the one that leaks, so the default for an unknown key is deny.
 *
 * @example
 * const allowlist = createAllowlist({ keys: ['orderId', 'status'] })
 * allowlist.redact({ orderId: 'o_1', email: 'a@b.co' })
 * // => { orderId: 'o_1', email: '[redacted]' }
 */
export function createAllowlist(options: AllowlistOptions): Allowlist {
  const keys = new Set(options.keys)
  const patterns = [...(options.patterns ?? [])].map(withoutStatefulFlags)
  const textPatterns = [...(options.textPatterns ?? DEFAULT_TEXT_PATTERNS)].map(compileTextPattern)
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const redactValue = toRedactFn(options.redactWith)

  function has(key: string): boolean {
    return keys.has(key) || patterns.some(pattern => pattern.test(key))
  }

  function scrubText(text: string): string {
    let scrubbed = text
    for (const { pattern, accept } of textPatterns) {
      scrubbed = accept === undefined
        ? scrubbed.replace(pattern, REDACTED)
        : scrubbed.replace(pattern, match => accept(match) ? REDACTED : match)
    }
    return scrubbed
  }

  function walkEntries(value: object, ancestors: object[]): Record<string, unknown> {
    const out = recordFor(value)
    for (const [key, inner] of entriesOf(value))
      setOwn(out, key, walkEntry(key, inner, ancestors))
    return out
  }

  function walkEntry(key: string, value: unknown, ancestors: object[]): unknown {
    if (value === UNREADABLE)
      return redactValue(key, undefined)
    if (!has(key))
      return redactValue(key, value)
    return walk(key, value, ancestors)
  }

  function walk(key: string, value: unknown, ancestors: object[]): unknown {
    if (typeof value === 'string')
      return scrubText(value)
    if (typeof value === 'function' || typeof value === 'symbol')
      return redactValue(key, value)
    if (value === null || typeof value !== 'object')
      return value
    try {
      return walkObject(key, value, ancestors)
    }
    catch {
      return redactValue(key, value)
    }
  }

  /** Throws only for an exotic object, such as a revoked proxy or one whose traps throw. */
  function walkObject(key: string, value: object, ancestors: object[]): unknown {
    if (value instanceof Date)
      return new Date(value.getTime())
    if (ancestors.includes(value))
      return CIRCULAR
    if (ancestors.length > maxDepth || isOpaque(value))
      return redactValue(key, value)

    const path = [...ancestors, value]
    if (Array.isArray(value))
      return value.map(item => walk(key, item, path))
    return walkEntries(value, path)
  }

  function pick<V>(record: Readonly<Record<string, V>>): Record<string, V> {
    const kept: Record<string, V> = {}
    for (const key of Object.keys(record).filter(has)) {
      const value = readOwn<V>(record, key)
      if (value !== UNREADABLE)
        setOwn(kept, key, value)
    }
    return kept
  }

  function redactRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
    try {
      return walkEntries(record, [record])
    }
    catch {
      return {}
    }
  }

  function redact(value: unknown): unknown {
    return walk('', value, [])
  }

  return {
    has,
    redact,
    redactRecord,
    pick,
    scrubText,
  }
}

/** Plain assignment of a `__proto__` key, which `JSON.parse` output can carry, would swap the prototype. */
function setOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

function toRedactFn(redactWith: string | RedactFn = REDACTED): RedactFn {
  return typeof redactWith === 'function' ? redactWith : () => redactWith
}

/** Key patterns are tested once per key, so a `g` or `y` flag would make `lastIndex` skip matches. */
function withoutStatefulFlags(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
}

function isOpaque(value: object): boolean {
  return value instanceof Map
    || value instanceof Set
    || value instanceof WeakMap
    || value instanceof WeakSet
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
}

/**
 * An error becomes a record without a prototype: pino's error serializer re-reads any object with
 * a string `message`, and names it by `constructor.name` — `Object` for a plain record — unless
 * there is no constructor, in which case it keeps the `type` written here.
 */
function recordFor(value: object): Record<string, unknown> {
  return value instanceof Error ? Object.create(null) as Record<string, unknown> : {}
}

/**
 * An error's `name`, `message` and `stack` are not enumerable, so `Object.keys` misses them; nor is
 * the `cause` that `new Error(message, { cause })` sets, which is walked like any other key.
 */
function entriesOf(value: object): [string, unknown][] {
  const keys = Object.keys(value)
  const own = keys.map((key): [string, unknown] => [key, readOwn(value, key)])
  if (!(value instanceof Error))
    return own
  const cause: [string, unknown][] = Object.hasOwn(value, 'cause') && !keys.includes('cause')
    ? [['cause', readOwn(value, 'cause')]]
    : []
  return [
    ['type', readOwn(value, 'name')],
    ['message', readOwn(value, 'message')],
    ['stack', readOwn(value, 'stack')],
    ...cause,
    ...own,
  ]
}

function readOwn<V>(value: object, key: string): V | typeof UNREADABLE {
  try {
    return (value as Record<string, V>)[key] as V
  }
  catch {
    return UNREADABLE
  }
}
