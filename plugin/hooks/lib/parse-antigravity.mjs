/**
 * Antigravity CLI session JSON parser for hook scripts.
 *
 * Antigravity keeps the Gemini CLI token metadata shape, so this parser
 * intentionally reuses the mature Gemini-compatible reader.
 */

export { parseGeminiSession as parseAntigravitySession } from './parse-gemini.mjs';
