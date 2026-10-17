import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { describe, expect, it } from 'vitest'
import { createAllowlist } from '../src'
import { allowlistSpan, AllowlistSpanExporter, DEFAULT_SPAN_ATTRIBUTES } from '../src/adapters/otel'

const PHONE = '+15550100200'
const EMAIL = 'jane.roe@example.com'
const TOKEN = 'tok_not_a_real_one'
const SECRETS = [PHONE, EMAIL, TOKEN, '203.0.113.7']

function exported(exporter?: (memory: InMemorySpanExporter) => AllowlistSpanExporter): {
  memory: InMemorySpanExporter
  provider: BasicTracerProvider
} {
  const memory = new InMemorySpanExporter()
  const allowlisted = exporter?.(memory) ?? new AllowlistSpanExporter(memory)
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(allowlisted)] })
  return { memory, provider }
}

describe('AllowlistSpanExporter', () => {
  it('drops every attribute, event and message that is not on the list', () => {
    const { memory, provider } = exported()
    const span = provider.getTracer('test').startSpan(`GET /v1/users?phone=${PHONE}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': 'GET',
        'http.route': '/v1/users',
        'http.response.status_code': 200,
        'url.full': `https://api.example/v1/users?phone=${PHONE}&token=${TOKEN}`,
        'url.query': `phone=${PHONE}&token=${TOKEN}`,
        'http.target': `/v1/users?email=${EMAIL}`,
        'db.statement': `SELECT * FROM users WHERE email = '${EMAIL}'`,
        'client.address': '203.0.113.7',
        'enduser.id': EMAIL,
      },
      links: [
        {
          context: { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 },
          attributes: { phone: PHONE },
        },
      ],
    })
    span.addEvent('exception', { 'exception.message': `no user ${EMAIL}` })
    span.setStatus({ code: SpanStatusCode.ERROR, message: `phone ${PHONE} is taken` })
    span.end()

    const [out] = memory.getFinishedSpans()
    expect(out?.name).toBe('GET /v1/users')
    expect(out?.attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/v1/users',
      'http.response.status_code': 200,
    })
    expect(out?.events).toEqual([])
    expect(out?.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(out?.links[0]?.attributes).toBeUndefined()
    expect(out?.droppedAttributesCount).toBe(6)
    expect(out?.droppedEventsCount).toBe(1)

    const wire = JSON.stringify(out)
    for (const secret of SECRETS)
      expect(wire).not.toContain(secret)
  })

  it('drops an attribute nobody listed, whatever its name', () => {
    const { memory, provider } = exported()
    provider.getTracer('test').startSpan('work', { attributes: { 'app.customer_email': EMAIL } }).end()

    expect(memory.getFinishedSpans()[0]?.attributes).toEqual({})
  })

  it('keeps only what a custom allowlist names', () => {
    const allowlist = createAllowlist({ keys: [...DEFAULT_SPAN_ATTRIBUTES, 'tenant.id'], patterns: [/^app\.count\./] })
    const { memory, provider } = exported(memory => new AllowlistSpanExporter(memory, { allowlist }))
    provider
      .getTracer('test')
      .startSpan('job', {
        attributes: { 'tenant.id': 't_1', 'app.count.rows': 3, 'db.system': 'postgresql', 'app.user': EMAIL },
      })
      .end()

    expect(memory.getFinishedSpans()[0]?.attributes).toEqual({
      'tenant.id': 't_1',
      'app.count.rows': 3,
      'db.system': 'postgresql',
    })
  })

  it('names an HTTP span with no matched route by its method alone', () => {
    const { memory, provider } = exported()
    provider
      .getTracer('test')
      .startSpan(`GET /reset/${TOKEN}`, { attributes: { 'http.method': 'GET' } })
      .end()

    expect(memory.getFinishedSpans()[0]?.name).toBe('GET')
  })

  it('cuts the query string off any other span name', () => {
    const { memory, provider } = exported()
    provider.getTracer('test').startSpan(`render /f/x?token=${TOKEN}`).end()

    expect(memory.getFinishedSpans()[0]?.name).toBe('render /f/x')
  })

  it('leaves the span the rest of the pipeline holds untouched', () => {
    const memory = new InMemorySpanExporter()
    const raw = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new SimpleSpanProcessor(new AllowlistSpanExporter(memory)),
        new SimpleSpanProcessor(raw),
      ],
    })
    provider.getTracer('test').startSpan('pg.query', { attributes: { 'db.statement': PHONE } }).end()

    expect(memory.getFinishedSpans()[0]?.attributes).toEqual({})
    expect(raw.getFinishedSpans()[0]?.attributes).toEqual({ 'db.statement': PHONE })
  })
})

describe('AllowlistSpanExporter, the pass-through half', () => {
  it('keeps a child span on its parent and forwards flush and shutdown', async () => {
    const { memory, provider } = exported()
    const tracer = provider.getTracer('test')
    const parent = tracer.startSpan('parent')
    const child = tracer.startSpan(
      'child',
      { attributes: { 'http.method': 'POST', 'http.route': '' } },
      trace.setSpan(context.active(), parent),
    )
    child.end()
    parent.end()

    const [out] = memory.getFinishedSpans()
    expect(out?.name).toBe('POST')
    expect(out?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)

    const exporter = new AllowlistSpanExporter(memory)
    await exporter.forceFlush()
    await exporter.shutdown()
    expect(memory.getFinishedSpans()).toEqual([])
  })

  it('flushes an exporter that has no forceFlush of its own', async () => {
    const bare = { export: () => undefined, shutdown: () => Promise.resolve() }
    await expect(new AllowlistSpanExporter(bare).forceFlush()).resolves.toBeUndefined()
  })
})

describe('AllowlistSpanExporter: the resource', () => {
  function withResource(attributes: Record<string, string>, options?: ConstructorParameters<typeof AllowlistSpanExporter>[1]): ReadableSpan | undefined {
    const memory = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes(attributes),
      spanProcessors: [new SimpleSpanProcessor(new AllowlistSpanExporter(memory, options))],
    })
    provider.getTracer('test').startSpan('work').end()
    return memory.getFinishedSpans()[0]
  }

  it('keeps only the default resource attributes', () => {
    const out = withResource({
      'service.name': 'checkout',
      'service.version': '1.2.3',
      'deployment.environment.name': 'prod',
      'telemetry.sdk.language': 'nodejs',
      'host.name': 'jane-laptop',
      'process.command_args': `--token=${TOKEN}`,
      'enduser.id': EMAIL,
    })

    expect(out?.resource.attributes).toEqual({
      'service.name': 'checkout',
      'service.version': '1.2.3',
      'deployment.environment.name': 'prod',
      'telemetry.sdk.language': 'nodejs',
    })
    expect(Object.fromEntries(out?.resource.getRawAttributes() ?? [])).toEqual(out?.resource.attributes)
    expect(JSON.stringify(out?.resource.merge(null).attributes)).not.toContain(TOKEN)
  })

  it('keeps only what a custom resource allowlist names', () => {
    const out = withResource(
      { 'service.name': 'checkout', 'cloud.region': 'eu-west-1' },
      { resourceAllowlist: createAllowlist({ keys: ['cloud.region'] }) },
    )

    expect(out?.resource.attributes).toEqual({ 'cloud.region': 'eu-west-1' })
  })

  it('filters the resource when allowlistSpan is called directly', () => {
    const memory = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ 'service.name': 'checkout', 'host.name': 'jane-laptop' }),
      spanProcessors: [new SimpleSpanProcessor(memory)],
    })
    provider.getTracer('test').startSpan('work').end()
    const [raw] = memory.getFinishedSpans()

    expect(raw && allowlistSpan(raw, createAllowlist({ keys: [] })).resource.attributes).toEqual({ 'service.name': 'checkout' })
  })
})
