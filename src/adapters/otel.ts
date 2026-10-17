import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { Allowlist } from '../allowlist'
import { createAllowlist } from '../allowlist'

type ExportCallback = Parameters<SpanExporter['export']>[1]

/**
 * Span attributes that name a template, a code, a system or a count — never a value somebody
 * typed. Both the stable and the older semantic-convention names are listed. `url.*`,
 * `http.target`, `http.url`, `db.statement`, `db.query.text`, `client.address`,
 * `user_agent.original` and every `*.header.*` are absent on purpose: they carry query strings,
 * SQL literals and addresses.
 */
export const DEFAULT_SPAN_ATTRIBUTES: readonly string[] = [
  'http.request.method',
  'http.method',
  'http.route',
  'http.response.status_code',
  'http.status_code',
  'network.protocol.version',
  'server.address',
  'server.port',
  'db.system',
  'db.system.name',
  'db.operation',
  'db.operation.name',
  'db.name',
  'db.namespace',
  'messaging.system',
  'messaging.destination.name',
  'messaging.operation',
  'messaging.operation.name',
  'messaging.operation.type',
  'error.type',
]

const HTTP_METHOD_KEYS = ['http.request.method', 'http.method'] as const

export interface AllowlistSpanExporterOptions {
  /** Which attribute keys survive. Defaults to {@link DEFAULT_SPAN_ATTRIBUTES}. */
  allowlist?: Allowlist
}

/**
 * The name a span may leave with. An HTTP span (one with a method attribute) becomes
 * `METHOD /route/{template}`, or `METHOD` alone when no route matched, because instrumentation
 * names an unmatched request by its raw path. Any other name loses its query string.
 */
export function safeSpanName(name: string, attributes: Readonly<Record<string, unknown>>): string {
  const method = HTTP_METHOD_KEYS
    .map(key => attributes[key])
    .find((value): value is string => typeof value === 'string')
  if (method !== undefined) {
    const route = attributes['http.route']
    return typeof route === 'string' && route !== '' ? `${method} ${route}` : method
  }

  const query = name.indexOf('?')
  return query === -1 ? name : name.slice(0, query)
}

/**
 * A copy of `span` carrying only what the allowlist names: attributes not on it are dropped and
 * counted in `droppedAttributesCount`; events (recorded exceptions included) are dropped; links
 * keep their span context and lose their attributes; the status keeps its code and loses its
 * message; the name goes through {@link safeSpanName}.
 */
export function allowlistSpan(span: ReadableSpan, allowlist: Allowlist): ReadableSpan {
  const attributes = allowlist.pick(span.attributes)
  const removed = Object.keys(span.attributes).length - Object.keys(attributes).length

  return {
    name: safeSpanName(span.name, attributes),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext === undefined ? {} : { parentSpanContext: span.parentSpanContext }),
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes,
    links: span.links.map(link => ({ context: link.context })),
    events: [],
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount + removed,
    droppedEventsCount: span.droppedEventsCount + span.events.length,
    droppedLinksCount: span.droppedLinksCount,
  }
}

/**
 * A `SpanExporter` that hands `next` an allowlisted copy of every span, leaving the spans the rest
 * of the pipeline holds untouched. Wrap the real exporter with it inside the span processor.
 *
 * @example
 * new BatchSpanProcessor(new AllowlistSpanExporter(new OTLPTraceExporter()))
 */
export class AllowlistSpanExporter implements SpanExporter {
  private readonly allowlist: Allowlist

  constructor(private readonly next: SpanExporter, options: AllowlistSpanExporterOptions = {}) {
    this.allowlist = options.allowlist ?? createAllowlist({ keys: DEFAULT_SPAN_ATTRIBUTES })
  }

  export(spans: ReadableSpan[], resultCallback: ExportCallback): void {
    this.next.export(spans.map(span => allowlistSpan(span, this.allowlist)), resultCallback)
  }

  shutdown(): Promise<void> {
    return this.next.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush?.() ?? Promise.resolve()
  }
}
