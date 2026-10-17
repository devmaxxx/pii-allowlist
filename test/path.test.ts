import { describe, expect, it } from 'vitest'
import { createPathRedactor } from '../src'

const redactPath = createPathRedactor({
  tokens: ['/guest-form/:token', '/manage-booking/:token', '/team/accept/:token', '/ical/*/:token.ics'],
})

describe('createPathRedactor', () => {
  it('always drops the query string, which may carry tokens or personal data', () => {
    expect(redactPath('/api/properties?secret=leak&page=2')).toBe('/api/properties')
    expect(redactPath('https://x.tld/p?token=secret&q=1')).toBe('https://x.tld/p')
  })

  it('drops the fragment too', () => {
    expect(redactPath('/callback#access_token=secret')).toBe('/callback')
  })

  it('redacts a token segment wherever the template appears in the URL', () => {
    expect(redactPath('/api/guest-form/abc123secret')).toBe('/api/guest-form/[token]')
    expect(redactPath('https://x.tld/guest-form/SECRET')).toBe('https://x.tld/guest-form/[token]')
    expect(redactPath('/es/manage-booking/SECRET')).toBe('/es/manage-booking/[token]')
    expect(redactPath('/api/team/accept/inv-tok-xyz')).toBe('/api/team/accept/[token]')
  })

  it('keeps the segments after the token', () => {
    expect(redactPath('/api/manage-booking/deadbeef/cancel')).toBe('/api/manage-booking/[token]/cancel')
  })

  it('keeps a wildcard segment and a literal suffix around the token', () => {
    expect(redactPath('/ical/prop-42/feedsecret.ics')).toBe('/ical/prop-42/[token].ics')
  })

  it('redacts the token before a query string is dropped behind it', () => {
    expect(redactPath('/api/guest-form/tok?x=1')).toBe('/api/guest-form/[token]')
  })

  it('redacts every occurrence', () => {
    expect(redactPath('from /guest-form/A to /guest-form/B')).toBe('from /guest-form/[token] to /guest-form/[token]')
  })

  it('passes a path that matches no template through unchanged', () => {
    expect(redactPath('/api/reservations/123')).toBe('/api/reservations/123')
    expect(redactPath('/api/team/invitations/abc/link')).toBe('/api/team/invitations/abc/link')
  })

  it('does not match a template inside a longer segment name', () => {
    expect(redactPath('/my-guest-form/abc')).toBe('/my-guest-form/abc')
  })

  it('uses a custom placeholder', () => {
    expect(createPathRedactor({ tokens: ['/reset/:token'], placeholder: ':token' })('/reset/abc')).toBe('/reset/:token')
  })

  it('refuses a template without a token segment', () => {
    expect(() => createPathRedactor({ tokens: ['/reset'] })).toThrow(/no :token segment/)
  })
})
