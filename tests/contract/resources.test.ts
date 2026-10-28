import { expect, it } from 'vitest'

import { defineApp, resolveAppConfig } from '../../src/core/config'
import { getCurrentScope } from '../../src/core/context'
import { assembleApp, createApp } from '../../src/core/create'
import { createDefinition } from '../../src/core/definition'
import { parseApiFilePath } from '../../src/http/path'
import { route } from '../../src/http/server/route'

it('cancels initialization before disposing acquired resources in reverse order', async () => {
  const failure = new Error('Later resource initialization failed')
  const released: string[] = []
  let initializationSignal: AbortSignal | undefined
  const resource = (name: string) => ({
    async createStatic(_env: unknown, { signal }: { signal: AbortSignal }) {
      initializationSignal = signal
      return {
        value: name,
        dispose({ signal: disposalSignal }: { signal: AbortSignal }) {
          expect(disposalSignal).toBe(signal)
          expect(disposalSignal.aborted).toBe(true)
          expect(disposalSignal.reason).toBe(failure)
          released.push(name)
        },
      }
    },
  })

  await expect(
    createApp(
      createDefinition({
        resources: {
          first: resource('first'),
          second: resource('second'),
          failed: {
            async createStatic() {
              throw failure
            },
          },
        },
      }),
    ),
  ).rejects.toBe(failure)
  expect(initializationSignal?.aborted).toBe(true)
  expect(released).toEqual(['second', 'first'])
})

it('reuses event resources for internal calls and isolates simultaneous events and applications', async () => {
  let creations = 0
  let entered = 0
  const interleaved = Promise.withResolvers<void>()
  const resource = {
    target: 'cloudflare' as const,
    createForEvent(env: unknown) {
      creations++
      return { value: { label: (env as { label: string }).label } }
    },
  }
  let dispatchInternal: (request: Request) => Promise<Response>
  let currentResource: () => { label: string }
  let otherResource: () => unknown
  const definition = createDefinition({
    app: defineApp({ csrf: false }),
    resources: { selected: resource },
    routes: [
      {
        routePath: parseApiFilePath('inner.get.ts', '/api')!,
        declaration: route().handler(() => currentResource()),
      },
      {
        routePath: parseApiFilePath('outer.get.ts', '/api')!,
        declaration: route().handler(async (c) => {
          const selected = currentResource()
          if (++entered === 2) interleaved.resolve()
          await interleaved.promise
          const inner = await (
            await dispatchInternal(new Request('http://localhost/api/inner'))
          ).json()
          expect(currentResource()).toBe(selected)
          expect(c.get('selected' as never)).toBe(selected)
          expect(getCurrentScope()?.resources?.selected).toBe(selected)
          expect(otherResource).toThrow('active event context')
          return { label: selected.label, inner: inner.label }
        }),
      },
    ],
  })
  const config = resolveAppConfig(definition.app, undefined, false)
  const options = { kind: 'event' as const, resolve: () => config, errorConfig: config }
  const app = await assembleApp(definition, options)
  const other = await assembleApp(definition, options)
  currentResource = () => app.selected
  otherResource = () => other.selected
  dispatchInternal = (request) => app.fetchInternal(request)
  try {
    const responses = await Promise.all(
      ['first', 'second'].map((label) =>
        app.fetch(new Request('http://localhost/api/outer'), { label }),
      ),
    )
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { label: 'first', inner: 'first' },
      { label: 'second', inner: 'second' },
    ])
    expect(creations).toBe(2)
    expect(currentResource).toThrow('active event context')
  } finally {
    await Promise.all([app.close(), other.close()])
  }
})
