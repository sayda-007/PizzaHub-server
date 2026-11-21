import { ObjectId } from 'mongodb';

import { getMenuItemsCollection } from '../../database/collections.js';
import { ApiError } from '../../utils/api-error.js';
import {
  MENU_STATUS,
  validateMenuPagination,
  validateMenuUpdate,
} from './menu.validator.js';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

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

  async function create(vendorId, validatedData, imageUrls) {
    const safeVendorId = requireVendorId(vendorId);
    const images = validateStoredImageUrls(imageUrls);
    const timestamp = now();

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

  async function toggleAvailability(vendorId, id) {
    const filter = buildOwnedMenuFilter(vendorId, id);
    const existing = await getCollection().findOne(filter);

    if (!existing) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    const current = existing.isAvailable !== false;
    const result = await getCollection().updateOne(filter, {
      $set: { isAvailable: !current, updatedAt: now() },
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

  return Object.freeze({ create, listMine, update, toggleAvailability, remove });
}
