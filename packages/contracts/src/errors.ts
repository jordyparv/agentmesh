/** Structured domain error. API maps `status` to the HTTP response code. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = (what: string, id: string) => new DomainError("NOT_FOUND", `${what} ${id} not found`, 404);
export const conflict = (message: string, details?: unknown) => new DomainError("CONFLICT", message, 409, details);
export const forbidden = (message: string) => new DomainError("FORBIDDEN", message, 403);
