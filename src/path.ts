export interface PathRedactorOptions {
  /**
   * Route templates whose `:token` segments are secrets, e.g. `'/reset/:token'`,
   * `'/invite/:token/accept'` or `'/calendar/:token.ics'`. A `*` segment matches any one segment
   * and keeps it. A template matches anywhere in the URL, so an origin, an `/api` prefix or a locale in
   * front of it does not hide the token.
   */
  tokens?: readonly string[]
  /** What a token segment becomes. Defaults to `'[token]'`. */
  placeholder?: string
}

/** Turns a URL into one safe to report. */
export type PathRedactor = (url: string) => string

/** A path segment ends at a slash, a query, a fragment, or whitespace when a URL sits in prose. */
const SEGMENT = '[^/?#\\s]+'

/**
 * Builds a function that drops a URL's query string and fragment — where search terms, e-mail
 * addresses and OAuth codes travel — and replaces every `:token` segment of the given templates.
 * A path that matches no template keeps its path and loses only its query and fragment.
 *
 * @example
 * const redactPath = createPathRedactor({ tokens: ['/reset/:token'] })
 * redactPath('https://app.example/en/reset/s3cr3t?email=a@b.co')
 * // => 'https://app.example/en/reset/[token]'
 */
export function createPathRedactor(options: PathRedactorOptions = {}): PathRedactor {
  const placeholder = options.placeholder ?? '[token]'
  const rules = (options.tokens ?? []).map(compileTemplate)

  return (url) => {
    let path = withoutQuery(url)
    for (const { pattern, literals } of rules) {
      path = path.replace(pattern, (_match, ...captures: string[]) =>
        captures.slice(0, literals).join(placeholder))
    }
    return path
  }
}

/** Also drops `user:password@` credentials from an absolute URL's authority. */
function withoutQuery(url: string): string {
  const end = url.search(/[?#]/)
  const bare = end === -1 ? url : url.slice(0, end)
  return bare.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@\s]*@/i, '$1')
}

/**
 * `'/calendar/:token.ics'` becomes `(\/calendar\/)[^/?#\s]+?(\.ics)(?=[/?#\s]|$)`: the literal parts
 * are captured so the replacement can put them back around the placeholder, and the lookahead
 * makes a token consume its whole segment.
 */
function compileTemplate(template: string): { pattern: RegExp, literals: number } {
  const literals = template.split(':token').map(part =>
    escapeRegExp(part).replaceAll('\\*', SEGMENT),
  )
  if (literals.length < 2)
    throw new Error(`pii-allowlist: path template "${template}" has no :token segment`)
  const body = literals.map(literal => `(${literal})`).join(`${SEGMENT}?`)
  return { pattern: new RegExp(`${body}(?=[/?#\\s]|$)`, 'g'), literals: literals.length }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}
