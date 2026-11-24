import { HttpError, route } from '@olivaw/sark'

export default route().handler((c) => {
  const { identity } = c.var.auth
  if (!identity) throw new HttpError(401, 'Sign in required')
  c.header('Cache-Control', 'private, no-store')
  return { subject: identity.sub }
})
