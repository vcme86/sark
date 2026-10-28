import type { StaticAssets } from '../http/assets'

/** Public page resources supplied by the resolved development or production build. */
export interface PageAssets extends StaticAssets {
  readonly entry?: string
  readonly styles: Readonly<Record<string, readonly string[]>>
}
