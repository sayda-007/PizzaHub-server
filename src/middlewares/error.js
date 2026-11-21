import { ApiError } from '../utils/api-error.js';

const GENERIC_MESSAGE = 'An unexpected error occurred.';
const GENERIC_CODE = 'INTERNAL_SERVER_ERROR';

/**
 * Single place that turns any thrown error into the same JSON shape:
 *   { success: false, message, code, details? }
 *
 * Only ApiError messages are trusted as safe. An arbitrary error is never
 * exposed just because it happens to carry expose: true; in production it is
 * always reduced to the generic 500 response.
 */
export function createErrorHandler(env) {
  return function errorHandler(error, req, res, next) {
    // A response already started cannot be replaced with JSON.
    if (res.headersSent) {
      return next(error);
    }

    const isProduction = env.NODE_ENV === 'production';

    let status = 500;
    let message = GENERIC_MESSAGE;
    let code = GENERIC_CODE;
    let details;

    // Body-parser errors are recognized explicitly. Their messages and their
    // "expose" flag are never trusted, so fixed safe strings are used instead.
    if (error?.type === 'entity.parse.failed') {
      status = 400;
      message = 'Invalid JSON payload.';
      code = 'INVALID_JSON';
    } else if (error?.type === 'entity.too.large') {
      status = 413;
      message = 'Request payload is too large.';
      code = 'PAYLOAD_TOO_LARGE';
    } else if (error?.name === 'ZodError' && Array.isArray(error.issues)) {
      status = 400;
      message = 'Validation failed.';
      code = 'VALIDATION_ERROR';
      details = error.issues.map((issue) => ({
        field: Array.isArray(issue.path) ? issue.path.join('.') : '',
        message: typeof issue.message === 'string' ? issue.message : 'Invalid value',
      }));
    } else if (error instanceof ApiError) {
      status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      message = error.message || GENERIC_MESSAGE;
      code = error.code || 'ERROR';
    } else if (!isProduction) {
      // Development-only diagnostics. Stack traces are logged, never sent.
      if (Number.isInteger(error?.statusCode)) {
        status = error.statusCode;
      }

      if (typeof error?.message === 'string') {
        message = error.message;
      }
    }

    // Server-side diagnostics only; the client never receives this payload.
    if (status >= 500) {
      console.error(`[error] ${req.method} ${req.path}`, error);
    }

    const body = { success: false, message, code };

    if (details?.length > 0) {
      body.details = details;
    }

    return res.status(status).json(body);
  };
}
