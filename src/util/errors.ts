/**
 * Error types that carry an HTTP answer.
 *
 * The API previously inferred 400 from substrings in the message — "required",
 * "must be", "exceeds" and friends. That works until a message is reworded, at
 * which point a caller's mistake silently starts reporting as a server fault.
 * Throwing a typed error says what happened instead of hoping the wording
 * happens to match.
 *
 * The substring fallback stays for the routes that still throw plain Errors.
 */
export class BadRequestError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
