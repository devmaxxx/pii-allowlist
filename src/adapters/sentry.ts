import type { Allowlist } from '../allowlist'
import type { PathRedactor } from '../path'
import { createAllowlist } from '../allowlist'
import { createPathRedactor } from '../path'
import { attributeValue, pickScrubbed } from './attributes'
import { DEFAULT_SPAN_ATTRIBUTES } from './semconv'

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
 * Span attributes that may be reported: {@link DEFAULT_SPAN_ATTRIBUTES} plus the metadata the
 * SDK writes itself. `sentry.segment.name` is the transaction name, so it is path-redacted.
 */
export const DEFAULT_SENTRY_SPAN_ATTRIBUTES: readonly string[] = [
  ...DEFAULT_SPAN_ATTRIBUTES,
  'sentry.op',
  'sentry.origin',
  'sentry.source',
  'sentry.sample_rate',
  'sentry.segment.id',
  'sentry.segment.name',
  'sentry.release',
  'sentry.environment',
  'sentry.sdk.name',
  'sentry.sdk.version',
]

/** Log attributes the SDK writes from its own configuration, kept whatever the allowlist says. */
const LOG_METADATA_KEYS: ReadonlySet<string> = new Set([
  'sentry.release',
  'sentry.environment',
  'sentry.sdk.name',
  'sentry.sdk.version',
  'sentry.origin',
  'sentry.replay_id',
  'sentry._internal.replay_is_buffering',
  'sentry.trace.parent_span_id',
  'sentry.message.template',
])

/** A parameterized log message stores each interpolated value under one of these, unnamed. */
const LOG_PARAMETER_KEY = /^sentry\.message\.parameter\.\d+$/

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

/**
 * The parts of a span this module reads, in either shape the SDK hands `beforeSendSpan`: the
 * streamed one (`name`, `attributes`, the default from SDK v11) or the static one (`description`,
 * `op`, `data`), which is also what a transaction event's `spans` hold.
 */
export interface SpanLike {
  name?: string
  description?: string
  op?: string
  attributes?: Record<string, unknown>
  data?: Record<string, unknown>
  tags?: Record<string, unknown>
  links?: { attributes?: unknown }[]
}

/** The parts of a Sentry log this module reads; see {@link BreadcrumbLike}. */
export interface LogLike {
  message?: unknown
  attributes?: Record<string, unknown>
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
  spans?: SpanLike[]
  contexts?: { trace?: { data?: Record<string, unknown> } }
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
  /**
   * Which span attributes survive; the rest are dropped. Applies to `beforeSendSpan`, to a
   * transaction's `spans` and to `contexts.trace.data`. Defaults to
   * {@link DEFAULT_SENTRY_SPAN_ATTRIBUTES}.
   */
  spanAllowlist?: Allowlist
}

interface Scrubbers {
  allowlist: Allowlist
  redactPath: PathRedactor
  spanAllowlist: Allowlist
}

function scrubbersOf(options: SentryScrubOptions): Scrubbers {
  return {
    allowlist: options.allowlist ?? createAllowlist({ keys: DEFAULT_SENTRY_KEYS }),
    redactPath: options.redactPath ?? createPathRedactor(),
    spanAllowlist: options.spanAllowlist ?? createAllowlist({ keys: DEFAULT_SENTRY_SPAN_ATTRIBUTES }),
  }
}

/** A URL reported on its own: path-redacted, then scrubbed, because a path can hold an address. */
function scrubUrl(url: string, { allowlist, redactPath }: Scrubbers): string {
  return allowlist.scrubText(redactPath(url))
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
 * Only whitespace-delimited words that start with `/` or a scheme are URLs: the path redactor cuts
 * at the first `?` or `#`, which would truncate a CSS selector or a question elsewhere in the text.
 */
const URL_WORD = /(^|\s)((?:[a-z][\d+.a-z-]*:\/\/|\/)\S*)/gi

function redactUrlWords(text: string, redactPath: (url: string) => string): string {
  return text.replace(URL_WORD, (_, lead: string, url: string) => lead + redactPath(url))
}

/**
 * A breadcrumb as it may be reported. Console breadcrumbs (`category: 'console'`) and debug ones
 * lose their message and data whole, because they hold whatever the app logged. Any other keeps
 * its allowlisted `data`, with URLs path-redacted, and its message scrubbed, with every URL in it
 * path-redacted.
 */
function scrubBreadcrumb<B extends BreadcrumbLike>(crumb: B, scrubbers: Scrubbers): B {
  if (crumb.category === 'console' || crumb.type === 'debug')
    return { ...crumb, message: undefined, data: undefined }

  const { allowlist, redactPath } = scrubbers
  const next: B = { ...crumb }
  if (crumb.data !== undefined)
    next.data = redactRecordWithUrls(crumb.data, scrubbers)
  if (typeof crumb.message === 'string') {
    next.message = allowlist.scrubText(redactUrlWords(crumb.message, redactPath))
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
 *    objects keep allowlisted keys only;
 *  - a transaction's `spans` and `contexts.trace.data` are scrubbed as {@link createBeforeSendSpan}
 *    does, so the same function serves as `beforeSendTransaction`.
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
  const { allowlist } = scrubbers

  return <E extends SentryEventLike>(event: E): E => {
    const next: E = { ...event }
    if (event.request !== undefined)
      next.request = scrubRequest(event.request, scrubbers)
    delete next.user
    if (event.extra !== undefined)
      next.extra = redactRecordWithUrls(event.extra, scrubbers)
    if (event.breadcrumbs !== undefined)
      next.breadcrumbs = event.breadcrumbs.map(crumb => scrubBreadcrumb(crumb, scrubbers))
    if (typeof event.transaction === 'string')
      next.transaction = scrubUrl(event.transaction, scrubbers)
    if (typeof event.message === 'string')
      next.message = allowlist.scrubText(event.message)
    if (event.logentry !== undefined)
      next.logentry = scrubLogentry(event.logentry, allowlist)
    if (event.exception?.values !== undefined)
      next.exception = { ...event.exception, values: event.exception.values.map(value => scrubException(value, scrubbers)) }
    if (event.threads?.values !== undefined)
      next.threads = { ...event.threads, values: event.threads.values.map(thread => withScrubbedStacktrace(thread, scrubbers)) }
    if (event.spans !== undefined)
      next.spans = event.spans.map(span => scrubSpan(span, scrubbers))
    if (event.contexts?.trace?.data !== undefined)
      next.contexts = { ...event.contexts, trace: { ...event.contexts.trace, data: scrubSpanAttributes(event.contexts.trace.data, scrubbers) } }
    return next
  }
}

function scrubRequest(request: NonNullable<SentryEventLike['request']>, scrubbers: Scrubbers): { url?: string, method?: string } {
  return {
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: scrubUrl(request.url, scrubbers) }),
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

function stringAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributeValue(attributes[key])
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Non-allowlisted span attributes are dropped, as the OpenTelemetry exporter drops them. */
function scrubSpanAttributes(attributes: Record<string, unknown>, scrubbers: Scrubbers): Record<string, unknown> {
  return pickScrubbed(attributes, scrubbers.spanAllowlist, key => key === 'sentry.segment.name'
    ? text => scrubUrl(text, scrubbers)
    : scrubbers.allowlist.scrubText)
}

/**
 * Quoted strings and numbers in a statement become `?`. Database spans are named after their
 * statement, and an instrumentation that does not parameterize it puts the literals there.
 */
const SQL_STRING = /'(?:[^']|'')*'/g
const SQL_STRING_BACKSLASH_ESCAPED = /'(?:[^'\\]|\\.|'')*'/g
/** PostgreSQL's `$$text$$` and `$tag$text$tag$`; a `$1` placeholder has no closing `$`. */
const SQL_DOLLAR_QUOTED = /\$(\w*)\$[\s\S]*?\$\1\$/g
const SQL_NUMBER = /(?<![\w$.])-?\d+(?:\.\d+)?\b/g

/**
 * Standard SQL doubles a quote inside a string and MySQL may escape it with a backslash; the span
 * does not say which. When the two readings disagree, or a quote is left unpaired (a truncated
 * statement), everything from the first quote on is cut, so no reading leaks a literal's tail.
 */
function sanitizeSql(sql: string): string {
  const statement = sql.replace(SQL_DOLLAR_QUOTED, '?')
  const strings = statement.replace(SQL_STRING, '?')
  const firstQuote = statement.indexOf('\'')
  const ambiguous = strings !== statement.replace(SQL_STRING_BACKSLASH_ESCAPED, '?') || strings.includes('\'')
  const safe = ambiguous ? `${statement.slice(0, firstQuote)}?` : strings
  return safe.replace(SQL_NUMBER, '?')
}

function isDatabaseSpan(op: string | undefined, attributes: Record<string, unknown>): boolean {
  return (op ?? stringAttribute(attributes, 'sentry.op'))?.startsWith('db') === true
    || stringAttribute(attributes, 'db.system') !== undefined
    || stringAttribute(attributes, 'db.system.name') !== undefined
}

/**
 * A server span with a matched route is named `METHOD /route/{template}`; a database span has
 * its literals cut; any other name has the URLs in it path-redacted. All are then text-scrubbed.
 */
function safeSentrySpanName(name: string, op: string | undefined, attributes: Record<string, unknown>, scrubbers: Scrubbers): string {
  const method = stringAttribute(attributes, 'http.request.method') ?? stringAttribute(attributes, 'http.method')
  const route = stringAttribute(attributes, 'http.route')
  let safe: string
  if (isDatabaseSpan(op, attributes))
    safe = sanitizeSql(name)
  else if (method !== undefined && route !== undefined)
    safe = `${method} ${route}`
  else
    safe = redactUrlWords(name, scrubbers.redactPath)
  return scrubbers.allowlist.scrubText(safe)
}

function scrubSpan<S extends SpanLike>(span: S, scrubbers: Scrubbers): S {
  const raw = span.attributes ?? span.data ?? {}
  const next: S = { ...span }
  if (span.attributes !== undefined)
    next.attributes = scrubSpanAttributes(span.attributes, scrubbers)
  if (span.data !== undefined)
    next.data = scrubSpanAttributes(span.data, scrubbers)
  if (span.tags !== undefined)
    next.tags = scrubSpanAttributes(span.tags, scrubbers)
  if (typeof span.name === 'string')
    next.name = safeSentrySpanName(span.name, span.op, raw, scrubbers)
  if (typeof span.description === 'string')
    next.description = safeSentrySpanName(span.description, span.op, raw, scrubbers)
  if (span.links !== undefined)
    next.links = span.links.map(({ attributes: _dropped, ...link }) => link)
  return next
}

/**
 * Sentry's `beforeSendSpan`. Since SDK v11 spans are streamed by default, and a streamed span
 * never passes through `beforeSend` or `beforeSendTransaction`, so without this hook its
 * attributes (`url.full`, `db.query.text`, …) leave as they are.
 *
 * Attributes not on `spanAllowlist` are dropped; the rest have the text patterns scrubbed out;
 * the name (or the static shape's `description`) is made safe: `METHOD /route` for a routed
 * server span, literals cut from a database statement, URLs path-redacted; link attributes are
 * dropped. The hook cannot drop a span, so it never returns `null`.
 *
 * @example
 * Sentry.init({ beforeSendSpan: createBeforeSendSpan({ redactPath }) })
 * // traceLifecycle: 'static' (SDK v10 and earlier, or opted in):
 * Sentry.init({ beforeSendSpan: Sentry.withStaticSpan(createBeforeSendSpan()) })
 */
export function createBeforeSendSpan(
  options: SentryScrubOptions = {},
): <S extends SpanLike>(span: S) => S {
  const scrubbers = scrubbersOf(options)
  return span => scrubSpan(span, scrubbers)
}

/**
 * Sentry's `beforeSendLog`, for `Sentry.logger.*`. The message loses the text patterns. An
 * attribute keeps its value when `allowlist` names it and is redacted otherwise; that includes
 * `user.id`, `user.email` and `user.name`, which the SDK copies from the scope. The values a
 * parameterized message was built from (`sentry.message.parameter.N`) are walked as unnamed
 * values, and the SDK's own metadata (`sentry.release`, `sentry.environment`, …) is kept.
 *
 * @example
 * Sentry.init({ beforeSendLog: createBeforeSendLog() })
 */
export function createBeforeSendLog(
  options: SentryScrubOptions = {},
): <L extends LogLike>(log: L) => L {
  const scrubbers = scrubbersOf(options)
  const { allowlist } = scrubbers

  return <L extends LogLike>(log: L): L => {
    const next: L = { ...log }
    if (log.message !== undefined)
      next.message = scrubLogMessage(log.message, allowlist)
    if (log.attributes !== undefined)
      next.attributes = scrubLogAttributes(log.attributes, scrubbers)
    return next
  }
}

/** `fmt` builds a `String` object, which `typeof` calls an object; anything else is walked, not stringified. */
function scrubLogMessage(message: unknown, allowlist: Allowlist): unknown {
  if (typeof message === 'string' || Object.prototype.toString.call(message) === '[object String]') {
    return allowlist.scrubText(String(message))
  }
  return allowlist.redact(message)
}

function scrubLogAttributes(attributes: Record<string, unknown>, scrubbers: Scrubbers): Record<string, unknown> {
  const { allowlist } = scrubbers
  const own: Record<string, unknown> = {}
  const sdk: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (LOG_METADATA_KEYS.has(key))
      sdk[key] = typeof value === 'string' ? allowlist.scrubText(value) : value
    else if (LOG_PARAMETER_KEY.test(key))
      sdk[key] = allowlist.redact(value)
    else
      own[key] = value
  }
  return { ...redactRecordWithUrls(own, scrubbers), ...sdk }
}
