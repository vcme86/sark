/**
 * Renders nested child routes within layouts.
 *
 * @module
 */

import { useContext } from 'react'

import { OutletDepthContext, useOptionalPageContext } from '../context'

/** Outlet renders the child route matching the current URL at the active nesting depth. */
export function Outlet() {
  const context = useOptionalPageContext()
  const depth = useContext(OutletDepthContext)

  if (!context || !context.outletChain || depth >= context.outletChain.length) {
    return null
  }

  const child = context.outletChain[depth]

  return <OutletDepthContext.Provider value={depth + 1}>{child}</OutletDepthContext.Provider>
}
