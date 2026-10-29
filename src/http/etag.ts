/**
 * Compares an entity-tag list using the selected HTTP comparison rule.
 * Commas inside opaque quoted tags are data, not list separators (RFC 9110 §8.8.3).
 *
 * @param header - If-Match or If-None-Match field value for an existing representation.
 * @param etag - Current quoted entity tag, optionally prefixed with W/.
 * @param weak - Whether to ignore weakness indicators during comparison.
 * @returns Whether the wildcard or an applicable tag matches the representation.
 */
export function matchesETag(header: string, etag: string, weak: boolean): boolean {
  if (header.trim() === '*') return true
  if (!weak && etag.startsWith('W/')) return false
  const expected = weak ? etag.replace(/^W\//, '') : etag
  const tags = header.matchAll(/(?:^|,)[\t ]*((?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")[\t ]*(?=,|$)/g)
  for (const [, tag] of tags) {
    if ((weak ? tag.replace(/^W\//, '') : tag) === expected) return true
  }
  return false
}
