import { ObjectId } from 'mongodb';

import { createJwtVerifier, JwksUnavailableError } from '../auth/jwt.js';
import { COLLECTIONS } from '../database/collections.js';
import { getDb } from '../database/mongo.js';
import { ApiError } from '../utils/api-error.js';

/**
 * Only these fields are copied onto req.user. Password hashes, auth secrets,
 * private database fields and unexpected JWT claims are deliberately ignored.
 */
export const SAFE_USER_FIELDS = Object.freeze([
  'name',
  'email',
  'image',
  'role',
  'businessName',
  'subscriptionPlan',
  'subscriptionStatus',
  'subscriptionExpiresAt',
]);

const USER_LOOKUP_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  businessName: 1,
  isBlocked: 1,
  subscriptionPlan: 1,
  subscriptionStatus: 1,
  subscriptionExpiresAt: 1,
});

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** The JWT plugin adds this claim to every token issued by /api/auth/token. */
export const SESSION_ID_CLAIM = 'sid';

const SESSION_LOOKUP_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  userId: 1,
  expiresAt: 1,
});

/**
 * Better Auth's MongoDB adapter maps `id` to `_id` and stores it as an
 * ObjectId when no custom id generator is configured. It can return a string
 * for custom ids, so both forms are accepted. A plain string lookup is also
 * included for ObjectId-shaped values in case a record was stored as a string.
 */
export function buildUserIdFilter(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    return null;
  }

  if (OBJECT_ID_PATTERN.test(userId)) {
    const objectId = new ObjectId(userId);

    return { _id: { $in: [objectId, userId] } };
  }

  return { _id: userId };
}

/**
 * Load only the current, safe fields from Better Auth's `users` collection.
 * The collection can be injected in tests; production uses the shared pool.
 */
export async function findUserById(userId, collection) {
  const filter = buildUserIdFilter(userId);

  if (!filter) {
    return null;
  }

  const users = collection ?? getDb().collection(COLLECTIONS.USERS);

  return users.findOne(filter, { projection: USER_LOOKUP_PROJECTION });
}

/**
 * Better Auth stores session ids under `_id` in MongoDB. The same ObjectId or
 * legacy-string handling as user ids applies here.
 */
export function findSessionById(sessionId, collection) {
  const filter = buildUserIdFilter(sessionId);

  if (!filter) {
    return null;
  }

  const sessions = collection ?? getDb().collection(COLLECTIONS.SESSIONS);

  return sessions.findOne(filter, { projection: SESSION_LOOKUP_PROJECTION });
}

/** A token is usable only while its Better Auth session exists and is live. */
export function isActiveSession(session, userId, now = new Date()) {
  if (!session || typeof session !== 'object') {
    return false;
  }

  const sessionUserId = session.userId?._id ?? session.userId?.id ?? session.userId;

  if (sessionUserId === undefined || sessionUserId === null) {
    return false;
  }

  if (String(sessionUserId) !== String(userId)) {
    return false;
  }

  const expiresAt = new Date(session.expiresAt).getTime();

  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

/** Build the small object that feature middleware and routes may read. */
export function sanitizeUser(document, fallbackId) {
  const safeUser = {};
  const source = document && typeof document === 'object' ? document : {};
  const id = source._id?.toString?.() ?? source.id ?? fallbackId;

  if (id !== undefined && id !== null) {
    safeUser.id = String(id);
  }

  for (const field of SAFE_USER_FIELDS) {
    if (Object.hasOwn(source, field)) {
      safeUser[field] = source[field];
    }
  }

  return safeUser;
}

/**
 * Build Express authentication middleware.
 *
 * Verification and database lookup are injectable so tests can run without a
 * JWKS server, MongoDB Atlas, or real users. Failures expected from clients
 * become ApiErrors; unexpected infrastructure errors go to the central handler.
 */
export function createAuthenticate(env, dependencies = {}) {
  const verifyToken = dependencies.verifyToken ?? createJwtVerifier(env);
  const findUser = dependencies.findUser ?? findUserById;
  const findSession = dependencies.findSession ?? findSessionById;
  const now = dependencies.now ?? (() => new Date());

  return async function authenticate(req, _res, next) {
    try {
      const header = req.get?.('authorization') ?? req.headers?.authorization;

      if (typeof header !== 'string') {
        throw ApiError.unauthorized('A Bearer token is required.');
      }

      const match = BEARER_PATTERN.exec(header.trim());

      if (!match) {
        throw ApiError.unauthorized('A Bearer token is required.');
      }

      const token = match[1];
      let claims;

      try {
        claims = await verifyToken(token);
      } catch (error) {
        // A JWKS outage is infrastructure, so let the central handler own it.
        // Every other verification failure is a client credential problem. The
        // message stays generic; the token is never logged or echoed.
        if (error instanceof JwksUnavailableError) {
          throw error;
        }

        throw ApiError.unauthorized('Invalid or expired token.');
      }

      const subject = claims?.sub;

      if (typeof subject !== 'string' || subject.trim() === '') {
        throw ApiError.unauthorized('Invalid or expired token.');
      }

      // A signed JWT alone is not enough: /sign-out deletes this session, and
      // an admin may revoke it. Checking the record closes the logout window.
      const sessionId = claims[SESSION_ID_CLAIM];

      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        throw ApiError.unauthorized('Invalid or expired token.');
      }

      const session = await findSession(sessionId);

      if (!isActiveSession(session, subject, now())) {
        throw ApiError.unauthorized('Invalid or expired token.');
      }

      const user = await findUser(subject);

      if (!user) {
        throw ApiError.unauthorized('User no longer exists.');
      }

      if (user.isBlocked === true) {
        throw ApiError.forbidden('This account is blocked.');
      }

      req.user = sanitizeUser(user, subject);

      return next();
    } catch (error) {
      // ApiError is safe to expose. Database and other unexpected failures are
      // forwarded unchanged so the centralized handler can return a generic 500.
      return next(error);
    }
  };
}
