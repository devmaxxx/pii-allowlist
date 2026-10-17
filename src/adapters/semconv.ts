/**
 * Span attributes that name a template, a code, a system or a count — never a value somebody
 * typed. Both the stable and the older semantic-convention names are listed. `url.*`,
 * `http.target`, `http.url`, `db.statement`, `db.query.text`, `client.address`,
 * `user_agent.original` and every `*.header.*` are absent on purpose: they carry query strings,
 * SQL literals and addresses.
 */
export const DEFAULT_SPAN_ATTRIBUTES: readonly string[] = [
  'http.request.method',
  'http.method',
  'http.route',
  'http.response.status_code',
  'http.status_code',
  'network.protocol.version',
  'server.address',
  'server.port',
  'db.system',
  'db.system.name',
  'db.operation',
  'db.operation.name',
  'db.name',
  'db.namespace',
  'messaging.system',
  'messaging.destination.name',
  'messaging.operation',
  'messaging.operation.name',
  'messaging.operation.type',
  'error.type',
]
