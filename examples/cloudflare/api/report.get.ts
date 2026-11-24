import { HttpError, route } from '@olivaw/sark'

export default route().handler(async (c) => {
  const report = await c.var.storage.files.get('latest.txt')
  if (!report) throw new HttpError(404, 'No report has been generated')
  return new Response(report.body, { headers: { 'Content-Type': report.contentType } })
})
