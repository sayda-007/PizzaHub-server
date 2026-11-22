import { USER_ROLES } from '../../auth/config/better-auth.js';
import {
  getMenuItemsCollection,
  getTransactionsCollection,
  getUsersCollection,
} from '../../database/collections.js';
import { buildUserIdFilter } from '../../middlewares/authenticate.js';
import { ApiError } from '../../utils/api-error.js';
import { MENU_STATUS, escapeRegex } from '../menu/menu.validator.js';
import {
  validateAdminBlockBody,
  validateAdminTransactionQuery,
  validateAdminUserId,
  validateAdminUserQuery,
} from './admin.validator.js';

/**
 * Inclusion projections are the first boundary against Better Auth internals.
 * The serializers below are the second: only explicitly listed fields leave
 * the service, so adding a secret field to users later cannot leak it here.
 */
export const ADMIN_USER_PROJECTION = Object.freeze({
  _id: 1,
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  businessName: 1,
  isBlocked: 1,
  subscriptionPlan: 1,
  subscriptionStatus: 1,
  subscriptionExpiresAt: 1,
  createdAt: 1,
  updatedAt: 1,
});

export const ADMIN_TRANSACTION_PROJECTION = Object.freeze({
  _id: 1,
  vendorId: 1,
  stripeSessionId: 1,
  stripeCheckoutSessionId: 1,
  stripeInvoiceId: 1,
  stripeSubscriptionId: 1,
  amount: 1,
  currency: 1,
  paymentStatus: 1,
  status: 1,
  eventType: 1,
  stripeEventId: 1,
  stripeEventCreated: 1,
  createdAt: 1,
  updatedAt: 1,
});

function toIsoOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function idOf(document) {
  const id = document?._id?.toString?.() ?? document?.id;

  return id === undefined || id === null ? null : String(id);
}

/** Deliberately excludes password hashes, tokens, sessions and account rows. */
export function serializeAdminUser(document) {
  const source = document && typeof document === 'object' ? document : {};

  return {
    id: idOf(source),
    name: source.name ?? null,
    email: source.email ?? null,
    image: source.image ?? null,
    role: source.role ?? null,
    businessName: source.businessName ?? null,
    isBlocked: source.isBlocked === true,
    subscriptionPlan: source.subscriptionPlan ?? 'free',
    subscriptionStatus: source.subscriptionStatus ?? 'inactive',
    subscriptionExpiresAt: toIsoOrNull(source.subscriptionExpiresAt),
    createdAt: toIsoOrNull(source.createdAt),
    updatedAt: toIsoOrNull(source.updatedAt),
  };
}

/** Never includes card data, credentials, secrets or unrelated user fields. */
export function serializeAdminTransaction(document) {
  const source = document && typeof document === 'object' ? document : {};
  const paymentStatus = source.paymentStatus ?? source.status ?? 'unknown';

  return {
    id: idOf(source),
    vendorId: source.vendorId ?? null,
    amount: Number.isFinite(Number(source.amount)) ? Number(source.amount) : 0,
    currency: source.currency ?? null,
    paymentStatus,
    status: source.status ?? paymentStatus,
    stripeSessionId: source.stripeSessionId ?? null,
    stripeCheckoutSessionId: source.stripeCheckoutSessionId ?? null,
    stripeInvoiceId: source.stripeInvoiceId ?? null,
    stripeSubscriptionId: source.stripeSubscriptionId ?? null,
    stripeEventId: source.stripeEventId ?? null,
    stripeEventCreated: Number.isFinite(Number(source.stripeEventCreated))
      ? Number(source.stripeEventCreated)
      : null,
    eventType: source.eventType ?? null,
    createdAt: toIsoOrNull(source.createdAt),
    updatedAt: toIsoOrNull(source.updatedAt),
  };
}

function startOfUtcDay(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function endOfUtcDay(value) {
  return new Date(`${value}T23:59:59.999Z`);
}

/** All filters are built from validated scalar options only. */
export function buildAdminUserFilter(options) {
  const filter = {};

  if (options.search) {
    const pattern = escapeRegex(options.search);

    filter.$or = [
      { name: { $regex: pattern, $options: 'i' } },
      { email: { $regex: pattern, $options: 'i' } },
    ];
  }

  if (options.role) {
    filter.role = options.role;
  }

  return filter;
}

export function buildAdminTransactionFilter(options) {
  const filter = {};

  if (options.status) {
    filter.status = options.status;
  }

  if (options.vendorId) {
    filter.vendorId = options.vendorId;
  }

  if (options.fromDate || options.toDate) {
    filter.createdAt = {
      ...(options.fromDate ? { $gte: startOfUtcDay(options.fromDate) } : {}),
      ...(options.toDate ? { $lte: endOfUtcDay(options.toDate) } : {}),
    };
  }

  return filter;
}

function resolveCollection(source, accessor) {
  if (typeof source === 'function') {
    return source();
  }

  return source ?? accessor();
}

function paginationOf(options, totalItems) {
  return {
    page: options.page,
    limit: options.limit,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / options.limit),
  };
}

function requireActor(actorId) {
  if (typeof actorId !== 'string' || actorId.trim() === '') {
    throw ApiError.unauthorized('Authentication required.', 'UNAUTHORIZED');
  }

  return actorId;
}

/**
 * Admin reads and the single block-state write. Collections and the clock are
 * injectable so tests use in-memory stores and never touch Atlas or Stripe.
 */
export function createAdminService(dependencies = {}) {
  const usersSource = dependencies.usersCollection ?? dependencies.users;
  const menuSource = dependencies.menuCollection ?? dependencies.menuItems;
  const transactionsSource = dependencies.transactionsCollection ?? dependencies.transactions;
  const now = dependencies.now ?? (() => new Date());

  function getUsers() {
    return resolveCollection(usersSource, getUsersCollection);
  }

  function getMenuItems() {
    return resolveCollection(menuSource, getMenuItemsCollection);
  }

  function getTransactions() {
    return resolveCollection(transactionsSource, getTransactionsCollection);
  }

  async function getDashboardStats() {
    const [totalUsers, totalVendors, totalCustomers, totalMenuItems, pendingMenuItems, totalTransactions] =
      await Promise.all([
        getUsers().countDocuments({}),
        getUsers().countDocuments({ role: USER_ROLES.VENDOR }),
        getUsers().countDocuments({ role: USER_ROLES.CUSTOMER }),
        getMenuItems().countDocuments({}),
        getMenuItems().countDocuments({ status: MENU_STATUS.PENDING }),
        getTransactions().countDocuments({}),
      ]);

    return {
      stats: {
        totalUsers,
        totalVendors,
        totalCustomers,
        totalMenuItems,
        pendingMenuItems,
        totalTransactions,
      },
    };
  }

  async function listUsers(query) {
    const options = validateAdminUserQuery(query);
    const filter = buildAdminUserFilter(options);

    const [totalItems, documents] = await Promise.all([
      getUsers().countDocuments(filter),
      getUsers()
        .find(filter)
        .project(ADMIN_USER_PROJECTION)
        .sort({ createdAt: -1, _id: -1 })
        .skip((options.page - 1) * options.limit)
        .limit(options.limit)
        .toArray(),
    ]);

    return {
      users: documents.map(serializeAdminUser),
      pagination: paginationOf(options, totalItems),
    };
  }

  async function getUser(id) {
    const userId = validateAdminUserId(id);
    const document = await getUsers().findOne(buildUserIdFilter(userId), {
      projection: ADMIN_USER_PROJECTION,
    });

    if (!document) {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }

    return { user: serializeAdminUser(document) };
  }

  /**
   * One boolean field and a server timestamp only. The conditional update and
   * the admin/self guards cannot be bypassed by body fields or URL changes.
   */
  async function setUserBlocked(id, blocked, actorId, body) {
    validateAdminBlockBody(body);
    const userId = validateAdminUserId(id);
    const currentActorId = requireActor(actorId);
    const filter = buildUserIdFilter(userId);
    const collection = getUsers();

    const existing = await collection.findOne(filter, { projection: ADMIN_USER_PROJECTION });

    if (!existing) {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }

    if (idOf(existing) === currentActorId) {
      throw ApiError.badRequest(
        'An admin cannot change their own block status.',
        'SELF_BLOCK_NOT_ALLOWED',
      );
    }

    if (existing.role === USER_ROLES.ADMIN) {
      throw ApiError.forbidden(
        'Admin accounts cannot be blocked or unblocked.',
        'ADMIN_ACCOUNT_PROTECTED',
      );
    }

    if ((existing.isBlocked === true) === blocked) {
      return { user: serializeAdminUser(existing) };
    }

    const result = await collection.updateOne(
      {
        ...filter,
        role: { $ne: USER_ROLES.ADMIN },
        isBlocked: { $ne: blocked },
      },
      { $set: { isBlocked: blocked, updatedAt: now() } },
    );

    if ((result?.matchedCount ?? 0) === 0) {
      // A concurrent request may have already applied the same decision.
      const reloaded = await collection.findOne(filter, { projection: ADMIN_USER_PROJECTION });

      if (!reloaded) {
        throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
      }

      if (idOf(reloaded) === currentActorId) {
        throw ApiError.badRequest(
          'An admin cannot change their own block status.',
          'SELF_BLOCK_NOT_ALLOWED',
        );
      }

      if (reloaded.role === USER_ROLES.ADMIN) {
        throw ApiError.forbidden(
          'Admin accounts cannot be blocked or unblocked.',
          'ADMIN_ACCOUNT_PROTECTED',
        );
      }

      if ((reloaded.isBlocked === true) === blocked) {
        return { user: serializeAdminUser(reloaded) };
      }

      throw ApiError.conflict('The block state changed; retry the request.', 'BLOCK_STATE_CONFLICT');
    }

    const updated = await collection.findOne(filter, { projection: ADMIN_USER_PROJECTION });

    if (!updated) {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }

    return { user: serializeAdminUser(updated) };
  }

  async function blockUser(id, actorId, body) {
    return setUserBlocked(id, true, actorId, body);
  }

  async function unblockUser(id, actorId, body) {
    return setUserBlocked(id, false, actorId, body);
  }

  /** Read-only: no webhook state, unique index or payment status is changed. */
  async function listTransactions(query) {
    const options = validateAdminTransactionQuery(query);
    const filter = buildAdminTransactionFilter(options);
    const collection = getTransactions();

    const [totalItems, documents] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter)
        .project(ADMIN_TRANSACTION_PROJECTION)
        .sort({ createdAt: -1, _id: -1 })
        .skip((options.page - 1) * options.limit)
        .limit(options.limit)
        .toArray(),
    ]);

    return {
      transactions: documents.map(serializeAdminTransaction),
      pagination: paginationOf(options, totalItems),
    };
  }

  return Object.freeze({
    getDashboardStats,
    listUsers,
    getUser,
    blockUser,
    unblockUser,
    listTransactions,
  });
}
