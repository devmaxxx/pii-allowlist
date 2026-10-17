import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { Allowlist } from '../allowlist'
import { createAllowlist } from '../allowlist'
import { failedExport } from './attributes'
import { allowlistResource, DEFAULT_RESOURCE_ATTRIBUTES } from './otel'
import { DEFAULT_LOG_KEYS } from './pino'

type ExportCallback = Parameters<LogRecordExporter['export']>[1]

/**
 * Log record attributes that may be exported: {@link DEFAULT_LOG_KEYS} and the semantic
 * conventions for a recorded exception, whose message and stack trace are text-scrubbed.
 */
export const DEFAULT_LOG_ATTRIBUTES: readonly string[] = [
  ...DEFAULT_LOG_KEYS,
  'exception.type',
  'exception.message',
  'exception.stacktrace',
]

export interface AllowlistLogRecordExporterOptions {
  /** Which attribute keys keep their values. Defaults to {@link DEFAULT_LOG_ATTRIBUTES}. */
  allowlist?: Allowlist
  /** Which resource attribute keys survive. Defaults to {@link DEFAULT_RESOURCE_ATTRIBUTES}. */
  resourceAllowlist?: Allowlist
}

/**
 * A copy of `record` carrying only what the allowlists name. Attributes not on `allowlist` are
 * redacted, subtree and all, as a pino line's keys are, so a missing key shows up as `[redacted]`
 * rather than disappearing. A string body loses the text patterns; a structured body is walked as
 * an unnamed value. The resource is filtered as a span's is.
 */
export function allowlistLogRecord(
  record: ReadableLogRecord,
  allowlist: Allowlist,
  resourceAllowlist?: Allowlist,
): ReadableLogRecord {
  return {
    hrTime: record.hrTime,
    hrTimeObserved: record.hrTimeObserved,
    ...(record.spanContext === undefined ? {} : { spanContext: record.spanContext }),
    ...(record.severityText === undefined ? {} : { severityText: record.severityText }),
    ...(record.severityNumber === undefined ? {} : { severityNumber: record.severityNumber }),
    ...(record.body === undefined ? {} : { body: scrubBody(record.body, allowlist) }),
    ...(record.eventName === undefined ? {} : { eventName: record.eventName }),
    resource: allowlistResource(record.resource, resourceAllowlist),
    instrumentationScope: record.instrumentationScope,
    attributes: allowlist.redactRecord(record.attributes) as ReadableLogRecord['attributes'],
    droppedAttributesCount: record.droppedAttributesCount,
  }
}

function scrubBody(body: ReadableLogRecord['body'], allowlist: Allowlist): ReadableLogRecord['body'] {
  return typeof body === 'string' ? allowlist.scrubText(body) : allowlist.redact(body) as ReadableLogRecord['body']
}

/**
 * A `LogRecordExporter` that hands `next` an allowlisted copy of every log record, leaving the
 * records the rest of the pipeline holds untouched. Wrap the real exporter with it inside the
 * log record processor.
 *
 * @example
 * new BatchLogRecordProcessor({ exporter: new AllowlistLogRecordExporter(new OTLPLogExporter()) })
 */
export class AllowlistLogRecordExporter implements LogRecordExporter {
  private readonly allowlist: Allowlist
  private readonly resourceAllowlist: Allowlist | undefined

  constructor(private readonly next: LogRecordExporter, options: AllowlistLogRecordExporterOptions = {}) {
    this.allowlist = options.allowlist ?? createAllowlist({ keys: DEFAULT_LOG_ATTRIBUTES })
    this.resourceAllowlist = options.resourceAllowlist
  }

  export(records: ReadableLogRecord[], resultCallback: ExportCallback): void {
    let copies: ReadableLogRecord[]
    try {
      copies = records.map(record => allowlistLogRecord(record, this.allowlist, this.resourceAllowlist))
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
    return this.next.forceFlush()
  }
}
