import { getMenuItemsCollection } from '../../database/collections.js';
import { ApiError } from '../../utils/api-error.js';
import {
  buildMenuIdFilter,
  serializeMenu,
} from '../menu/menu.service.js';
import {
  MENU_STATUS,
  escapeRegex,
} from '../menu/menu.validator.js';
import {
  validateAdminMenuQuery,
  validateModerationBody,
} from './admin-menu.validator.js';

/**
 * Admins need item ownership and moderation state. An inclusion projection
 * keeps auth secrets, user records and any unexpected stored field out of the
 * response even if the collection later gains new documents.
 */
export const ADMIN_MENU_PROJECTION = Object.freeze({
  _id: 1,
  vendorId: 1,
  itemName: 1,
  category: 1,
  description: 1,
  price: 1,
  location: 1,
  images: 1,
  status: 1,
  isAvailable: 1,
  createdAt: 1,
  updatedAt: 1,
});

const NOT_PENDING_MESSAGE = 'Only pending menu items can be moderated.';

/**
 * Unlike public browsing this filter starts empty, so admins see every status.
 * The client can only narrow it with validated scalar values and escaped text.
 */
export function buildAdminMenuFilter(options) {
  const filter = {};

  if (options.search) {
    const pattern = escapeRegex(options.search);

    filter.$or = [
      { itemName: { $regex: pattern, $options: 'i' } },
      { description: { $regex: pattern, $options: 'i' } },
    ];
  }

  if (options.status) {
    filter.status = options.status;
  }

  if (options.category) {
    filter.category = options.category;
  }

  if (options.location) {
    filter.location = options.location;
  }

  return filter;
}

/**
 * MongoDB work for Admin menu listing and moderation.
 *
 * The collection and clock are injectable so tests use a fake store and never
 * connect to Atlas. Production uses the existing shared `menuItems` accessor.
 */
export function createAdminMenuService(dependencies = {}) {
  const collectionSource = dependencies.collection;
  const now = dependencies.now ?? (() => new Date());

  function getCollection() {
    if (typeof collectionSource === 'function') {
      return collectionSource();
    }

    return collectionSource ?? getMenuItemsCollection();
  }

  async function listAdmin(query) {
    const options = validateAdminMenuQuery(query);
    const filter = buildAdminMenuFilter(options);
    const collection = getCollection();

    const [totalItems, documents] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter)
        .project(ADMIN_MENU_PROJECTION)
        .sort({ createdAt: -1, _id: -1 })
        .skip((options.page - 1) * options.limit)
        .limit(options.limit)
        .toArray(),
    ]);

    return {
      items: documents.map(serializeMenu),
      pagination: {
        page: options.page,
        limit: options.limit,
        totalItems,
        totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / options.limit),
      },
    };
  }

  /**
   * Moderation is a status-only write. The pending condition is part of the
   * update filter, so a concurrent decision cannot moderate the same item.
   * Pending and approved both remain slot-consuming; no subscription logic is
   * involved and no extra menu slot is created.
   */
  async function moderate(id, body) {
    const targetStatus = validateModerationBody(body).status;
    const idFilter = buildMenuIdFilter(id);
    const collection = getCollection();
    const existing = await collection.findOne(idFilter);

    if (!existing) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    if (existing.status !== MENU_STATUS.PENDING) {
      throw ApiError.conflict(NOT_PENDING_MESSAGE, 'MENU_ITEM_NOT_PENDING');
    }

    const result = await collection.updateOne(
      { ...idFilter, status: MENU_STATUS.PENDING },
      { $set: { status: targetStatus, updatedAt: now() } },
    );

    if ((result?.matchedCount ?? 0) === 0) {
      throw ApiError.conflict(NOT_PENDING_MESSAGE, 'MENU_ITEM_NOT_PENDING');
    }

    const updated = await collection.findOne(idFilter);

    if (!updated) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    return serializeMenu(updated);
  }

  async function remove(id) {
    const filter = buildMenuIdFilter(id);
    const result = await getCollection().deleteOne(filter);

    if ((result?.deletedCount ?? 0) === 0) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    return { id: String(id) };
  }

  return Object.freeze({ listAdmin, moderate, remove });
}
