import { USER_ROLES } from '../auth/config/better-auth.js';
import { ApiError } from '../utils/api-error.js';

const SUPPORTED_ROLES = new Set(Object.values(USER_ROLES));

/**
 * Create role-checking middleware for protected routes.
 *
 * Usage: `app.get('/admin', authenticate, requireRole('admin'), handler)`.
 * The role is read from req.user, which authenticate fills from MongoDB; a
 * role claim inside the JWT is never trusted.
 */
export function requireRole(...roles) {
  const allowedRoles = roles.flat();

  if (allowedRoles.length === 0) {
    throw new Error('requireRole() needs at least one role.');
  }

  for (const role of allowedRoles) {
    if (!SUPPORTED_ROLES.has(role)) {
      throw new Error(`Unsupported role passed to requireRole(): ${String(role)}`);
    }
  }

  return function authorize(req, _res, next) {
    const currentRole = req.user?.role;

    if (!allowedRoles.includes(currentRole)) {
      return next(ApiError.forbidden('You do not have permission to perform this action.'));
    }

    return next();
  };
}
