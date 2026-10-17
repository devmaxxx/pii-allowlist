// What Sentry would receive for one event, one streamed span and one log, before and after the hooks.
// The hooks are typed structurally, so this runs without a Sentry SDK or a DSN.
import { createAllowlist, createPathRedactor } from 'pii-allowlist'
import { createBeforeSend, createBeforeSendLog, createBeforeSendSpan, DEFAULT_SENTRY_KEYS } from 'pii-allowlist/sentry'

const redactPath = createPathRedactor({ tokens: ['/reset/:token'] })
const beforeSend = createBeforeSend({ redactPath, allowlist: createAllowlist({ keys: [...DEFAULT_SENTRY_KEYS, 'attempt'] }) })
const beforeSendSpan = createBeforeSendSpan({ redactPath })
const beforeSendLog = createBeforeSendLog()

const event = {
  message: 'password reset failed for jane@example.com',
  request: {
    method: 'POST',
    url: 'https://app.example/en/reset/s3cr3t?email=jane@example.com',
    headers: { cookie: 'session=abc' },
    data: { password: 'hunter2' },
  },
  user: { email: 'jane@example.com', ip_address: '203.0.113.7' },
  extra: { attempt: 3, phone: '+14155550123' },
}
const span = {
  name: `SELECT * FROM users WHERE email = 'jane@example.com' AND id = 42`,
  attributes: { 'sentry.op': 'db.query', 'db.system': 'postgresql', 'db.query.text': 'SELECT ...' },
}
const log = {
  level: 'info',
  message: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln accepted',
  attributes: { 'user.email': 'jane@example.com', 'sentry.release': '1.2.3' },
}

for (const [name, before, after] of [
  ['event', event, beforeSend(structuredClone(event))],
  ['span', span, beforeSendSpan(structuredClone(span))],
  ['log', log, beforeSendLog(structuredClone(log))],
] as const) {
  console.log(`--- ${name}, before`)
  console.log(JSON.stringify(before, null, 2))
  console.log(`--- ${name}, after`)
  console.log(JSON.stringify(after, null, 2))
}
