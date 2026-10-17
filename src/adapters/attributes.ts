import type { Allowlist } from '../allowlist'

type Scrub = (text: string) => string

/** Sentry's streamed attributes may be wrapped as `{ value, unit }`. */
export function attributeValue(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'value' in value ? value.value : value
}

function scrubAttributeValue(value: unknown, scrub: Scrub): unknown {
  if (typeof value === 'string')
    return scrub(value)
  if (Array.isArray(value))
    return value.map(item => typeof item === 'string' ? scrub(item) : item)
  if (typeof value === 'object' && value !== null && 'value' in value)
    return { ...value, value: scrubAttributeValue(value.value, scrub) }
  return value
}

/**
 * The attributes `allowlist` names, unwalked, with every string they carry scrubbed by
 * `scrubFor(key)`; the rest are dropped, as telemetry attributes are flat and counted when dropped.
 */
export function pickScrubbed<A extends Readonly<Record<string, unknown>>>(
  attributes: A,
  allowlist: Allowlist,
  scrubFor: (key: string) => Scrub = () => allowlist.scrubText,
): A {
  const kept = allowlist.pick(attributes) as Record<string, unknown>
  for (const [key, value] of Object.entries(kept))
    kept[key] = scrubAttributeValue(value, scrubFor(key))
  return kept as A
}

/**
 * What an exporter wrapper hands its callback when it cannot build a safe copy: the batch fails
 * rather than being forwarded unfiltered. `1` is `ExportResultCode.FAILED`, written as a literal
 * so `@opentelemetry/core` is not a runtime dependency.
 */
export function failedExport(error: unknown): { code: 1, error: Error } {
  return { code: 1, error: error instanceof Error ? error : new Error(String(error)) }
}
