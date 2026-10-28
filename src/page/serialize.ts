/**
 * Secure JSON serialization for embedding bootstrap state in HTML script tags.
 *
 * @module
 */

const ESCAPE_LOOKUP: Record<string, string> = {
  '<': '\\u003c',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

const ESCAPE_REGEX = /[<\u2028\u2029]/g

/**
 * Serializes JSON-compatible data for embedding as an HTML script element's text.
 * Escapes < and Unicode line separators; the result is not general-purpose HTML escaping.
 *
 * @param value - JSON-serializable bootstrap data; JSON.stringify must produce a string.
 * @returns JSON text that cannot close its containing script element.
 * @throws {TypeError} If serialization fails, including circular references, bigint, or undefined.
 */
export function serializeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(ESCAPE_REGEX, (char) => ESCAPE_LOOKUP[char])
}
