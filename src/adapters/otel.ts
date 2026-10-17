import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { Allowlist } from '../allowlist'
import { createAllowlist } from '../allowlist'
import { failedExport, pickScrubbed } from './attributes'
import { DEFAULT_SPAN_ATTRIBUTES } from './semconv'

export { DEFAULT_SPAN_ATTRIBUTES }

type ExportCallback = Parameters<SpanExporter['export']>[1]
type Resource = ReadableSpan['resource']

/**
 * Resource attributes that name the service and the SDK. `host.*`, `process.*` (command line,
 * owner), `container.*` and cloud account IDs are absent on purpose: resource detectors fill them
 * from the machine, and a command line can carry a secret.
 */
export const DEFAULT_RESOURCE_ATTRIBUTES: readonly string[] = [
  'service.name',
  'service.version',
  'service.namespace',
  'deployment.environment',
  'deployment.environment.name',
  'telemetry.sdk.name',
  'telemetry.sdk.language',
  'telemetry.sdk.version',
]

const HTTP_METHOD_KEYS = ['http.request.method', 'http.method'] as const

const defaultResourceAllowlist = /* @__PURE__ */ createAllowlist({ keys: DEFAULT_RESOURCE_ATTRIBUTES })

export interface AllowlistSpanExporterOptions {
  /** Which attribute keys survive. Defaults to {@link DEFAULT_SPAN_ATTRIBUTES}. */
  allowlist?: Allowlist
  /** Which resource attribute keys survive. Defaults to {@link DEFAULT_RESOURCE_ATTRIBUTES}. */
  resourceAllowlist?: Allowlist
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
 * A copy of `resource` carrying only the attributes `allowlist` names, text-scrubbed. `merge`
 * filters its result too, so nothing downstream can bring a dropped attribute back.
 */
export function allowlistResource(resource: Resource, allowlist: Allowlist = defaultResourceAllowlist): Resource {
  const attributes = pickScrubbed(resource.attributes, allowlist)
  return {
    attributes,
    ...(resource.schemaUrl === undefined ? {} : { schemaUrl: resource.schemaUrl }),
    merge: other => allowlistResource(resource.merge(other), allowlist),
    getRawAttributes: () => Object.entries(attributes),
  }
}

/**
 * A copy of `span` carrying only what the allowlists name: attributes not on `allowlist` are
 * dropped and counted in `droppedAttributesCount`, and the strings of the rest, like the name,
 * lose the allowlist's text patterns; resource attributes not on `resourceAllowlist`
 * are dropped; events (recorded exceptions included) are dropped; links keep their span context
 * and lose their attributes; the status keeps its code and loses its message; the name goes
 * through {@link safeSpanName}.
 */
export function allowlistSpan(
  span: ReadableSpan,
  allowlist: Allowlist,
  resourceAllowlist: Allowlist = defaultResourceAllowlist,
): ReadableSpan {
  const attributes = pickScrubbed(span.attributes, allowlist)
  const removed = Object.keys(span.attributes).length - Object.keys(attributes).length

  return {
    name: allowlist.scrubText(safeSpanName(span.name, attributes)),
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
    resource: allowlistResource(span.resource, resourceAllowlist),
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
  private readonly resourceAllowlist: Allowlist

  constructor(private readonly next: SpanExporter, options: AllowlistSpanExporterOptions = {}) {
    this.allowlist = options.allowlist ?? createAllowlist({ keys: DEFAULT_SPAN_ATTRIBUTES })
    this.resourceAllowlist = options.resourceAllowlist ?? defaultResourceAllowlist
  }

  export(spans: ReadableSpan[], resultCallback: ExportCallback): void {
    let copies: ReadableSpan[]
    try {
      copies = spans.map(span => allowlistSpan(span, this.allowlist, this.resourceAllowlist))
    }
    catch (error) {
      resultCallback(failedExport(error))
      return
    }
    this.next.export(copies, resultCallback)
  }

  shutdown(): Promise<void> {
    return this.next.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush?.() ?? Promise.resolve()
  }
}
