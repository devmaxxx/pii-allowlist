<div align="center">

# pii-allowlist

**Allowlist, don't denylist: keep PII out of logs, traces and error reports.**

[![npm version](https://img.shields.io/npm/v/pii-allowlist)](https://www.npmjs.com/package/pii-allowlist)
[![npm downloads](https://img.shields.io/npm/dm/pii-allowlist)](https://www.npmjs.com/package/pii-allowlist)
[![CI](https://github.com/arenuzzz/pii-allowlist/actions/workflows/ci.yml/badge.svg)](https://github.com/arenuzzz/pii-allowlist/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/pii-allowlist)](https://www.npmjs.com/package/pii-allowlist)
[![core dependencies](https://img.shields.io/badge/core%20dependencies-0-brightgreen)](./package.json)
[![bundle size](https://img.shields.io/bundlephobia/minzip/pii-allowlist)](https://bundlephobia.com/package/pii-allowlist)
[![license](https://img.shields.io/npm/l/pii-allowlist)](./LICENSE)

</div>

A value leaves your process only when its key is on a list you wrote. Everything else becomes `[redacted]`. One dependency-free core, plus thin adapters for [OpenTelemetry](https://opentelemetry.io/), [pino](https://getpino.io/) and [Sentry](https://sentry.io/).

## Why allowlist

A denylist (`redact: ['email', 'password']`) censors the keys somebody foresaw. Code writes keys nobody foresaw: `url.full` with a query string, `db.statement` with a phone number in a `WHERE`, a `customer` object logged whole, a `taxId` field added next quarter. A denylist misses each one silently, and the leak stays invisible until someone reads the logs.

An allowlist fails the other way. A key you forgot is redacted, you see `[redacted]` in a dashboard, and you add the key. The list only has to name what your dashboards and alerts read, which is short and stable.

The same pino call, `logger.info({ userId, email, taxId, shippingAddress }, 'signup')`:

| Denylist: `pino({ redact: ['email', 'password'] })` | Allowlist: `createLogFormatter(...)` with `userId` added |
| --- | --- |
| `"userId":"u_9"` | `"userId":"u_9"` |
| `"email":"[Redacted]"` | `"email":"[redacted]"` |
| `"taxId":"DE123456789"` | `"taxId":"[redacted]"` |
| `"shippingAddress":"1 Main St"` | `"shippingAddress":"[redacted]"` |

## Features

- **Default deny.** A key not named by `keys` or `patterns` is redacted, subtree and all, at every depth.
- **Text scrubbing.** E-mail addresses and E.164 phone numbers are cut out of every string that survives, so an allowlisted `message` built by interpolation stays clean.
- **URL redaction.** Query strings and fragments are always dropped; secret path segments (`/reset/:token`) are replaced.
- **Safe walk.** Inputs are never mutated; cycles become `[circular]`; depth is capped; errors are walked as `{ type, message, stack, ... }`; maps, sets and buffers are replaced whole; a `__proto__` key is copied as data; a getter that throws yields `[redacted]` instead of an exception.
- **Adapters** for an OpenTelemetry `SpanExporter`, pino `formatters.log` and serializers, and Sentry `beforeSend` / `beforeBreadcrumb`.
- **Zero dependencies in the core.** Each adapter's framework is an optional peer. ESM only, typed, `sideEffects: false`.

## Install

```sh
npm install pii-allowlist
pnpm add pii-allowlist
yarn add pii-allowlist
bun add pii-allowlist
```

Requires Node 20 or newer. The build is platform-neutral. Add the peer for each adapter you use:

| Entry point | For | Optional peer dependency |
| --- | --- | --- |
| `pii-allowlist` | the core | none |
| `pii-allowlist/otel` | trace exporters | `@opentelemetry/sdk-trace-base` >= 2 |
| `pii-allowlist/pino` | log lines | `pino` >= 8 |
| `pii-allowlist/sentry` | error events and breadcrumbs | none: typed structurally, fits any Sentry SDK >= 8 |

## Quick start

```ts
import { createAllowlist } from 'pii-allowlist'

const allowlist = createAllowlist({ keys: ['orderId', 'status', 'items', 'sku', 'qty', 'note'] })

allowlist.redact({
  orderId: 'o_1',
  status: 'paid',
  customer: { email: 'jane@example.com', phone: '+14155550123' },
  items: [{ sku: 'A1', qty: 2, giftNote: 'for Jane' }],
  note: 'call jane@example.com',
})
// { orderId: 'o_1', status: 'paid', customer: '[redacted]',
//   items: [{ sku: 'A1', qty: 2, giftNote: '[redacted]' }], note: 'call [redacted]' }
```

## OpenTelemetry

```ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { AllowlistSpanExporter } from 'pii-allowlist/otel'

const processor = new BatchSpanProcessor(new AllowlistSpanExporter(new OTLPTraceExporter()))
```

The wrapped exporter receives a copy of each span; the spans the rest of the pipeline holds are untouched. In the copy:

- only allowlisted attributes remain (default `DEFAULT_SPAN_ATTRIBUTES`); the rest are counted in `droppedAttributesCount`;
- the resource keeps only allowlisted attributes (default `DEFAULT_RESOURCE_ATTRIBUTES`: service name, version and namespace, deployment environment, `telemetry.sdk.*`); host, process and container attributes are dropped;
- events, including recorded exceptions, are dropped; links lose their attributes; the status loses its message;
- an HTTP span is renamed `METHOD /route/{template}` (or `METHOD` when no route matched); any other name loses its query string.

To allow more attributes:

```ts
import { createAllowlist } from 'pii-allowlist'
import { AllowlistSpanExporter, DEFAULT_RESOURCE_ATTRIBUTES, DEFAULT_SPAN_ATTRIBUTES } from 'pii-allowlist/otel'

const allowlisted = new AllowlistSpanExporter(exporter, {
  allowlist: createAllowlist({ keys: [...DEFAULT_SPAN_ATTRIBUTES, 'tenant.id'] }),
  resourceAllowlist: createAllowlist({ keys: [...DEFAULT_RESOURCE_ATTRIBUTES, 'cloud.region'] }),
})
```

## pino

```ts
import { createAllowlist } from 'pii-allowlist'
import { createLogFormatter, createMessageSerializer, DEFAULT_LOG_KEYS } from 'pii-allowlist/pino'
import pino from 'pino'

const logger = pino({
  formatters: {
    log: createLogFormatter({ allowlist: createAllowlist({ keys: [...DEFAULT_LOG_KEYS, 'orderId'] }) }),
  },
  serializers: { msg: createMessageSerializer() },
})

logger.info({ orderId: 'o_1', email: 'jane@example.com' }, 'order placed for jane@example.com')
// {"level":30,...,"orderId":"o_1","email":"[redacted]","msg":"order placed for [redacted]"}
```

With pino-http, pino calls `formatters.log` before its serializers, so `req` and `res` are still raw Node objects there. Pass them through to serializers that reduce them:

```ts
import { createPathRedactor } from 'pii-allowlist'
import { createLogFormatter, createRequestSerializer, responseSerializer } from 'pii-allowlist/pino'

const options = {
  formatters: { log: createLogFormatter({ passThrough: ['req', 'res'] }) },
  serializers: {
    req: createRequestSerializer({ redactPath: createPathRedactor({ tokens: ['/reset/:token'] }) }),
    res: responseSerializer,
  },
}
// req: { id: 1, method: 'GET', url: '/en/reset/[token]?[redacted]' }
// res: { statusCode: 200 }
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

`redactPath` turns `https://app.example/en/reset/s3cr3t?email=jane@example.com` into `https://app.example/en/reset/[token]`. A template matches anywhere in the URL, so an origin, an `/api` prefix or a locale in front of it does not hide the token; `*` matches any one segment and keeps it.

`beforeSend` returns a scrubbed copy of the event:

- `request` keeps only its method and path-redacted URL; body, headers, cookies, query string and env are dropped;
- `user` is dropped;
- `extra` and the local variables (`vars`) of exception and thread stack frames keep allowlisted keys only (default `DEFAULT_SENTRY_KEYS`), walked deep;
- the transaction name, breadcrumb `url`, `from` and `to`, and breadcrumb messages that are URLs (absolute, or starting with `/`) are path-redacted;
- e-mail addresses and phone numbers are scrubbed out of the message, the `logentry` message, breadcrumb messages and exception values;
- `logentry.params` are walked as unnamed values: strings are scrubbed, objects keep allowlisted keys only.

Console and debug breadcrumbs lose their message and data. Both helpers are typed structurally, so they fit `@sentry/node`, `@sentry/browser`, `@sentry/nextjs` and the other SDKs without importing one.

## API

### `pii-allowlist`

**`createAllowlist(options): Allowlist`**

| Option | Type | Default | |
| --- | --- | --- | --- |
| `keys` | `Iterable<string>` | required | Keys allowed at any depth, matched exactly. |
| `patterns` | `Iterable<RegExp>` | `[]` | A key matching any pattern is allowed, e.g. `/Id$/`. |
| `redactWith` | `string \| (key, value) => unknown` | `'[redacted]'` | What a non-allowlisted value becomes. |
| `textPatterns` | `Iterable<RegExp>` | `DEFAULT_TEXT_PATTERNS` | Cut out of every surviving string; `[]` keeps strings verbatim. |
| `maxDepth` | `number` | `8` | Objects nested deeper are replaced whole. The top-level record is depth 0. |

The returned `Allowlist` is pure; no method mutates its input.

| Method | Returns |
| --- | --- |
| `has(key)` | whether a value under `key` may leave the process |
| `redact(value)` | a deep copy with every non-allowlisted property replaced; array items inherit their parent key's verdict |
| `redactRecord(record)` | `redact` for a record, typed as one |
| `pick(record)` | only the allowlisted top-level entries, unwalked |
| `scrubText(text)` | `text` with every text pattern replaced by `[redacted]` |

**`createPathRedactor(options?): (url: string) => string`** drops the query string and fragment, then replaces `:token` segments.

| Option | Type | Default | |
| --- | --- | --- | --- |
| `tokens` | `string[]` | `[]` | Route templates with a `:token` segment, e.g. `'/invite/:token/accept'`. A template without one throws. |
| `placeholder` | `string` | `'[token]'` | What a token segment becomes. |

Constants: `REDACTED` (`'[redacted]'`), `CIRCULAR` (`'[circular]'`), `DEFAULT_TEXT_PATTERNS`.

### `pii-allowlist/otel`

| Export | |
| --- | --- |
| `new AllowlistSpanExporter(next, { allowlist?, resourceAllowlist? })` | `SpanExporter` that forwards allowlisted span copies to `next`, plus `shutdown` and `forceFlush`. |
| `allowlistSpan(span, allowlist, resourceAllowlist?)` | The copy of one span the exporter forwards. |
| `allowlistResource(resource, allowlist?)` | The copy of a resource the span carries. |
| `safeSpanName(name, attributes)` | The name a span is exported with. |
| `DEFAULT_SPAN_ATTRIBUTES` | Default attribute keys. |
| `DEFAULT_RESOURCE_ATTRIBUTES` | Default resource attribute keys. |

### `pii-allowlist/pino`

| Export | Options | |
| --- | --- | --- |
| `createLogFormatter(options?)` | `allowlist` (default `DEFAULT_LOG_KEYS`), `passThrough` (top-level keys left for serializers, default none) | `formatters.log` |
| `createMessageSerializer(options?)` | `allowlist` (whose text patterns apply) | serializer for `msg` |
| `createRequestSerializer(options?)` | `redactPath`, `allowlist` | `req` serializer: `{ id, method, url }`, query shown as `?[redacted]` |
| `responseSerializer` | | `res` serializer: `{ statusCode }` |
| `DEFAULT_LOG_KEYS` | | Default log keys. |

### `pii-allowlist/sentry`

| Export | Options | |
| --- | --- | --- |
| `createBeforeSend(options?)` | `allowlist` (default `DEFAULT_SENTRY_KEYS`), `redactPath` (default drops query and fragment) | `beforeSend` |
| `createBeforeBreadcrumb(options?)` | same | `beforeBreadcrumb` |
| `DEFAULT_SENTRY_KEYS` | | Default breadcrumb `data`, event `extra` and stack frame `vars` keys. |

### Defaults

| List | Contents | Left out on purpose |
| --- | --- | --- |
| `DEFAULT_TEXT_PATTERNS` | e-mail addresses, E.164 phone numbers (`+` and 9 to 15 digits) | |
| `DEFAULT_SPAN_ATTRIBUTES` | HTTP method, route, status code, protocol version; `server.address`/`port`; `db.system`, operation, name/namespace; `messaging.system`, destination name, operation; `error.type`. Stable and older semantic-convention names. | `url.*`, `http.target`, `http.url`, `db.statement`, `db.query.text`, `client.address`, `user_agent.original`, headers |
| `DEFAULT_RESOURCE_ATTRIBUTES` | `service.name`, `service.version`, `service.namespace`, `deployment.environment`, `deployment.environment.name`, `telemetry.sdk.name`, `telemetry.sdk.language`, `telemetry.sdk.version` | `host.*`, `process.*`, `container.*`, cloud account IDs |
| `DEFAULT_LOG_KEYS` | `err`, `error`, `type`, `message`, `stack`, `code`, `reqId`, `method`, `statusCode`, `responseTime`, `durationMs`, `count`, `event` | `name`, `url` |
| `DEFAULT_SENTRY_KEYS` | `method`, `url`, `from`, `to`, `status_code`, `request_body_size`, `response_body_size` | request bodies |

## Compared with

| | Model | Keys nobody listed | Runs |
| --- | --- | --- | --- |
| **pii-allowlist** | allowlist | redacted | in process, before export |
| pino `redact` | denylist of paths | logged in clear | in process, pino only |
| [fast-redact](https://github.com/davidmarkclements/fast-redact) | denylist of paths | logged in clear | in process |
| OTel Collector attribute processors | per-key rules you configure | depends on the rules | in the Collector, after the data has left the process |
| Sentry `sendDefaultPii: false` | the SDK skips some data it would collect itself | your own `extra`, breadcrumbs and messages are sent as written | in the SDK |

A denylist is the better fit when the shape of every record is known and fixed. pii-allowlist targets the case where it is not.

## Limits

- **Keys, not values.** An allowlisted key carries whatever value it is given. The default text patterns catch only e-mail addresses and E.164 phone numbers; they cannot recognise a name, a street address or a national ID. Keep free-text keys off the list, or add `textPatterns` for your own formats.
- **Patterns are broad.** `/Id$/` also admits `taxId`. Prefer exact keys.
- **Depth cap.** Objects nested deeper than `maxDepth` (default 8) are replaced whole, allowlisted or not.
- **pino bindings are not walked.** `formatters.log` sees each log call's object, not `logger.child({...})` bindings. Keep personal data out of bindings, or filter them with `formatters.bindings`.
- **Sentry `tags` and `contexts` are not walked**, because the SDK fills them with runtime and trace data.
- **Span resources are filtered, not scrubbed.** Only `DEFAULT_RESOURCE_ATTRIBUTES` (or your `resourceAllowlist`) survive, and their values are passed as they are: a service name built from a customer name still leaks.
- **Breadcrumb messages are URLs only by shape.** A message that is not one, such as `GET /reset/s3cr3t?email=…` in prose, is text-scrubbed but not path-redacted, so its query string stays.
- **Node 20 is untested in CI.** The package declares Node >= 20; CI runs Node 22 and 24 on Linux, macOS and Windows.

## Contributing

Issues and pull requests are welcome at [github.com/arenuzzz/pii-allowlist](https://github.com/arenuzzz/pii-allowlist).

```sh
pnpm install
pnpm build       # tsdown, checked by publint
pnpm test        # vitest
pnpm lint
pnpm typecheck
```

## License

[MIT](./LICENSE)
