import type { Breadcrumb, ErrorEvent, Options } from '@sentry/core'
import { describe, expect, it } from 'vitest'
import { createAllowlist, createPathRedactor, REDACTED } from '../src'
import { createBeforeBreadcrumb, createBeforeSend, createBeforeSendLog, createBeforeSendSpan } from '../src/adapters/sentry'

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

describe('createBeforeSend: extra urls', () => {
  it('drops the query string of an allowlisted url in extra', () => {
    const event = createBeforeSend()({ extra: { url: 'https://app.example/cb?code=SECRET' } })

    expect(event.extra).toEqual({ url: 'https://app.example/cb' })
  })
})

describe('createBeforeBreadcrumb: a message that is not a URL', () => {
  it('keeps a ui.click selector whole', () => {
    const out = beforeBreadcrumb({ category: 'ui.click', message: 'body > div#root > button.submit' })

    expect(out.message).toBe('body > div#root > button.submit')
  })

  it('keeps a question in prose and still scrubs e-mail addresses out of it', () => {
    expect(beforeBreadcrumb({ category: 'app', message: 'Why? failed for a@b.co' }).message).toBe(
      `Why? failed for ${REDACTED}`,
    )
  })

  it('path-redacts an absolute URL message', () => {
    expect(beforeBreadcrumb({ category: 'app', message: 'https://x.tld/guest-form/T1?email=a@b.co' }).message).toBe(
      'https://x.tld/guest-form/[token]',
    )
  })

  it('path-redacts a URL inside prose', () => {
    expect(beforeBreadcrumb({ category: 'app', message: 'GET /guest-form/T1?code=s3cr3t failed' }).message).toBe(
      'GET /guest-form/[token] failed',
    )
  })
})

describe('createBeforeSend: logentry and stack frame locals', () => {
  it('scrubs the logentry message and redacts its params', () => {
    const out = beforeSend(errorEvent({
      logentry: { message: 'no user a@b.co: %s %o %d', params: ['+15550100200', { email: 'a@b.co', method: 'GET' }, 3] },
    }))

    expect(out.logentry).toEqual({
      message: `no user ${REDACTED}: %s %o %d`,
      params: [REDACTED, { email: REDACTED, method: 'GET' }, 3],
    })
  })

  it('redacts exception frame locals that are not on the allowlist', () => {
    const out = beforeSend(errorEvent({
      exception: {
        values: [{
          type: 'Error',
          value: 'boom',
          stacktrace: { frames: [{ function: 'f', vars: { email: 'a@b.co', method: 'GET', url: '/p?code=SECRET' } }, { function: 'g' }] },
        }],
      },
    }))

    expect(out.exception?.values?.[0]?.stacktrace?.frames).toEqual([
      { function: 'f', vars: { email: REDACTED, method: 'GET', url: '/p' } },
      { function: 'g' },
    ])
  })

  it('redacts thread frame locals likewise', () => {
    const out = beforeSend(errorEvent({
      threads: { values: [{ id: 1, stacktrace: { frames: [{ vars: { password: 'hunter2' } }] } }, { id: 2 }] },
    }))

    expect(out.threads).toEqual({
      values: [{ id: 1, stacktrace: { frames: [{ vars: { password: REDACTED } }] } }, { id: 2 }],
    })
  })

  it('survives an extra value whose getter throws', () => {
    const extra = Object.defineProperty({}, 'method', {
      enumerable: true,
      get: () => {
        throw new Error('nope')
      },
    })

    expect(createBeforeSend()({ extra }).extra).toEqual({ method: REDACTED })
  })
})

const EMAIL = 'jane.roe@example.com'

describe('createBeforeSend: e-mail addresses in URLs', () => {
  it('scrubs an address from the path of request.url and the transaction name', () => {
    const out = beforeSend({ request: { url: `https://x.tld/users/${EMAIL}/edit` }, transaction: `GET /users/${EMAIL}` })
    expect(out.request?.url).toBe(`https://x.tld/users/${REDACTED}/edit`)
    expect(out.transaction).toBe(`GET /users/${REDACTED}`)
  })
})

describe('createBeforeSend as beforeSendTransaction', () => {
  it('scrubs the spans of a transaction and its trace context data', () => {
    const out = beforeSend({
      transaction: 'GET /orders/:id',
      contexts: { trace: { data: { 'http.route': '/orders/:id', 'url.full': `https://x.tld/orders/1?email=${EMAIL}` } } },
      spans: [
        { op: 'http.client', description: `GET https://api.tld/v1/users?email=${EMAIL}`, data: { 'url.full': `https://api.tld/v1/users?email=${EMAIL}`, 'http.request.method': 'GET' } },
        { op: 'db', description: `SELECT * FROM users WHERE email = '${EMAIL}' AND age > 30`, data: { 'db.system': 'postgresql', 'db.statement': `SELECT '${EMAIL}'` } },
      ],
    })

    expect(out.contexts?.trace?.data).toEqual({ 'http.route': '/orders/:id' })
    expect(out.spans).toEqual([
      { op: 'http.client', description: 'GET https://api.tld/v1/users', data: { 'http.request.method': 'GET' } },
      { op: 'db', description: 'SELECT * FROM users WHERE email = ? AND age > ?', data: { 'db.system': 'postgresql' } },
    ])
  })
})

describe('createBeforeSendSpan', () => {
  const beforeSendSpan = createBeforeSendSpan({ redactPath })

  it('drops non-allowlisted attributes of a streamed span and names a routed server span by its route', () => {
    const out = beforeSendSpan({
      name: `GET /guest-form/LIVE-TOKEN?email=${EMAIL}`,
      attributes: {
        'http.request.method': 'GET',
        'http.route': '/guest-form/:token',
        'url.full': `https://x.tld/guest-form/LIVE-TOKEN?email=${EMAIL}`,
        'user.email': EMAIL,
        'sentry.op': 'http.server',
        'sentry.segment.name': `GET /guest-form/LIVE-TOKEN?email=${EMAIL}`,
      },
      links: [{ attributes: { email: EMAIL } }],
    })

    expect(out).toEqual({
      name: 'GET /guest-form/:token',
      attributes: {
        'http.request.method': 'GET',
        'http.route': '/guest-form/:token',
        'sentry.op': 'http.server',
        'sentry.segment.name': 'GET /guest-form/[token]',
      },
      links: [{}],
    })
  })

  it('unwraps an attribute given as { value, unit } and scrubs its text', () => {
    const out = beforeSendSpan({ name: 'job', attributes: { 'messaging.destination.name': { value: `queue of ${EMAIL}`, unit: 'none' } } })
    expect(out.attributes).toEqual({ 'messaging.destination.name': { value: `queue of ${REDACTED}`, unit: 'none' } })
  })

  it('cuts literals from a database span named after its statement, keeping placeholders', () => {
    const out = beforeSendSpan({
      name: `UPDATE users SET phone = '+15550100200' WHERE id = 42 AND name = 'O''Brien' AND t = $1`,
      attributes: { 'db.system.name': 'postgresql' },
    })
    expect(out.name).toBe('UPDATE users SET phone = ? WHERE id = ? AND name = ? AND t = $1')
  })

  it.each([
    [`SELECT * FROM t WHERE n = 'it\\'s Jane Roe' AND id = 7`, 'SELECT * FROM t WHERE n = ?'],
    [`SELECT * FROM t WHERE p = 'C:\\' AND n = 'Jane Roe'`, 'SELECT * FROM t WHERE p = ?'],
    [`INSERT INTO t VALUES (1, 'Jane Ro`, 'INSERT INTO t VALUES (?, ?'],
  ])('cuts from the first quote when a literal cannot be paired safely: %s', (name, expected) => {
    expect(beforeSendSpan({ name, op: 'db' }).name).toBe(expected)
  })

  it('keeps an identifier that ends in a digit', () => {
    const out = beforeSendSpan({ name: 'SELECT col1 FROM table2', op: 'db.query', data: {} })
    expect(out.name).toBe('SELECT col1 FROM table2')
  })
})

describe('createBeforeSendLog', () => {
  const beforeSendLog = createBeforeSendLog({ allowlist: createAllowlist({ keys: ['orderId'] }) })

  it('scrubs the message and redacts attributes not on the list, user fields included', () => {
    const out = beforeSendLog({
      level: 'info',
      message: `order placed for ${EMAIL}`,
      attributes: { 'orderId': 'o_1', 'note': 'leave at door', 'user.email': EMAIL, 'user.id': 'u_1' },
    })
    expect(out).toEqual({
      level: 'info',
      message: `order placed for ${REDACTED}`,
      attributes: { 'orderId': 'o_1', 'note': REDACTED, 'user.email': REDACTED, 'user.id': REDACTED },
    })
  })

  it('keeps the SDK metadata and walks message parameters as unnamed values', () => {
    const out = beforeSendLog({
      message: `order o_1 for ${EMAIL}`,
      attributes: {
        'sentry.environment': 'production',
        'sentry.message.template': 'order %s for %s',
        'sentry.message.parameter.0': 'o_1',
        'sentry.message.parameter.1': EMAIL,
        'sentry.message.parameter.2': { email: EMAIL, orderId: 'o_1' },
      },
    })
    expect(out.attributes).toEqual({
      'sentry.environment': 'production',
      'sentry.message.template': 'order %s for %s',
      'sentry.message.parameter.0': 'o_1',
      'sentry.message.parameter.1': REDACTED,
      'sentry.message.parameter.2': { email: REDACTED, orderId: 'o_1' },
    })
  })

  it('turns a parameterized String object message into a scrubbed string', () => {
    const message = Object.assign(new Object(`hi ${EMAIL}`), { __sentry_template_string__: 'hi %s' })
    expect(beforeSendLog({ message }).message).toBe(`hi ${REDACTED}`)
  })
})

describe('review regressions', () => {
  it('path-redacts a url attribute of a Sentry log', () => {
    const log = createBeforeSendLog()({ message: 'hi', attributes: { url: 'https://a.example/x?token=abc' } })
    expect(log.attributes?.url).toBe('https://a.example/x')
  })

  it('drops tags that are not on the span allowlist from a transaction span', () => {
    const event = createBeforeSend()({ spans: [{ description: 'GET /a', tags: { 'email': 'x@y.zz', 'http.method': 'GET' } }] })
    expect(event.spans?.[0]?.tags).toEqual({ 'http.method': 'GET' })
  })

  it('does not throw on a prototype-less log message', () => {
    expect(() => createBeforeSendLog()({ message: Object.create(null) })).not.toThrow()
  })
})
