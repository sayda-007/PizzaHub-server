import { ApiError } from '../utils/api-error.js';

/**
 * Runs after every known route. Passing an ApiError to next() keeps the 404
 * response in the same JSON shape as all other errors.
 */
export function notFound(req, _res, next) {
  next(new ApiError(404, `Cannot ${req.method} ${req.path}`, 'NOT_FOUND'));
}
