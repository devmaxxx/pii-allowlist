/** The placeholder a value takes when its key is not on the allowlist. */
export const REDACTED = '[redacted]'

/** What a reference back to one of its own ancestors is written as. */
export const CIRCULAR = '[circular]'

/**
 * Text shapes scrubbed from every string an allowlisted key carries: an e-mail address and an
 * E.164 phone number. A key on the list says its value is safe to log; these catch the message
 * somebody built by interpolating one into it anyway.
 */
export const DEFAULT_TEXT_PATTERNS: readonly RegExp[] = [
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu,
  /\+\d{9,15}\b/g,
]

const DEFAULT_MAX_DEPTH = 8

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
  textPatterns?: Iterable<RegExp>
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
   * are replaced whole; a circular reference becomes {@link CIRCULAR}.
   */
  redact: (value: unknown) => unknown
  /** {@link Allowlist.redact} for a record, typed as one. */
  redactRecord: (record: Readonly<Record<string, unknown>>) => Record<string, unknown>
  /** The allowlisted entries of `record` only, unwalked; everything else is dropped. */
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
  const textPatterns = [...(options.textPatterns ?? DEFAULT_TEXT_PATTERNS)].map(withGlobalFlag)
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const redactValue = toRedactFn(options.redactWith)

  function has(key: string): boolean {
    return keys.has(key) || patterns.some(pattern => pattern.test(key))
  }

  function scrubText(text: string): string {
    let scrubbed = text
    for (const pattern of textPatterns)
      scrubbed = scrubbed.replace(pattern, REDACTED)
    return scrubbed
  }

  function walkEntries(value: object, ancestors: object[]): Record<string, unknown> {
    const out = recordFor(value)
    for (const [key, inner] of entriesOf(value))
      setOwn(out, key, has(key) ? walk(key, inner, ancestors) : redactValue(key, inner))
    return out
  }

  function walk(key: string, value: unknown, ancestors: object[]): unknown {
    if (typeof value === 'string')
      return scrubText(value)
    if (typeof value === 'function' || typeof value === 'symbol')
      return redactValue(key, value)
    if (value === null || typeof value !== 'object')
      return value
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
    for (const [key, value] of Object.entries(record)) {
      if (has(key))
        setOwn(kept, key, value)
    }
    return kept
  }

  function redact(value: unknown): unknown {
    if (Array.isArray(value))
      return value.map(item => redact(item))
    if (value === null || typeof value !== 'object' || value instanceof Date)
      return walk('', value, [])
    if (isOpaque(value))
      return redactValue('', value)
    return walkEntries(value, [value])
  }

  return {
    has,
    redact,
    redactRecord: record => walkEntries(record, [record]),
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

function withGlobalFlag(pattern: RegExp): RegExp {
  return pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
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

/** An error's `name`, `message` and `stack` are not enumerable, so `Object.entries` misses them. */
function entriesOf(value: object): [string, unknown][] {
  if (!(value instanceof Error))
    return Object.entries(value)
  return [
    ['type', value.name],
    ['message', value.message],
    ['stack', value.stack],
    ...Object.entries(value),
  ]
}
