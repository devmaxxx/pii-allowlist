import type { Allowlist } from '../allowlist'
import type { PathRedactor } from '../path'
import { createAllowlist } from '../allowlist'
import { createPathRedactor } from '../path'

/**
 * Breadcrumb `data`, event `extra` and stack frame `vars` keys that may be reported: what the SDK's
 * fetch, xhr and navigation breadcrumbs record about a request, minus its body. `url`, `from` and
 * `to` also go through the path redactor.
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

/** The parts of a stack trace this module reads; see {@link BreadcrumbLike}. */
export interface StacktraceLike {
  frames?: { vars?: Record<string, unknown> }[]
}

/** The parts of a Sentry event this module reads; see {@link BreadcrumbLike}. */
export interface SentryEventLike {
  message?: string
  logentry?: { message?: string, params?: unknown[] }
  transaction?: string
  request?: { url?: string, method?: string }
  user?: unknown
  extra?: Record<string, unknown>
  breadcrumbs?: BreadcrumbLike[]
  exception?: { values?: { value?: string, stacktrace?: StacktraceLike }[] }
  threads?: { values?: { stacktrace?: StacktraceLike }[] }
}

export interface SentryScrubOptions {
  /**
   * Which breadcrumb `data`, event `extra` and stack frame `vars` keys survive. Defaults to
   * {@link DEFAULT_SENTRY_KEYS}.
   */
  allowlist?: Allowlist
  /**
   * Applied to every URL: `request.url`, the transaction name, breadcrumb messages that are URLs,
   * and the `url`, `from` and `to` keys. Defaults to {@link createPathRedactor}'s, which drops the
   * query and the fragment; build one with `tokens` to cut secret path segments too.
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

/** Path-redacts after the walk, so a throwing getter is met by the walker, not by a spread. */
function redactRecordWithUrls(record: Record<string, unknown>, { allowlist, redactPath }: Scrubbers): Record<string, unknown> {
  const redacted = allowlist.redactRecord(record)
  for (const key of URL_KEYS) {
    const value = redacted[key]
    if (typeof value === 'string')
      redacted[key] = redactPath(value)
  }
  return redacted
}

/**
 * A message is a URL only when it starts with `/` or parses as an absolute one: the path redactor
 * cuts at the first `?` or `#`, which would truncate a CSS selector or a question.
 */
function isUrl(text: string): boolean {
  if (text.startsWith('/'))
    return true
  try {
    return Boolean(new URL(text))
  }
  catch {
    return false
  }
}

/**
 * A breadcrumb as it may be reported. Console breadcrumbs (`category: 'console'`) and debug ones
 * lose their message and data whole, because they hold whatever the app logged. Any other keeps
 * its allowlisted `data`, with URLs path-redacted, and its message scrubbed, path-redacted when it
 * is a URL.
 */
function scrubBreadcrumb<B extends BreadcrumbLike>(crumb: B, scrubbers: Scrubbers): B {
  if (crumb.category === 'console' || crumb.type === 'debug')
    return { ...crumb, message: undefined, data: undefined }

  const { allowlist, redactPath } = scrubbers
  const next: B = { ...crumb }
  if (crumb.data !== undefined)
    next.data = redactRecordWithUrls(crumb.data, scrubbers)
  if (typeof crumb.message === 'string') {
    const message = isUrl(crumb.message) ? redactPath(crumb.message) : crumb.message
    next.message = allowlist.scrubText(message)
  }
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
 *  - the local variables (`vars`) of every exception and thread stack frame keep allowlisted
 *    names only;
 *  - breadcrumbs are scrubbed as {@link createBeforeBreadcrumb} does;
 *  - the transaction name is path-redacted;
 *  - the message, the `logentry` message and each exception's value lose the allowlist's text
 *    patterns; `logentry.params` are walked as unnamed values, so strings are scrubbed and
 *    objects keep allowlisted keys only.
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
      next.extra = redactRecordWithUrls(event.extra, scrubbers)
    if (event.breadcrumbs !== undefined)
      next.breadcrumbs = event.breadcrumbs.map(crumb => scrubBreadcrumb(crumb, scrubbers))
    if (typeof event.transaction === 'string')
      next.transaction = redactPath(event.transaction)
    if (typeof event.message === 'string')
      next.message = allowlist.scrubText(event.message)
    if (event.logentry !== undefined)
      next.logentry = scrubLogentry(event.logentry, allowlist)
    if (event.exception?.values !== undefined)
      next.exception = { ...event.exception, values: event.exception.values.map(value => scrubException(value, scrubbers)) }
    if (event.threads?.values !== undefined)
      next.threads = { ...event.threads, values: event.threads.values.map(thread => withScrubbedStacktrace(thread, scrubbers)) }
    return next
  }
}

function scrubRequest(request: NonNullable<SentryEventLike['request']>, redactPath: PathRedactor): { url?: string, method?: string } {
  return {
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: redactPath(request.url) }),
  }
}

function scrubLogentry<L extends NonNullable<SentryEventLike['logentry']>>(logentry: L, allowlist: Allowlist): L {
  const next: L = { ...logentry }
  if (typeof logentry.message === 'string')
    next.message = allowlist.scrubText(logentry.message)
  if (logentry.params !== undefined)
    next.params = logentry.params.map(param => allowlist.redact(param))
  return next
}

function scrubException<X extends { value?: string, stacktrace?: StacktraceLike }>(exception: X, scrubbers: Scrubbers): X {
  const next = withScrubbedStacktrace(exception, scrubbers)
  if (typeof exception.value === 'string')
    next.value = scrubbers.allowlist.scrubText(exception.value)
  return next
}

function withScrubbedStacktrace<T extends { stacktrace?: StacktraceLike }>(owner: T, scrubbers: Scrubbers): T {
  const frames = owner.stacktrace?.frames
  if (frames === undefined)
    return { ...owner }
  const scrubbed = frames.map(frame =>
    frame.vars === undefined ? frame : { ...frame, vars: redactRecordWithUrls(frame.vars, scrubbers) })
  return { ...owner, stacktrace: { ...owner.stacktrace, frames: scrubbed } }
}
