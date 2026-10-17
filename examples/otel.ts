// One span recorded twice: as the rest of the pipeline holds it, and as AllowlistSpanExporter forwards it.
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { AllowlistSpanExporter } from 'pii-allowlist/otel'

const raw = new InMemorySpanExporter()
const exported = new InMemorySpanExporter()
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(raw), new SimpleSpanProcessor(new AllowlistSpanExporter(exported))],
})

provider.getTracer('example').startSpan('GET /v1/users?email=jane@example.com', {
  attributes: {
    'http.request.method': 'GET',
    'http.route': '/v1/users',
    'http.response.status_code': 200,
    'url.full': 'https://api.example/v1/users?email=jane@example.com&token=s3cr3t',
    'db.query.text': `SELECT * FROM users WHERE phone = '+14155550123'`,
    'client.address': '203.0.113.7',
  },
}).end()

for (const [label, memory] of [['before', raw], ['after ', exported]] as const) {
  const [span] = memory.getFinishedSpans()
  console.log(`--- ${label}`)
  console.log(JSON.stringify({ name: span?.name, attributes: span?.attributes }, null, 2))
}
