/**
 * Internal page server rendering runtime used by generated application code.
 *
 * @module
 */

export {
  renderPageToResponse,
  type ServerRenderOptions,
  type ServerRenderScope,
} from '../../web/page/server/render'
export { resolveClientAssets, type ClientAssetManifest } from '../../web/page/server/manifest'
export { mergeMetaDescriptors } from '../../web/page/meta'
export { matchClientRoute, matchPattern } from '../../web/page/match'
export { type ClientRoute, type ClientScope } from '../../web/page/browser/router'
export { type ServerPageRoute, type ServerPageScope } from '../../web/page/types'
export { resolvePageConfig } from '../../web/page/config'
export { createPageClient, getResolvedPageConfig } from '../../web/page/server/client'
export { createPageHandler, createPage404Handler } from '../../web/page/server/handler'
export { createClient } from '../../web/http/client/client'
export { notFound, NotFoundSignal, redirect, RedirectSignal } from '../../web/page/signals'
