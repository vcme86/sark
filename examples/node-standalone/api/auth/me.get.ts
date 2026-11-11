import { route } from '@olivaw/sark'
import { eq } from 'drizzle-orm'

import { users } from '../../db/schema'

export default route().handler((c) => {
  const auth = c.var.auth
  const identity = auth.identity

  if (!identity?.sub) {
    return { user: null }
  }

  const db = c.var.db
  const user = db
    .select({
      displayName: users.displayName,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, identity.sub))
    .get()

  if (!user) {
    return { user: null }
  }

  return { user }
})
