import { USER_ROLES } from '../../auth/config/better-auth.js';
import { COLLECTIONS } from '../../database/collections.js';
import { getDb } from '../../database/mongo.js';
import {
  buildUserIdFilter,
  findUserById,
  sanitizeUser,
} from '../../middlewares/authenticate.js';
import { ApiError } from '../../utils/api-error.js';
import { validateProfileUpdate } from './user.validator.js';

/**
 * Build the update document from an explicit allow-list.
 *
 * `req.body` is never spread into MongoDB. Even if another layer is changed
 * later, only these three profile fields can produce a `$set` entry here.
 */
export function buildProfileUpdateSet(user, validatedUpdate) {
  const set = {};

  if (Object.hasOwn(validatedUpdate, 'name')) {
    set.name = validatedUpdate.name;
  }

  if (Object.hasOwn(validatedUpdate, 'image')) {
    set.image = validatedUpdate.image;
  }

  if (Object.hasOwn(validatedUpdate, 'businessName')) {
    // The validator checks this too; repeat it at the database boundary so a
    // role change can never make a stale request vendor-only by accident.
    if (user?.role !== USER_ROLES.VENDOR) {
      throw ApiError.forbidden('Only vendors can update businessName.', 'FORBIDDEN_FIELD');
    }

    set.businessName = validatedUpdate.businessName;
  }

  if (Object.keys(set).length === 0) {
    throw ApiError.badRequest('No profile fields to update.', 'EMPTY_UPDATE');
  }

  return set;
}

/**
 * Profile reads and writes against Better Auth's `users` collection.
 *
 * Collections and lookup helpers are injectable so tests can use a small fake
 * store; production uses the shared pool opened by server.js.
 */
export function createUserService(dependencies = {}) {
  const collectionSource = dependencies.collection;
  const findUser = dependencies.findUserById ?? findUserById;
  const now = dependencies.now ?? (() => new Date());

  function getCollection() {
    if (typeof collectionSource === 'function') {
      return collectionSource();
    }

    return collectionSource ?? getDb().collection(COLLECTIONS.USERS);
  }

  async function getProfile(userId) {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }

    const user = await findUser(userId, getCollection());

    if (!user) {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }

    return sanitizeUser(user, userId);
  }

  async function updateProfile(userId, role, body) {
    const validatedUpdate = validateProfileUpdate(body, { role });

    if (typeof userId !== 'string' || userId.trim() === '') {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }

    const existingUser = await findUser(userId, getCollection());

    if (!existingUser) {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }

    const set = buildProfileUpdateSet(existingUser, validatedUpdate);

    // Keep Better Auth's own timestamp consistent. It is server-generated and
    // is not taken from the request body.
    set.updatedAt = now();

    const filter = buildUserIdFilter(userId);

    if (!filter) {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }

    const result = await getCollection().updateOne(filter, { $set: set });

    if (result?.matchedCount === 0) {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }

    // Reload instead of returning the write payload: this re-reads the true
    // database state and passes it through the same sanitizer as GET /me.
    return getProfile(userId);
  }

  return Object.freeze({ getProfile, updateProfile });
}
