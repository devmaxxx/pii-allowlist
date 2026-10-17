// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
  },
  {
    // Suites are named after the export they cover, which keeps its own casing.
    rules: { 'test/prefer-lowercase-title': 'off' },
  },
  {
    // Examples print what they redact; printing is their whole job.
    files: ['examples/**'],
    rules: { 'no-console': 'off' },
  },
)
