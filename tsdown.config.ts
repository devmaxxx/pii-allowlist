import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'otel': 'src/adapters/otel.ts',
    'otel-logs': 'src/adapters/otel-logs.ts',
    'pino': 'src/adapters/pino.ts',
    'sentry': 'src/adapters/sentry.ts',
  },
  platform: 'neutral',
  dts: true,
  exports: true,
  publint: true,
})
