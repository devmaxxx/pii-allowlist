/**
 * A text pattern whose matches need a second look a regular expression cannot give, such as a
 * checksum: only matches `accept` returns `true` for are replaced.
 */
export interface TextMatcher {
  pattern: RegExp
  accept: (match: string) => boolean
}

/** What `textPatterns` takes: a plain pattern, every match of which is replaced, or a matcher. */
export type TextPattern = RegExp | TextMatcher

/**
 * The text shapes this package knows, to pick from when building `textPatterns`. Each is
 * replaced by the placeholder wherever it appears inside a string.
 */
export const TEXT_PATTERNS = {
  /** An e-mail address, Unicode local parts and domains included. */
  email: /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}.-]{1,253}\.\p{L}{2,}/gu,
  /**
   * An international phone number: `+` and 8 to 15 digits, which may be grouped by spaces, dots,
   * dashes or parentheses, as people write them: `+1 (415) 555-0123`, `+44 20 7946 0958`.
   */
  phone: /\+\d(?:[ .()-]{0,2}\d){7,14}\b/g,
  /**
   * A payment card number: 13 to 19 digits, optionally grouped by spaces or dashes, that passes
   * the Luhn check. One in ten random digit strings of that length passes it too, so a long
   * numeric ID inside a string is sometimes redacted. The run is matched shortest first: a
   * greedy one would swallow a number written after the card (`4111 1111 1111 1111 25`), fail the
   * check as a whole and leave the card in clear.
   */
  card: { pattern: /(?<![\w.-])\d(?:[ -]?\d){12,18}?(?![\w-])/g, accept: passesLuhn } satisfies TextMatcher,
  /** A JSON Web Token: a header and a payload segment, both starting like a base64url JSON object, and a signature. */
  jwt: /\beyJ[\w-]{2,}\.eyJ[\w-]{2,}\.[\w-]*/g,
  /** The token after `Bearer`, as it appears in an `Authorization` header. */
  bearer: /(?<=\bBearer\s+)[\w~+/.=-]{8,}/gi,
  /**
   * The credentials after `Basic`. They are base64, so a word is taken only when its length is a
   * multiple of four and it has a capital, a digit, `+`, `/` or `=` past its first character:
   * `Basic dXNlcjpwYXNz` is cut, `Basic authentication failed` and `Basic Settings` are not.
   */
  basic: { pattern: /(?<=\bBasic\s+)[\w+/=]{8,}/gi, accept: looksLikeBase64Credential } satisfies TextMatcher,
  /** A dotted IPv4 address, not when it is part of a longer dotted version number. */
  ipv4: /(?<![\w.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?!\.?\w)/g,
  /** An IPv6 address, written in full or compressed with `::`. */
  ipv6: /(?<![\w:])(?:(?:[\da-f]{1,4}:){7}[\da-f]{1,4}|(?:[\da-f]{1,4}:){1,6}:(?:[\da-f]{1,4}(?::[\da-f]{1,4}){0,5})?|::(?:[\da-f]{1,4}:){0,6}[\da-f]{1,4})(?![\w:])/gi,
} as const

/**
 * Text shapes scrubbed from every string an allowlisted key carries by default: e-mail
 * addresses, phone numbers, payment card numbers, JSON Web Tokens and `Authorization`
 * credentials. A key on the list says its value is safe to log; these catch the message somebody
 * built by interpolating one into it anyway. IP addresses are left out, because version numbers
 * and timestamps look like them; add {@link TEXT_PATTERNS}`.ipv4` and `.ipv6` to scrub them too.
 */
export const DEFAULT_TEXT_PATTERNS: readonly TextPattern[] = [
  TEXT_PATTERNS.email,
  TEXT_PATTERNS.phone,
  TEXT_PATTERNS.card,
  TEXT_PATTERNS.jwt,
  TEXT_PATTERNS.bearer,
  TEXT_PATTERNS.basic,
]

function looksLikeBase64Credential(match: string): boolean {
  return match.length % 4 === 0 && /[A-Z\d+/=]/.test(match.slice(1))
}

function passesLuhn(match: string): boolean {
  const digits = match.replace(/\D/g, '')
  let sum = 0
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9)
        digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

export interface CompiledTextPattern {
  pattern: RegExp
  /** Absent for a plain pattern, whose every match is replaced. */
  accept?: TextMatcher['accept']
}

/** Scrubbing replaces every match, so each pattern runs with the `g` flag. */
export function compileTextPattern(pattern: TextPattern): CompiledTextPattern {
  const regex = pattern instanceof RegExp ? pattern : pattern.pattern
  const global = regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`)
  return pattern instanceof RegExp ? { pattern: global } : { pattern: global, accept: pattern.accept }
}
