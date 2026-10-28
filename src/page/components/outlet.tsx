/**
 * Renders nested child routes within layouts.
 *
 * @module
 */

import { useContext } from 'react'

import { OutletDepthContext, useOptionalPageContext } from '../context'

/**
 * Renders the matched child route at the active nesting depth.
 *
 * @returns The child scope, or null outside a page provider or after the last scope.
 */
export function Outlet() {
  const context = useOptionalPageContext()
  const depth = useContext(OutletDepthContext)

  if (!context || depth >= context.outletChain.length) {
    return null
  }

  return (
    <OutletDepthContext.Provider value={depth + 1}>
      {context.outletChain[depth]}
    </OutletDepthContext.Provider>
  )
}
