# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- `createAllowlist`: default-deny redaction of any value by key, with key patterns, a custom placeholder or redaction function, text patterns (e-mail addresses and E.164 phone numbers by default) and a depth cap. Handles cycles, errors, dates, maps, sets, buffers and `__proto__` keys without mutating its input.
- `createPathRedactor`: drops a URL's query string and fragment and replaces `:token` segments of route templates.
- `pii-allowlist/otel`: `AllowlistSpanExporter`, `allowlistSpan`, `safeSpanName` and `DEFAULT_SPAN_ATTRIBUTES`.
- `pii-allowlist/pino`: `createLogFormatter`, `createMessageSerializer`, `createRequestSerializer`, `responseSerializer` and `DEFAULT_LOG_KEYS`.
- `pii-allowlist/sentry`: `createBeforeSend`, `createBeforeBreadcrumb` and `DEFAULT_SENTRY_KEYS`.

[0.1.0]: https://github.com/arenuzzz/pii-allowlist/releases/tag/v0.1.0
