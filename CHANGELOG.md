# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- `createAllowlist`: default-deny redaction of any value by key, with key patterns, a custom placeholder or redaction function, text patterns (e-mail addresses and international phone numbers, grouped or not, by default) and a depth cap. Handles cycles, errors and their `cause`, dates, maps, sets, buffers, `__proto__` keys and getters that throw without mutating its input.
- `createPathRedactor`: drops a URL's query string and fragment and replaces `:token` segments of route templates.
- `pii-allowlist/otel`: `AllowlistSpanExporter`, `allowlistSpan`, `allowlistResource`, `safeSpanName`, `DEFAULT_SPAN_ATTRIBUTES` and `DEFAULT_RESOURCE_ATTRIBUTES`. Resource attributes are allowlisted too, through the `resourceAllowlist` option. Surviving attribute strings and span names are text-scrubbed.
- `pii-allowlist/pino`: `createLogFormatter`, `allowlistChildBindings`, `createMessageSerializer`, `createRequestSerializer`, `responseSerializer` and `DEFAULT_LOG_KEYS`.
- `pii-allowlist/sentry`: `createBeforeSend` (also for `beforeSendTransaction`), `createBeforeBreadcrumb`, `createBeforeSendSpan`, `createBeforeSendLog`, `DEFAULT_SENTRY_KEYS` and `DEFAULT_SENTRY_SPAN_ATTRIBUTES`. Covers `extra`, breadcrumbs, `logentry`, the local variables of exception and thread stack frames, transaction spans, streamed spans (SDK v11's default) and Sentry logs. Typed structurally, with no peer dependency.

[0.1.0]: https://github.com/devmaxxx/pii-allowlist/releases/tag/v0.1.0
