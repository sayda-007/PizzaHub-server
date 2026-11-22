import { getMenuItemsCollection, getUsersCollection } from '../../database/collections.js';
import { buildUserIdFilter } from '../../middlewares/authenticate.js';
import { ApiError } from '../../utils/api-error.js';
import {
  FREE_MENU_ITEM_LIMIT,
  buildMenuIdFilter,
  buildSlotFilter,
  isPremiumSubscription,
  serializeMenu,
} from '../menu/menu.service.js';
import {
  MENU_STATUS,
  escapeRegex,
} from '../menu/menu.validator.js';
import {
  validateAdminMenuQuery,
  validateModerationBody,
  validatePublishedAvailabilityBody,
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
  const usersSource = dependencies.usersCollection ?? dependencies.users;
  const now = dependencies.now ?? (() => new Date());

  function getCollection() {
    if (typeof collectionSource === 'function') {
      return collectionSource();
    }

    return collectionSource ?? getMenuItemsCollection();
  }

  function getUsers() {
    if (typeof usersSource === 'function') {
      return usersSource();
    }

    return usersSource ?? getUsersCollection();
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

  /**
   * Published availability is separate from pending approval/rejection. Only an
   * approved item can be hidden or restored, and restoring a free vendor's item
   * cannot exceed the same three-slot limit enforced for vendor writes.
   */
  async function setPublishedAvailability(id, body) {
    const isAvailable = validatePublishedAvailabilityBody(body).isAvailable;
    const idFilter = buildMenuIdFilter(id);
    const collection = getCollection();
    const existing = await collection.findOne(idFilter);

    if (!existing) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    if (existing.status !== MENU_STATUS.APPROVED) {
      throw ApiError.conflict(
        'Only published menu items can have Admin availability changed.',
        'MENU_ITEM_NOT_PUBLISHED',
      );
    }

    if ((existing.isAvailable !== false) === isAvailable) {
      return serializeMenu(existing);
    }

    if (isAvailable) {
      const vendor = await getUsers().findOne(buildUserIdFilter(existing.vendorId), {
        projection: {
          subscriptionPlan: 1,
          subscriptionStatus: 1,
          subscriptionExpiresAt: 1,
        },
      });

      if (!isPremiumSubscription(vendor, now())) {
        const usedSlots = await collection.countDocuments(
          buildSlotFilter(existing.vendorId, idFilter._id),
        );

        if (usedSlots >= FREE_MENU_ITEM_LIMIT) {
          throw ApiError.conflict(
            `Free plan allows ${FREE_MENU_ITEM_LIMIT} active menu items.`,
            'MENU_ITEM_LIMIT_REACHED',
          );
        }
      }
    }

    const result = await collection.updateOne(
      { ...idFilter, status: MENU_STATUS.APPROVED },
      { $set: { isAvailable, updatedAt: now() } },
    );

    if ((result?.matchedCount ?? 0) === 0) {
      throw ApiError.conflict(
        'Only published menu items can have Admin availability changed.',
        'MENU_ITEM_NOT_PUBLISHED',
      );
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

  return Object.freeze({ listAdmin, moderate, setPublishedAvailability, remove });
}
