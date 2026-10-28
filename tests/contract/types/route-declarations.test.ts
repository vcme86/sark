import { resolve } from 'node:path'

import { expect, it } from 'vitest'

import { createProject } from '../../helpers/project'
import { checkTypes } from '../../helpers/typecheck'

it('rejects common route declaration mistakes during the unchanged project type check', () => {
  const project = createProject()
  project.write(
    'contracts.ts',
    `import { route, z } from '@olivaw/sark/server'
// @ts-expect-error A schema factory is not a validation schema.
route().validate({ json: z.string }).handler(() => null)
// @ts-expect-error Unknown route option.
route({ cros: false }).handler(() => null)
`,
  )
  project.write(
    'tsconfig.json',
    JSON.stringify({ extends: resolve('tsconfig.json'), include: ['contracts.ts'] }),
  )
  try {
    const result = checkTypes(project.root)
    expect(result.status, result.output).toBe(0)
  } finally {
    project.remove()
  }
})
