import { ObjectId } from 'mongodb';

import {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
} from '../../auth/config/better-auth.js';
import { getMenuItemsCollection } from '../../database/collections.js';
import { ApiError } from '../../utils/api-error.js';
import {
  MENU_STATUS,
  validateMenuPagination,
  validateMenuUpdate,
} from './menu.validator.js';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** Free vendors may reserve three slots; pending items count toward the limit. */
export const FREE_MENU_ITEM_LIMIT = 3;

const SLOT_MENU_STATUSES = Object.freeze([MENU_STATUS.PENDING, MENU_STATUS.APPROVED]);
const LIMIT_MESSAGE =
  `Free plan allows ${FREE_MENU_ITEM_LIMIT} active menu items. ` +
  'Upgrade to Premium or make an item unavailable to add another.';

function toTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/**
 * Premium access comes from the current MongoDB user snapshot on `req.user`.
 * JWT claims and request bodies are never consulted. Both an active status and
 * a future expiration are required, so Stripe webhooks can reuse these fields.
 */
export function isPremiumSubscription(user, now = new Date()) {
  if (user?.subscriptionPlan !== SUBSCRIPTION_PLANS.PREMIUM) {
    return false;
  }

  if (user?.subscriptionStatus !== SUBSCRIPTION_STATUS.ACTIVE) {
    return false;
  }

  const expiresAt = toTimestamp(user.subscriptionExpiresAt);
  const currentTime = toTimestamp(now);

  return Number.isFinite(expiresAt) && Number.isFinite(currentTime) && expiresAt > currentTime;
}

/** Unavailable, rejected and inactive items do not reserve a slot. */
export function menuItemConsumesSlot(item) {
  return item?.isAvailable !== false && SLOT_MENU_STATUSES.includes(item?.status);
}

/**
 * Only a canonical 24-hex id is accepted. This avoids Node/NoSQL coercion such
 * as an object like `{ $ne: null }` being treated as an id.
 */
export function buildMenuIdFilter(id) {
  if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) {
    throw ApiError.badRequest('Invalid menu item id.', 'INVALID_MENU_ID');
  }

  return { _id: new ObjectId(id) };
}

/** Every read and write uses this helper so ownership is part of the DB query. */
export function buildOwnedMenuFilter(vendorId, id) {
  return { ...buildMenuIdFilter(id), vendorId: requireVendorId(vendorId) };
}

function requireVendorId(vendorId) {
  if (typeof vendorId !== 'string' || vendorId.trim() === '') {
    throw ApiError.unauthorized('Authentication required.', 'UNAUTHORIZED');
  }

  return vendorId;
}

/** Slot count is a MongoDB query so ownership and state cannot be faked by Express. */
export function buildSlotFilter(vendorId, excludeId) {
  const filter = {
    vendorId: requireVendorId(vendorId),
    status: { $in: [...SLOT_MENU_STATUSES] },
    isAvailable: { $ne: false },
  };

  if (excludeId) {
    filter._id = { $ne: excludeId };
  }

  return filter;
}

function validateStoredImageUrls(imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    throw ApiError.badRequest('At least one image URL is required.', 'IMAGE_REQUIRED');
  }

  for (const url of imageUrls) {
    if (typeof url !== 'string' || url.length > 2048) {
      throw ApiError.badRequest('Uploaded images must be valid URLs.', 'INVALID_IMAGE_URL');
    }

    try {
      const parsed = new URL(url);

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('unsupported protocol');
      }
    } catch {
      throw ApiError.badRequest('Uploaded images must be valid URLs.', 'INVALID_IMAGE_URL');
    }
  }

  return [...imageUrls];
}

/** Return only fields the API owns and clients may safely read. */
export function serializeMenu(document) {
  const source = document && typeof document === 'object' ? document : {};
  const id = source._id?.toString?.() ?? source.id;
  const result = {
    id: id === undefined || id === null ? undefined : String(id),
    vendorId: source.vendorId,
    itemName: source.itemName,
    category: source.category,
    description: source.description,
    price: source.price,
    location: source.location,
    images: Array.isArray(source.images) ? [...source.images] : [],
    status: source.status,
    isAvailable: source.isAvailable !== false,
    createdAt: source.createdAt,
  };

  if (Object.hasOwn(source, 'updatedAt')) {
    result.updatedAt = source.updatedAt;
  }

  return result;
}

/** Build the patch from an allow-list; raw request bodies are never spread. */
export function buildMenuUpdateSet(validatedUpdate) {
  const set = {};
  const editableFields = [
    'itemName',
    'category',
    'description',
    'price',
    'location',
  ];

  for (const field of editableFields) {
    if (Object.hasOwn(validatedUpdate, field)) {
      set[field] = validatedUpdate[field];
    }
  }

  if (Object.keys(set).length === 0) {
    throw ApiError.badRequest('No menu fields to update.', 'EMPTY_UPDATE');
  }

  return set;
}

/**
 * MongoDB work for vendor menu management.
 *
 * The collection and clock are injectable so tests use a small fake store and
 * never connect to Atlas. Production uses the shared `menuItems` accessor.
 */
export function createMenuService(dependencies = {}) {
  const collectionSource = dependencies.collection;
  const now = dependencies.now ?? (() => new Date());

  function getCollection() {
    if (typeof collectionSource === 'function') {
      return collectionSource();
    }

    return collectionSource ?? getMenuItemsCollection();
  }

  async function countSlots(vendorId, excludeId) {
    return getCollection().countDocuments(buildSlotFilter(vendorId, excludeId));
  }

  /** Premium users skip the count entirely; everyone else gets a fixed 409. */
  async function assertSlotAvailable(vendorId, user, timestamp, excludeId) {
    if (isPremiumSubscription(user, timestamp)) {
      return;
    }

    const usedSlots = await countSlots(vendorId, excludeId);

    if (usedSlots >= FREE_MENU_ITEM_LIMIT) {
      throw ApiError.conflict(LIMIT_MESSAGE, 'MENU_ITEM_LIMIT_REACHED');
    }
  }

  async function assertCanCreate(vendorId, user) {
    await assertSlotAvailable(vendorId, user, now());
  }

  async function create(vendorId, validatedData, imageUrls, user) {
    const safeVendorId = requireVendorId(vendorId);
    const images = validateStoredImageUrls(imageUrls);
    const timestamp = now();

    // Check again at the database boundary. The controller also checks before
    // ImgBB upload so a rejected create never spends an external upload call.
    await assertSlotAvailable(safeVendorId, user, timestamp);

    // status, isAvailable, vendorId and createdAt are server-owned. A caller
    // cannot supply them because validatedData contains only the five fields
    // from the strict create schema.
    const document = {
      vendorId: safeVendorId,
      itemName: validatedData.itemName,
      category: validatedData.category,
      description: validatedData.description,
      price: validatedData.price,
      location: validatedData.location,
      images,
      status: MENU_STATUS.PENDING,
      isAvailable: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const result = await getCollection().insertOne(document);

    return serializeMenu({ ...document, _id: result?.insertedId ?? document._id });
  }

  async function listMine(vendorId, query) {
    const safeVendorId = requireVendorId(vendorId);
    const { page, limit } = validateMenuPagination(query);
    const filter = { vendorId: safeVendorId };
    const collection = getCollection();

    const [total, documents] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
    ]);

    return {
      items: documents.map(serializeMenu),
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async function update(vendorId, id, body) {
    const validatedUpdate = validateMenuUpdate(body);
    const set = buildMenuUpdateSet(validatedUpdate);
    const filter = buildOwnedMenuFilter(vendorId, id);

    set.updatedAt = now();

    const result = await getCollection().updateOne(filter, { $set: set });

    if ((result?.matchedCount ?? 0) === 0) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    // Reload with the same ownership filter, then sanitize the stored record.
    const updated = await getCollection().findOne(filter);

    if (!updated) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    return serializeMenu(updated);
  }

  async function toggleAvailability(vendorId, id, user) {
    const filter = buildOwnedMenuFilter(vendorId, id);
    const existing = await getCollection().findOne(filter);

    if (!existing) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    const current = existing.isAvailable !== false;
    const next = !current;
    const timestamp = now();

    // Only a new active/reserved item needs a slot. Rejected or inactive items
    // remain non-consuming even after an availability toggle.
    if (next && menuItemConsumesSlot({ ...existing, isAvailable: next })) {
      await assertSlotAvailable(vendorId, user, timestamp, filter._id);
    }

    const result = await getCollection().updateOne(filter, {
      $set: { isAvailable: next, updatedAt: timestamp },
    });

    if ((result?.matchedCount ?? 0) === 0) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    const updated = await getCollection().findOne(filter);

    if (!updated) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    return serializeMenu(updated);
  }

  async function remove(vendorId, id) {
    const filter = buildOwnedMenuFilter(vendorId, id);
    const result = await getCollection().deleteOne(filter);

    if ((result?.deletedCount ?? 0) === 0) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    return { id: String(id) };
  }

  return Object.freeze({
    assertCanCreate,
    create,
    listMine,
    update,
    toggleAvailability,
    remove,
  });
}
