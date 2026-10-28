import { configureSync, getConfig, resetSync } from '@logtape/logtape'
import { expect, it, vi } from 'vitest'

import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, getLogger } from '../../src/entries/server'

it('restores basic diagnostics after the host resets LogTape, including custom application categories', async () => {
  const previous = getConfig()
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const generation of [1, 2]) {
      resetSync()
      const app = await createApp(createDefinition())
      try {
        getLogger('queries').error(`diagnostic-generation-${generation}`)
        expect(output.mock.calls.flat().join(' ')).toContain(`diagnostic-generation-${generation}`)
      } finally {
        await app.close()
      }
    }
  } finally {
    output.mockRestore()
    if (previous) configureSync({ ...previous, reset: true })
    else resetSync()
  }
})
