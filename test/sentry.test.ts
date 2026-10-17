import type { Breadcrumb, ErrorEvent, Options } from '@sentry/core'
import { describe, expect, it } from 'vitest'
import { createAllowlist, createPathRedactor, REDACTED } from '../src'
import { createBeforeBreadcrumb, createBeforeSend } from '../src/adapters/sentry'

const redactPath = createPathRedactor({
  tokens: ['/guest-form/:token', '/manage-booking/:token', '/team/accept/:token', '/ical/*/:token.ics'],
})
const beforeSend = createBeforeSend({ redactPath })
const beforeBreadcrumb = createBeforeBreadcrumb({ redactPath })

function errorEvent(fields: Omit<ErrorEvent, 'type'>): ErrorEvent {
  return { type: undefined, ...fields }
}

describe('createBeforeSend: the request', () => {
  it('strips the query string from request.url', () => {
    const out = beforeSend({ request: { url: 'https://x.tld/p?token=secret&q=1' } })
    expect(out.request?.url).toBe('https://x.tld/p')
  })

  it('redacts a path-embedded token in request.url, not just the query string', () => {
    const out = beforeSend({ request: { url: 'https://x.tld/guest-form/LIVE-TOKEN' } })
    expect(out.request?.url).toBe('https://x.tld/guest-form/[token]')
  })

  it('drops the request body, headers, cookies and query string, keeping the method', () => {
    const out = beforeSend(errorEvent({
      request: {
        url: 'https://x.tld/',
        method: 'POST',
        data: { pw: 'p' },
        headers: { a: 'b' },
        cookies: { c: 'd' },
        query_string: 'q=1',
      },
    }))
    expect(out.request).toEqual({ url: 'https://x.tld/', method: 'POST' })
  })

  it('path-redacts the transaction name', () => {
    expect(beforeSend({ transaction: 'GET /manage-booking/T1?x=1' }).transaction).toBe('GET /manage-booking/[token]')
  })
})

describe('createBeforeSend: the rest of the event', () => {
  it('removes the user', () => {
    const out = beforeSend({ user: { id: '1', email: 'a@b.co', ip_address: '1.2.3.4' } })
    expect(out.user).toBeUndefined()
  })

  it('redacts an extra key that is not on the allowlist', () => {
    const out = createBeforeSend()({ extra: { email: 'a@b.co', method: 'GET' } })
    expect(out.extra).toEqual({ email: REDACTED, method: 'GET' })
  })

  it('keeps the extra keys a custom allowlist names', () => {
    const out = createBeforeSend({ allowlist: createAllowlist({ keys: ['jobId'] }) })({
      extra: { jobId: 'j_1', payload: { email: 'a@b.co' } },
    })
    expect(out.extra).toEqual({ jobId: 'j_1', payload: REDACTED })
  })

  it('scrubs e-mail addresses and phone numbers out of the message and exception values', () => {
    const out = beforeSend(errorEvent({
      message: 'no user a@b.co',
      exception: { values: [{ type: 'Error', value: 'phone +15550100200 is taken' }] },
    }))
    expect(out.message).toBe(`no user ${REDACTED}`)
    expect(out.exception?.values?.[0]).toEqual({ type: 'Error', value: `phone ${REDACTED} is taken` })
  })

  it('redacts the token in a fetch breadcrumb url and drops console breadcrumb content', () => {
    const out = beforeSend(errorEvent({
      message: 'boom',
      breadcrumbs: [
        { category: 'fetch', data: { url: '/api/guest-form/LIVE-TOKEN?x=1', method: 'POST', status_code: 500 } },
        { category: 'navigation', data: { from: '/manage-booking/T1', to: '/manage-booking/T2' } },
        { category: 'console', level: 'log', message: 'guest email a@b.co phone +123' },
      ],
    }))
    const crumbs = out.breadcrumbs ?? []
    expect(crumbs).toHaveLength(3)
    expect(crumbs[0]?.data).toEqual({ url: '/api/guest-form/[token]', method: 'POST', status_code: 500 })
    expect(crumbs[1]?.data).toEqual({ from: '/manage-booking/[token]', to: '/manage-booking/[token]' })
    expect(crumbs[2]?.message).toBeUndefined()
    expect(crumbs[2]?.data).toBeUndefined()
  })

  it('passes an event with no request, user or breadcrumbs through', () => {
    expect(beforeSend({ message: 'boom' })).toEqual({ message: 'boom' })
  })

  it('does not mutate the event it is handed', () => {
    const event = { user: { id: '1' }, request: { url: '/p?q=1' } }
    beforeSend(event)
    expect(event).toEqual({ user: { id: '1' }, request: { url: '/p?q=1' } })
  })
})

describe('createBeforeBreadcrumb', () => {
  it('applies the path redactor to url, from and to', () => {
    const out = beforeBreadcrumb({ category: 'xhr', data: { url: '/api/manage-booking/SECRET/cancel' } })
    expect(out.data?.url).toBe('/api/manage-booking/[token]/cancel')
  })

  it('redacts a data key that is not on the allowlist', () => {
    const out = beforeBreadcrumb({ category: 'fetch', data: { url: '/p', body: { email: 'a@b.co' } } })
    expect(out.data).toEqual({ url: '/p', body: REDACTED })
  })

  it('drops the message and data of a debug breadcrumb', () => {
    const out = beforeBreadcrumb({ type: 'debug', message: 'user a@b.co', data: { arguments: ['a@b.co'] } })
    expect(out.message).toBeUndefined()
    expect(out.data).toBeUndefined()
  })

  it('path-redacts a breadcrumb message', () => {
    expect(beforeBreadcrumb({ category: 'navigation', message: '/team/accept/inv-1?x=1' }).message).toBe(
      '/team/accept/[token]',
    )
  })
})

describe('the Sentry SDK types', () => {
  it('accept both helpers as init options', () => {
    const options: Pick<Options, 'beforeSend' | 'beforeBreadcrumb'> = {
      beforeSend: createBeforeSend(),
      beforeBreadcrumb: createBeforeBreadcrumb(),
    }
    const crumb: Breadcrumb = { category: 'fetch', data: { url: '/p?q=1' } }

    expect(options.beforeBreadcrumb?.(crumb)).toEqual({ category: 'fetch', data: { url: '/p' } })
  })
})
