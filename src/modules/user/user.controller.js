import { ApiError } from '../../utils/api-error.js';

/**
 * Thin Express adapter for the profile service.
 *
 * The user object is put on req.user by `authenticate`, which verifies the
 * Bearer JWT and reloads the user from MongoDB. A missing user is treated as
 * unauthenticated so these endpoints can never fall back to a session cookie.
 */
export function createUserController(service) {
  function currentUser(req) {
    const user = req.user;
    const id = user?.id;

    if (typeof id !== 'string' || id.trim() === '') {
      throw ApiError.unauthorized('Authentication required.', 'UNAUTHORIZED');
    }

    return user;
  }

  return {
    async getMe(req, res, next) {
      try {
        const user = currentUser(req);
        const profile = await service.getProfile(user.id);

        return res.json({ user: profile });
      } catch (error) {
        return next(error);
      }
    },

    async patchMe(req, res, next) {
      try {
        const user = currentUser(req);
        const profile = await service.updateProfile(user.id, user.role, req.body);

        return res.json({ user: profile });
      } catch (error) {
        return next(error);
      }
    },
  };
}
