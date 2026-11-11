import { route } from '@olivaw/sark'

export default route().handler(async (c) => {
  const auth = c.var.auth
  await auth.signOut()
  return { success: true }
})
