import { afterEach, expect, it, vi } from 'vitest'

import { resolveOAuthProviders } from '../../src/services/auth/oauth/config'
import { fetchGitHubProfile } from '../../src/services/auth/oauth/providers/github'
import { exchangeWeChatCode } from '../../src/services/auth/oauth/providers/wechat'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function provider(kind: 'github' | 'wechat') {
  return resolveOAuthProviders(
    [
      {
        id: kind,
        kind,
        clientId: 'client',
        clientSecret: 'secret',
        scopes: kind === 'wechat' ? ['snsapi_base'] : ['read:user'],
        redirectUri: 'https://example.test/callback',
        onSuccess() {},
      },
    ],
    {},
    '/api',
  )[0]
}

it.each(['github', 'wechat'] as const)('times out a pending native %s request', async (kind) => {
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        }),
    ),
  )
  const pending =
    kind === 'github'
      ? fetchGitHubProfile(provider(kind), 'token')
      : exchangeWeChatCode(
          provider(kind),
          new Request('https://example.test/callback?code=code&state=state'),
          'state',
        )
  const reason = new DOMException('Provider timed out', 'TimeoutError')
  deadline.abort(reason)
  await expect(pending).rejects.toBe(reason)
  expect(timeout).toHaveBeenCalledWith(30_000)
})

it.each(['timeout', 'request cancellation'] as const)(
  'treats optional GitHub email %s according to its owning request',
  async (failure) => {
    const request = new AbortController()
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(new AbortController().signal)
      .mockReturnValueOnce(deadline.signal)
    const entered = Promise.withResolvers<void>()
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init: RequestInit) => {
        if (String(url).endsWith('/user'))
          return Promise.resolve(Response.json({ id: 42, login: 'reader' }))
        entered.resolve()
        return new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        })
      }),
    )
    const pending = fetchGitHubProfile(provider('github'), 'token', request.signal)
    await entered.promise
    const reason = new DOMException(
      'Stopped',
      failure === 'timeout' ? 'TimeoutError' : 'AbortError',
    )
    if (failure === 'timeout') {
      deadline.abort(reason)
      await expect(pending).resolves.toMatchObject({ subject: '42', email: undefined })
    } else {
      request.abort(reason)
      await expect(pending).rejects.toBe(reason)
    }
  },
)

it.each([
  { errcode: 40029, rejected: true },
  { errcode: 40163, rejected: true },
  { errcode: 42003, rejected: true },
  { errcode: 40125, rejected: false },
  { errcode: -1, rejected: false },
])(
  'classifies WeChat error $errcode without hiding provider faults',
  async ({ errcode, rejected }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ errcode })),
    )
    const { isAuthorizationFailure } = await import('../../src/services/auth/oauth/error')
    await expect(
      exchangeWeChatCode(
        provider('wechat'),
        new Request('https://example.test/callback?code=code&state=state'),
        'state',
      ),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && isAuthorizationFailure(error) === rejected,
    )
  },
)
