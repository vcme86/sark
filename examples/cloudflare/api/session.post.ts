import { timingSafeEqual } from 'node:crypto'

import { HttpError, route, z } from '@olivaw/sark'

export default route()
  .validate({ json: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }) })
  .handler(async (c, { json }) => {
    const token = new TextEncoder().encode(json.token)
    const expected = new TextEncoder().encode(c.env.DEMO_TOKEN)
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
      throw new HttpError(401, 'Invalid demo token')
    }
    await c.var.auth.signIn({ sub: 'demo' })
    return c.body(null, 204)
  })
