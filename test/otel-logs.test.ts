import { resourceFromAttributes } from '@opentelemetry/resources'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { describe, expect, it } from 'vitest'
import { createAllowlist, REDACTED } from '../src'
import { AllowlistLogRecordExporter, DEFAULT_LOG_ATTRIBUTES } from '../src/adapters/otel-logs'

const EMAIL = 'jane.roe@example.com'

function exported(options?: ConstructorParameters<typeof AllowlistLogRecordExporter>[1]): {
  memory: InMemoryLogRecordExporter
  provider: LoggerProvider
} {
  const memory = new InMemoryLogRecordExporter()
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': 'shop', 'host.name': 'jane-laptop' }),
    processors: [new SimpleLogRecordProcessor({ exporter: new AllowlistLogRecordExporter(memory, options) })],
  })
  return { memory, provider }
}

describe('AllowlistLogRecordExporter', () => {
  it('redacts attributes not on the list, scrubs the body and filters the resource', () => {
    const { memory, provider } = exported()
    provider.getLogger('test').emit({
      body: `signup failed for ${EMAIL}`,
      severityText: 'ERROR',
      attributes: {
        'code': 'E_DUP',
        'email': EMAIL,
        'customer': { email: EMAIL },
        'exception.type': 'Error',
        'exception.message': `duplicate ${EMAIL}`,
      },
    })

    const [record] = memory.getFinishedLogRecords()
    expect(record?.body).toBe(`signup failed for ${REDACTED}`)
    expect(record?.severityText).toBe('ERROR')
    expect(record?.attributes).toEqual({
      'code': 'E_DUP',
      'email': REDACTED,
      'customer': REDACTED,
      'exception.type': 'Error',
      'exception.message': `duplicate ${REDACTED}`,
    })
    expect(record?.resource.attributes).toEqual({ 'service.name': 'shop' })
  })

  it('walks a structured body as an unnamed value', () => {
    const { memory, provider } = exported({ allowlist: createAllowlist({ keys: [...DEFAULT_LOG_ATTRIBUTES, 'orderId'] }) })
    provider.getLogger('test').emit({ body: { orderId: 'o_1', email: EMAIL } })

    expect(memory.getFinishedLogRecords()[0]?.body).toEqual({ orderId: 'o_1', email: REDACTED })
  })

  it('leaves the record the rest of the pipeline holds untouched', () => {
    const seen: unknown[] = []
    const memory = new InMemoryLogRecordExporter()
    const provider = new LoggerProvider({
      processors: [
        new SimpleLogRecordProcessor({ exporter: new AllowlistLogRecordExporter(memory) }),
        { onEmit: record => seen.push(record.attributes.email), forceFlush: async () => {}, shutdown: async () => {} },
      ],
    })
    provider.getLogger('test').emit({ attributes: { email: EMAIL } })

    expect(seen).toEqual([EMAIL])
  })
})
