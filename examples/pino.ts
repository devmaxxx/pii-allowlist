// The same log calls through a plain pino logger and an allowlisted one.
import { createAllowlist } from 'pii-allowlist'
import { allowlistChildBindings, createLogFormatter, createMessageSerializer, DEFAULT_LOG_KEYS } from 'pii-allowlist/pino'
import pino from 'pino'

// Synchronous, unstamped output keeps the lines short; headers go through the same stream so they stay in order.
const options = { base: undefined, timestamp: false }
const stdout = pino.destination({ sync: true })

const plain = pino(options, stdout)
const allowlisted = allowlistChildBindings(pino({
  ...options,
  formatters: { log: createLogFormatter({ allowlist: createAllowlist({ keys: [...DEFAULT_LOG_KEYS, 'orderId'] }) }) },
  serializers: { msg: createMessageSerializer() },
}, stdout))

for (const [label, logger] of [['before', plain], ['after ', allowlisted]] as const) {
  stdout.write(`--- ${label}\n`)
  logger.info({ orderId: 'o_1', email: 'jane@example.com', taxId: 'DE123456789' }, 'order placed for jane@example.com')
  logger.child({ reqId: 'r_1', customer: { name: 'Jane Roe' } }).warn('card 4111 1111 1111 1111 declined')
}
