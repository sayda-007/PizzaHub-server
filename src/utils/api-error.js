/**
 * Application error for situations we expect and can describe safely.
 *
 * The message of an ApiError is sent to the client, so it must never contain
 * secrets, database values or internal details. Unexpected errors should be
 * plain Error objects instead; the central handler will hide those.
 */
export class ApiError extends Error {
  constructor(statusCode, message, code = 'ERROR') {
    super(message);

    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;

    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = 'Bad request', code = 'BAD_REQUEST') {
    return new ApiError(400, message, code);
  }

  static unauthorized(message = 'Authentication required.', code = 'UNAUTHORIZED') {
    return new ApiError(401, message, code);
  }

  static forbidden(message = 'You are not allowed to perform this action.', code = 'FORBIDDEN') {
    return new ApiError(403, message, code);
  }

  static notFound(message = 'Resource not found.', code = 'NOT_FOUND') {
    return new ApiError(404, message, code);
  }

  static conflict(message = 'The request conflicts with existing data.', code = 'CONFLICT') {
    return new ApiError(409, message, code);
  }

  static payloadTooLarge(
    message = 'Request payload is too large.',
    code = 'PAYLOAD_TOO_LARGE',
  ) {
    return new ApiError(413, message, code);
  }

  static tooManyRequests(message = 'Too many requests.', code = 'TOO_MANY_REQUESTS') {
    return new ApiError(429, message, code);
  }
}
