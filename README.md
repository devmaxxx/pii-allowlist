# pii-allowlist

Default-deny PII filtering for logs, traces and error reports. A value leaves your process only when its key is on a list you wrote; everything else becomes `[redacted]`.

One zero-dependency core, plus thin adapters for [OpenTelemetry](https://opentelemetry.io/), [pino](https://getpino.io/) and [Sentry](https://sentry.io/).

## Why an allowlist

A denylist (`redact: ['password', '*.email']`) censors the keys somebody foresaw. Instrumentation and application code write keys nobody foresaw: `url.full` with the query string, `db.statement` with a phone number in a `WHERE`, a `customer` object logged whole, a new `taxId` field added next quarter. A denylist misses each of them silently, and a leak is invisible until someone reads the logs.

An allowlist fails the other way. A key you forgot is redacted, you notice the `[redacted]` in a dashboard, and you add the key. The list has to know only what your dashboards and alerts read, which is short and stable.

## Install

```sh
pnpm add pii-allowlist
```

ESM only, Node 20+ (the core and the Sentry adapter also run in browsers). Each adapter's framework is an optional peer dependency: install only what you use.

| Entry | For | Peer dependency |
| --- | --- | --- |
| `pii-allowlist` | the core | none |
| `pii-allowlist/otel` | trace exporters | `@opentelemetry/sdk-trace-base` >= 2 |
| `pii-allowlist/pino` | log lines | `pino` >= 8 |
| `pii-allowlist/sentry` | error events and breadcrumbs | `@sentry/core` >= 8 (any Sentry SDK) |

## Core

```ts
import { createAllowlist, createPathRedactor } from 'pii-allowlist'

const allowlist = createAllowlist({
  keys: ['orderId', 'status', 'items', 'sku', 'qty'],
  patterns: [/Id$/], // any key ending in "Id"
})

allowlist.redact({
  orderId: 'o_1',
  customer: { email: 'jane@example.com' },
  items: [{ sku: 'A1', qty: 2, giftNote: 'for Jane' }],
})
// { orderId: 'o_1', customer: '[redacted]', items: [{ sku: 'A1', qty: 2, giftNote: '[redacted]' }] }

const redactPath = createPathRedactor({ tokens: ['/reset/:token', '/invite/:token/accept'] })
redactPath('https://app.example/en/reset/s3cr3t?email=jane@example.com')
// 'https://app.example/en/reset/[token]'
```

`createAllowlist(options)`:

- `keys`: exact key names allowed at any depth.
- `patterns`: regular expressions; a key matching any of them is allowed.
- `redactWith`: the placeholder (default `'[redacted]'`), or `(key, value) => replacement`.
- `textPatterns`: patterns cut out of every string that survives (default: e-mail addresses and E.164 phone numbers; `[]` to turn off).
- `maxDepth`: objects nested deeper are replaced whole (default 8).

It returns `{ has, redact, redactRecord, pick, scrubText }`. Nothing is mutated; circular references become `'[circular]'`; errors are walked as `{ type, message, stack, ...ownProperties }`; maps, sets and binary buffers are replaced whole.

## OpenTelemetry

```ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { AllowlistSpanExporter } from 'pii-allowlist/otel'

const processor = new BatchSpanProcessor(new AllowlistSpanExporter(new OTLPTraceExporter()))
```

Each exported span keeps only allowlisted attributes (default: `DEFAULT_SPAN_ATTRIBUTES`, the HTTP method, route and status, database and messaging system and operation, `error.type`). Events, including recorded exceptions, are dropped; links lose their attributes; the status loses its message; an HTTP span is renamed `METHOD /route/{template}`, and any other span name loses its query string. Pass `{ allowlist }` as the second argument to choose the attributes.

## pino

```ts
import { createAllowlist } from 'pii-allowlist'
import { createLogFormatter, createMessageSerializer, DEFAULT_LOG_KEYS } from 'pii-allowlist/pino'
import pino from 'pino'

const logger = pino({
  formatters: {
    log: createLogFormatter({
      allowlist: createAllowlist({ keys: [...DEFAULT_LOG_KEYS, 'orderId'] }),
    }),
  },
  serializers: { msg: createMessageSerializer() },
})

logger.info({ orderId: 'o_1', email: 'jane@example.com' }, 'order placed')
// {"level":30,...,"orderId":"o_1","email":"[redacted]","msg":"order placed"}
```

pino calls `formatters.log` before its serializers, so with pino-http the `req` and `res` keys are still raw Node objects there. To log them, hand them through to serializers that reduce them:

```ts
import { createLogFormatter, createRequestSerializer, responseSerializer } from 'pii-allowlist/pino'

const options = {
  formatters: { log: createLogFormatter({ passThrough: ['req', 'res'] }) },
  serializers: { req: createRequestSerializer(), res: responseSerializer },
}
// req is logged as { id, method, url } with the query string replaced by "?[redacted]"
```

## Sentry

```ts
import * as Sentry from '@sentry/node'
import { createPathRedactor } from 'pii-allowlist'
import { createBeforeBreadcrumb, createBeforeSend } from 'pii-allowlist/sentry'

const redactPath = createPathRedactor({ tokens: ['/reset/:token', '/calendar/*/:token.ics'] })

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  beforeSend: createBeforeSend({ redactPath }),
  beforeBreadcrumb: createBeforeBreadcrumb({ redactPath }),
})
```

`beforeSend` keeps only the request's method and redacted URL, drops `user`, keeps allowlisted `extra` keys (default: `DEFAULT_SENTRY_KEYS`), path-redacts the transaction name and breadcrumb URLs, and scrubs e-mail addresses and phone numbers out of the message and exception values. Console and debug breadcrumbs lose their message and data. The helpers are typed structurally, so they fit `@sentry/node`, `@sentry/browser`, `@sentry/nextjs` and the rest.

## Limits

- **Keys, not values.** An allowlisted key carries whatever value it is given. `textPatterns` catch e-mail addresses and phone numbers in allowlisted strings; they cannot recognise a name, an address or a national ID number. Keep free-text keys off the list, or add patterns for your own formats.
- **pino bindings are not walked.** `formatters.log` sees the object passed to each log call, not the bindings of `logger.child({...})`. Keep personal data out of bindings, or filter them with `formatters.bindings`.
- **Sentry `tags` and `contexts` are not walked**, because the SDK fills them with runtime and trace data. Do not put personal data in tags.
- **Span resources are kept.** Resource attributes describe the process (service name, host), not a request.
- **Text scrubbing is best effort.** It is a second line of defence for strings that are already allowlisted, not a substitute for the list.

## License

[MIT](./LICENSE)
