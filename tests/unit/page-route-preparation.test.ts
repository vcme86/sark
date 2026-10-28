import { describe, expect, it } from 'vitest'

describe('Page rendering and delivery', () => {
  it('dynamically loads route scopes and integrates with code-splitting', async () => {
    const { prepareClientRoute } = await import('../../src/page/browser/route')
    type ClientRouteType = import('../../src/entries/runtime/page-browser').ClientRoute

    let pageModuleLoaded = false
    let layoutModuleLoaded = false

    const route: ClientRouteType = {
      pattern: '/dynamic/:id',
      shapeKey: '/dynamic/:',
      paramNames: ['id'],
      scopes: [
        {
          id: 'layout:root',
          load: async () => {
            layoutModuleLoaded = true
            return {
              default: () => null,
              loader: async () => ({ layoutData: 'ok' }),
            }
          },
        },
        {
          id: 'page:dynamic',
          load: async () => {
            pageModuleLoaded = true
            return {
              default: () => null,
              loader: async () => ({ pageData: 42 }),
              meta: () => ({ title: 'Dynamic Page' }),
            }
          },
        },
      ],
    }

    expect(pageModuleLoaded).toBe(false)
    expect(layoutModuleLoaded).toBe(false)
    expect(route.scopes[0].component).toBeUndefined()

    await prepareClientRoute(route)

    expect(pageModuleLoaded).toBe(true)
    expect(layoutModuleLoaded).toBe(true)
    expect(route.scopes[0].component).toBeDefined()
    expect(route.scopes[1].component).toBeDefined()
    expect(route.scopes[1].meta).toBeDefined()
  })
})
