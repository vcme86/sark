import { HttpError, route, z } from '@olivaw/sark'
import { eq } from 'drizzle-orm'

import { users } from '../../db/schema'
import { verifyPassword } from '../../lib/password.mjs'

export default route()
  .validate({
    json: z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    }),
  })
  .handler(async (c, { json }) => {
    const { db, auth } = c.var

    const user = db.select().from(users).where(eq(users.username, json.username)).get()

    if (!user || !verifyPassword(json.password, user.passwordHash)) {
      throw new HttpError(401, 'Invalid username or password')
    }

    await auth.signIn({
      sub: user.id,
      roles: [user.role],
      claims: {
        username: user.username,
        displayName: user.displayName,
      },
    })

    return {
      success: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    }
  })
