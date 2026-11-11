import { HttpError, route, z } from '@olivaw/sark'
import { rateLimit } from '@olivaw/sark/middleware'
import { eq } from 'drizzle-orm'

import { users } from '../../db/schema'
import { verifyPassword } from '../../lib/password'

export default route({ middleware: [rateLimit({ limit: 10, window: 60_000 })] })
  .validate({
    json: z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    }),
  })
  .handler(async (c, { json }) => {
    const { db, auth } = c.var

    const user = db.select().from(users).where(eq(users.username, json.username)).get()

    const valid = await verifyPassword(json.password, user?.passwordHash)
    if (!user || !valid) {
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
