import { describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/web/http/client/client'
import { type NavigationHost, PageController } from '../../src/web/page/browser/controller'
import type { ClientRoute } from '../../src/web/page/browser/route'
import { notFound, redirect } from '../../src/web/page/signals'

function setup(routes: ClientRoute[], data: unknown = 'old') {
  const host: NavigationHost = {
    commit: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    hardNavigate: vi.fn(),
    report: vi.fn(),
  }
  const controller = new PageController(
    routes,
    createClient(),
    host,
    {},
    {
      url: 'https://example.test/posts/1',
      params: { id: '1' },
      identity: { user: null },
      scopes: { post: { status: 'success', data } },
    },
    { caseSensitive: true, trailingSlash: 'never' },
  )
  return { controller, host }
}

function route(loader: ClientRoute['scopes'][number]['loader']): ClientRoute {
  return {
    pattern: '/posts/:id',
    shapeKey: '/posts/:',
    paramNames: ['id'],
    scopes: [{ id: 'post', component: () => null, loader }],
  }
}

describe('page operation ownership', () => {
  it('commits only the latest loader result, metadata and history', async () => {
    const slow = Promise.withResolvers<string>()
    const { controller, host } = setup([
      route(({ params }) => (params.id === '2' ? slow.promise : 'third')),
    ])
    const previous = controller.navigate('/posts/2')
    await Promise.resolve()
    await controller.navigate('/posts/3')
    slow.resolve('second')
    expect(await previous).toEqual({ committed: false })
    expect(controller.getSnapshot().view.url.pathname).toBe('/posts/3')
    expect(controller.getSnapshot().view.scopes.post).toEqual({ status: 'success', data: 'third' })
    expect(host.commit).toHaveBeenCalledTimes(1)
  })

  it('keeps a new loading state when an old async blocker completes', async () => {
    const guard = Promise.withResolvers<boolean>()
    const loader = Promise.withResolvers<string>()
    const { controller } = setup([route(() => loader.promise)])
    controller.registerBlocker('guard', () => guard.promise)
    const first = controller.navigate('/posts/2')
    controller.unregisterBlocker('guard')
    const second = controller.navigate('/posts/3')
    guard.resolve(false)
    expect(await first).toEqual({ committed: false })
    expect(controller.getSnapshot().navigation.state).toBe('loading')
    loader.resolve('new')
    expect(await second).toEqual({ committed: true })
  })

  it('honors application reuse across params and forces explicit reload', async () => {
    const loader = vi.fn(() => 'fresh')
    const page = route(loader)
    page.scopes[0].shouldRevalidate = () => false
    const { controller } = setup([page])
    expect(await controller.navigate('/posts/2')).toEqual({ committed: true })
    expect(loader).not.toHaveBeenCalled()
    expect(controller.getSnapshot().view.params).toEqual({ id: '2' })
    expect(controller.getSnapshot().view.scopes.post).toEqual({ status: 'success', data: 'old' })
    await controller.reload()
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('clears old data on a successful undefined and retries only the failed scope', async () => {
    const outer = vi.fn(() => 'layout')
    const failed = vi
      .fn()
      .mockImplementationOnce(() => notFound())
      .mockResolvedValue(undefined)
    const base = route(failed)
    const page = {
      ...base,
      scopes: [{ id: 'layout', component: () => null, loader: outer }, ...base.scopes],
    }
    const { controller } = setup([page])
    await controller.navigate('/posts/2')
    expect(controller.getSnapshot().view.scopes.post.status).toBe('error')
    await controller.retryScope('post')
    expect(outer).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().view.scopes.post).toEqual({
      status: 'success',
      data: undefined,
    })
  })

  it('invalidates old identity reads without automatically reloading', async () => {
    const pending = Promise.withResolvers<string>()
    const loader = vi.fn(() => pending.promise)
    const { controller, host } = setup([route(loader)])
    const navigation = controller.navigate('/posts/2')
    await Promise.resolve()
    controller.setIdentity({ user: { sub: 'new-user' } })
    pending.resolve('old-user-data')
    expect(await navigation).toEqual({ committed: false })
    expect(controller.getSnapshot().view.identity.user?.sub).toBe('new-user')
    expect(controller.getSnapshot().view.url.pathname).toBe('/posts/1')
    expect(host.commit).not.toHaveBeenCalled()
  })

  it('keeps successful Action data separate from failed revalidation', async () => {
    const { controller } = setup([route(() => notFound('gone'))])
    const success = vi.fn()
    const outcome = await controller.submitAction(
      async () => ({ saved: true }),
      new FormData(),
      success,
      new AbortController().signal,
    )
    expect(success).toHaveBeenCalledWith({ saved: true })
    expect(outcome.error).toBeUndefined()
    expect(outcome.revalidateError).toEqual({ status: 404, message: 'gone' })
    expect(controller.getSnapshot().navigation.state).toBe('idle')
  })

  it('prevents stale Action completion from ending a newer navigation', async () => {
    const write = Promise.withResolvers<string>()
    const read = Promise.withResolvers<string>()
    const { controller } = setup([route(() => read.promise)])
    const success = vi.fn()
    const action = controller.submitAction(
      () => write.promise,
      new FormData(),
      success,
      new AbortController().signal,
    )
    const navigation = controller.navigate('/posts/2')
    write.resolve('saved')
    await action
    expect(success).not.toHaveBeenCalled()
    expect(controller.getSnapshot().navigation.state).toBe('loading')
    read.resolve('next')
    await navigation
  })

  it('returns the final redirect commit and preserves ordinary API errors', async () => {
    const { controller } = setup([
      route(({ params }) => (params.id === '2' ? redirect('/posts/3') : 'redirected')),
    ])
    expect(await controller.navigate('/posts/2')).toEqual({ committed: true })
    expect(controller.getSnapshot().view.url.pathname).toBe('/posts/3')
  })

  it('recovers a metadata-only failed scope without running unrelated loaders', async () => {
    const page = route(undefined)
    const metadata = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('Metadata unavailable')
      })
      .mockReturnValue({ title: 'Recovered' })
    const { controller } = setup([page])
    page.scopes[0].meta = metadata
    await controller.navigate('/posts/2')
    expect(controller.getSnapshot().view.scopes.post.status).toBe('error')
    await controller.retryScope('post')
    expect(controller.getSnapshot().view.scopes.post.status).toBe('success')
    expect(controller.getSnapshot().view.meta.title).toBe('Recovered')
  })

  it('uses native navigation for a foreign origin even if its path matches', async () => {
    const { controller, host } = setup([route(() => 'unused')])
    expect(await controller.navigate('https://other.test/posts/2')).toEqual({ committed: false })
    expect(host.commit).not.toHaveBeenCalled()
    expect(host.hardNavigate).toHaveBeenCalledWith(new URL('https://other.test/posts/2'))
  })

  it('restores a rejected native traversal without changing the committed view', async () => {
    const { controller, host } = setup([route(() => 'unused')])
    controller.registerBlocker('deny', () => false)
    const target = { index: -3, scroll: [0, 400] as const }
    expect(await controller.navigate('/posts/2', {}, target)).toEqual({ committed: false })
    expect(host.restore).toHaveBeenCalledWith(target)
    expect(host.commit).not.toHaveBeenCalled()
    expect(controller.getSnapshot().navigation.state).toBe('idle')
  })
})
