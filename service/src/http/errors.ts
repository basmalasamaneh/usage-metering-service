export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'validation_error', message, details);
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

/** Postgres error code of a thrown error, if any. */
export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
export const UNIQUE_VIOLATION = '23505';
export const FK_VIOLATION = '23503';
