import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, RateLimitError } from '../domain/errors.js';
import type { Config } from '../config.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Correlation id on every request, echoed as a response header.
 *
 * The first thing needed when debugging a production incident is the ability to
 * tie one user's report to one line in the logs.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && incoming.length <= 200 ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

/** Structured access log with timing. In production this would be pino or OTel. */
export function requestLogger(config: Config): RequestHandler {
  return (req, res, next) => {
    if (config.nodeEnv === 'test') return next();

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'request',
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Number(durationMs.toFixed(2)),
          requestId: req.requestId,
        }),
      );
    });
    next();
  };
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/**
 * Sliding-window rate limit, in process.
 *
 * A fixed window would let a caller fire the full quota at 0.99s and again at
 * 1.01s, obeying two windows while delivering double the burst. Storing
 * timestamps costs a little memory and removes that edge.
 *
 * Counters are per-process, so N replicas allow N times the rate. A real
 * deployment needs a shared store (Redis) or, better for a read-heavy API, the
 * limit enforced at the edge — nginx does it in this stack.
 */
export function rateLimit(config: Config): RequestHandler {
  const hits = new Map<string, number[]>();
  const windowMs = 60_000;
  const MAX_KEYS = 20_000;

  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;

    const live = (hits.get(key) ?? []).filter((at) => at > cutoff);
    live.push(now);

    // Bounded, so an attacker rotating addresses cannot turn the limiter itself
    // into the memory leak.
    if (!hits.has(key) && hits.size >= MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    hits.set(key, live);

    res.setHeader('RateLimit-Limit', String(config.rateLimit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, config.rateLimit - live.length)));

    if (live.length > config.rateLimit) {
      const retryAfter = Math.max(1, Math.ceil((live[0]! + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return next(new RateLimitError(retryAfter));
    }

    next();
  };
}

/**
 * Guards writes with a shared secret when API_KEY is set.
 *
 * A stand-in, not an authentication story: production would sit behind an
 * OAuth2/OIDC gateway checking scopes per route. It marks where that boundary goes
 * and stays inert when unset, so local exploration needs no setup.
 */
export function requireApiKey(config: Config): RequestHandler {
  return (req, _res, next) => {
    if (!config.apiKey) return next();

    const provided = req.header('x-api-key');
    if (!provided || !timingSafeEqual(provided, config.apiKey)) {
      return next(new AppError('Missing or invalid API key', 401, 'VALIDATION_ERROR'));
    }
    next();
  };
}

/** Constant time, so response latency does not leak the key byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.path}`,
      requestId: req.requestId,
    },
  });
};

/**
 * The single place errors become HTTP responses.
 *
 * Known failures return a structured, actionable body. Anything else is a bug:
 * logged with its stack server-side, reported as a bare 500 so internals never
 * reach a client.
 */
export function errorHandler(config: Config) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          // Every failure at once, not just the first: a client fixing a payload
          // should not need six attempts to find six problems.
          details: err.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
          requestId: req.requestId,
        },
      });
      return;
    }

    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          requestId: req.requestId,
        },
      });
      return;
    }

    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body is not valid JSON',
          requestId: req.requestId,
        },
      });
      return;
    }

    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'unhandled error',
        requestId: req.requestId,
        path: req.originalUrl,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message:
          config.nodeEnv === 'production'
            ? 'An unexpected error occurred'
            : err instanceof Error
              ? err.message
              : String(err),
        requestId: req.requestId,
      },
    });
  };
}
