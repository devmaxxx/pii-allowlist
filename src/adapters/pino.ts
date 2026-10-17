import type { Allowlist } from '../allowlist'
import type { PathRedactor } from '../path'
import { createAllowlist, REDACTED } from '../allowlist'
import { createPathRedactor } from '../path'

/**
 * Keys a log line may carry in clear: an error's shape and the request bookkeeping every HTTP
 * logger writes. `message` and `stack` are free text, so the walk scrubs e-mail addresses and
 * phone numbers out of them. A bare `name` and `url` are absent on purpose: no pattern can
 * recognise a person's name, and a URL carries its query string.
 */
export const DEFAULT_LOG_KEYS: readonly string[] = [
  'err',
  'error',
  'type',
  'message',
  'stack',
  'code',
  'reqId',
  'method',
  'statusCode',
  'responseTime',
  'durationMs',
  'count',
  'event',
]

export interface LogFormatterOptions {
  /** Which keys are logged in clear. Defaults to {@link DEFAULT_LOG_KEYS}. */
  allowlist?: Allowlist
  /**
   * Top-level keys handed through unwalked, for a serializer to own. pino calls `formatters.log`
   * before its serializers, so pino-http's `req` and `res` are still raw Node objects here; list
   * them only together with serializers that reduce them, such as
   * {@link createRequestSerializer} and {@link responseSerializer}. Defaults to none.
   */
  passThrough?: Iterable<string>
}

/**
 * pino's `formatters.log`: every key of a log call's merging object that is not allowlisted is
 * logged as `[redacted]`, subtree and all.
 *
 * Child-logger bindings and the message string do not pass through `formatters.log`; see
 * {@link createMessageSerializer} for the message.
 *
 * @example
 * pino({ formatters: { log: createLogFormatter() } })
 */
export function createLogFormatter(
  options: LogFormatterOptions = {},
): (object: Record<string, unknown>) => Record<string, unknown> {
  const allowlist = options.allowlist ?? createAllowlist({ keys: DEFAULT_LOG_KEYS })
  const passThrough = new Set(options.passThrough)

  return (object) => {
    const scrubbed = allowlist.redactRecord(withoutKeys(object, passThrough))
    for (const key of passThrough) {
      if (Object.hasOwn(object, key))
        scrubbed[key] = object[key]
    }
    return scrubbed
  }
}

function withoutKeys(object: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  if (keys.size === 0)
    return object
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.has(key)))
}

export interface MessageSerializerOptions {
  /** Whose text patterns are applied. Defaults to one with the default patterns. */
  allowlist?: Allowlist
}

/**
 * A serializer for pino's message key, which pino applies to the message string after
 * `formatters.log`: it scrubs the allowlist's text patterns out of it.
 *
 * @example
 * pino({ serializers: { msg: createMessageSerializer() } })
 */
export function createMessageSerializer(
  options: MessageSerializerOptions = {},
): (message: unknown) => unknown {
  const allowlist = options.allowlist ?? createAllowlist({ keys: [] })
  return message => typeof message === 'string' ? allowlist.scrubText(message) : message
}

export interface RequestSerializerOptions {
  /** Applied to the URL before it is logged. Defaults to {@link createPathRedactor}'s. */
  redactPath?: PathRedactor
  /** Whose text patterns are scrubbed out of the path. Defaults to the default patterns. */
  allowlist?: Allowlist
}

/**
 * A `req` serializer that logs `{ id, method, url }` and nothing else: headers, cookies, the
 * caller's address and the query string stay out. A query becomes `?[redacted]`, so the line
 * still says one was there.
 */
export function createRequestSerializer(
  options: RequestSerializerOptions = {},
): (req: Record<string, unknown>) => Record<string, unknown> {
  const redactPath = options.redactPath ?? createPathRedactor()
  const allowlist = options.allowlist ?? createAllowlist({ keys: [] })
  return (req) => {
    const url = typeof req.url === 'string' ? req.url : ''
    const path = allowlist.scrubText(redactPath(url))
    return {
      id: req.id,
      method: req.method,
      url: url.includes('?') ? `${path}?${REDACTED}` : path,
    }
  }
}

/** A `res` serializer that logs the status code alone; `set-cookie` lives in the rest. */
export function responseSerializer(res: Record<string, unknown>): Record<string, unknown> {
  return { statusCode: res.statusCode }
}
