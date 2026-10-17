import type { Allowlist } from '../allowlist'
import type { PathRedactor } from '../path'
import { createAllowlist } from '../allowlist'
import { createPathRedactor } from '../path'

/**
 * Breadcrumb `data` and event `extra` keys that may be reported: what the SDK's fetch, xhr and
 * navigation breadcrumbs record about a request, minus its body. `url`, `from` and `to` also go
 * through the path redactor.
 */
export const DEFAULT_SENTRY_KEYS: readonly string[] = [
  'method',
  'url',
  'from',
  'to',
  'status_code',
  'request_body_size',
  'response_body_size',
]

const URL_KEYS = ['url', 'from', 'to'] as const

/**
 * The parts of a Sentry breadcrumb this module reads. Structural, so it fits every SDK
 * (`@sentry/node`, `@sentry/browser`, `@sentry/nextjs`, …) without importing one.
 */
export interface BreadcrumbLike {
  type?: string
  category?: string
  message?: string
  data?: Record<string, unknown>
}

/** The parts of a Sentry event this module reads; see {@link BreadcrumbLike}. */
export interface SentryEventLike {
  message?: string
  transaction?: string
  request?: { url?: string, method?: string }
  user?: unknown
  extra?: Record<string, unknown>
  breadcrumbs?: BreadcrumbLike[]
  exception?: { values?: { value?: string }[] }
}

export interface SentryScrubOptions {
  /** Which breadcrumb `data` and event `extra` keys survive. Defaults to {@link DEFAULT_SENTRY_KEYS}. */
  allowlist?: Allowlist
  /**
   * Applied to every URL: `request.url`, the transaction name, breadcrumb messages and their
   * `url`, `from` and `to`. Defaults to {@link createPathRedactor}'s, which drops the query and the
   * fragment; build one with `tokens` to cut secret path segments too.
   */
  redactPath?: PathRedactor
}

interface Scrubbers {
  allowlist: Allowlist
  redactPath: PathRedactor
}

function scrubbersOf(options: SentryScrubOptions): Scrubbers {
  return {
    allowlist: options.allowlist ?? createAllowlist({ keys: DEFAULT_SENTRY_KEYS }),
    redactPath: options.redactPath ?? createPathRedactor(),
  }
}

function withRedactedUrls(record: Record<string, unknown>, redactPath: PathRedactor): Record<string, unknown> {
  const copy = { ...record }
  for (const key of URL_KEYS) {
    const value = copy[key]
    if (typeof value === 'string')
      copy[key] = redactPath(value)
  }
  return copy
}

/**
 * A breadcrumb as it may be reported. Console breadcrumbs (`category: 'console'`) and debug ones
 * lose their message and data whole, because they hold whatever the app logged. Any other keeps
 * its allowlisted `data`, with URLs path-redacted, and a path-redacted message.
 */
function scrubBreadcrumb<B extends BreadcrumbLike>(crumb: B, scrubbers: Scrubbers): B {
  if (crumb.category === 'console' || crumb.type === 'debug')
    return { ...crumb, message: undefined, data: undefined }

  const { allowlist, redactPath } = scrubbers
  const next: B = { ...crumb }
  if (crumb.data !== undefined) {
    next.data = allowlist.redactRecord(withRedactedUrls(crumb.data, redactPath))
  }
  if (typeof crumb.message === 'string')
    next.message = allowlist.scrubText(redactPath(crumb.message))
  return next
}

/**
 * Sentry's `beforeBreadcrumb`. See {@link createBeforeSend} for what is kept.
 *
 * @example
 * Sentry.init({ beforeBreadcrumb: createBeforeBreadcrumb() })
 */
export function createBeforeBreadcrumb(
  options: SentryScrubOptions = {},
): <B extends BreadcrumbLike>(breadcrumb: B) => B {
  const scrubbers = scrubbersOf(options)
  return breadcrumb => scrubBreadcrumb(breadcrumb, scrubbers)
}

/**
 * Sentry's `beforeSend`, returning a scrubbed copy of the event:
 *
 *  - `request` keeps its method and its path-redacted URL; body, headers, cookies, query string
 *    and env are dropped;
 *  - `user` is dropped;
 *  - `extra` keeps allowlisted keys only, walked deep;
 *  - breadcrumbs are scrubbed as {@link createBeforeBreadcrumb} does;
 *  - the transaction name is path-redacted;
 *  - the message and each exception's value lose the allowlist's text patterns.
 *
 * `tags` and `contexts` are not touched: the SDK fills them with runtime and trace data.
 *
 * @example
 * Sentry.init({
 *   beforeSend: createBeforeSend({ redactPath: createPathRedactor({ tokens: ['/reset/:token'] }) }),
 * })
 */
export function createBeforeSend(
  options: SentryScrubOptions = {},
): <E extends SentryEventLike>(event: E) => E {
  const scrubbers = scrubbersOf(options)
  const { allowlist, redactPath } = scrubbers

  return <E extends SentryEventLike>(event: E): E => {
    const next: E = { ...event }
    if (event.request !== undefined)
      next.request = scrubRequest(event.request, redactPath)
    delete next.user
    if (event.extra !== undefined)
      next.extra = allowlist.redactRecord(withRedactedUrls(event.extra, redactPath))
    if (event.breadcrumbs !== undefined)
      next.breadcrumbs = event.breadcrumbs.map(crumb => scrubBreadcrumb(crumb, scrubbers))
    if (typeof event.transaction === 'string')
      next.transaction = redactPath(event.transaction)
    if (typeof event.message === 'string')
      next.message = allowlist.scrubText(event.message)
    if (event.exception?.values !== undefined)
      next.exception = { ...event.exception, values: event.exception.values.map(value => scrubException(value, allowlist)) }
    return next
  }
}

function scrubRequest(request: NonNullable<SentryEventLike['request']>, redactPath: PathRedactor): { url?: string, method?: string } {
  return {
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: redactPath(request.url) }),
  }
}

function scrubException<X extends { value?: string }>(exception: X, allowlist: Allowlist): X {
  return typeof exception.value === 'string'
    ? { ...exception, value: allowlist.scrubText(exception.value) }
    : exception
}
