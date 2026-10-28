/**
 * Bootstrap script component emitting page context payload for hydration.
 *
 * @module
 */

import { useOptionalPageContext } from '../context'

/** Emits the __PAGE_CONTEXT__ JSON script element containing the initial page bootstrap state. */
export function Scripts() {
  const json = useOptionalPageContext()?.bootstrapJson

  if (!json) {
    return null
  }

  return (
    <script
      id="__PAGE_CONTEXT__"
      type="application/json"
      dangerouslySetInnerHTML={{ __html: json }}
    />
  )
}
