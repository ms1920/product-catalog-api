/**
 * Domain error taxonomy.
 *
 * Services throw these; the HTTP layer is the only place that turns them into
 * status codes. That keeps business logic transport-agnostic — the same service
 * could be driven by a queue consumer or a CLI without change — and means there
 * is exactly one place where a status code is decided.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'PRECONDITION_REQUIRED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: ErrorCode,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} '${id}' was not found`, 404, 'NOT_FOUND', { resource, id });
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

/**
 * 412 — the caller sent `If-Match` and it no longer matches.
 *
 * This is the optimistic-concurrency rejection. Without it two editors who both
 * read version 3 would each save, and the later write would silently erase the
 * earlier one: the lost-update problem.
 */
export class PreconditionFailedError extends AppError {
  constructor(expected: string, actual: string) {
    super(
      'The product changed since you read it. Re-read it and retry.',
      412,
      'PRECONDITION_FAILED',
      { expected, actual },
    );
  }
}

/** 428 — a mutation that requires `If-Match` arrived without one. */
export class PreconditionRequiredError extends AppError {
  constructor() {
    super(
      'This request requires an If-Match header carrying the ETag you last read.',
      428,
      'PRECONDITION_REQUIRED',
      { header: 'If-Match' },
    );
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(`Too many requests. Retry in ${retryAfterSeconds}s.`, 429, 'RATE_LIMITED', {
      retryAfterSeconds,
    });
  }
}
