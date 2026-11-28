import {
  getMenuSlotReservationsCollection,
} from '../../database/collections.js';
import { ApiError } from '../../utils/api-error.js';

/**
 * Atomic free-plan slot reservations.
 *
 * A count-then-write check races: two requests can both observe two used slots
 * and both create a third. Instead each vendor owns one reservation document.
 * MongoDB applies the size check and the array append in a single
 * findOneAndUpdate, so only three concurrent consumers can win a slot.
 *
 * Reservations are keyed by item id. Re-applying the same item is idempotent,
 * and releasing a slot that is no longer reserved is harmless.
 */
export const MENU_SLOT_LIMIT = 3;

const LIMIT_MESSAGE =
  `Free plan allows ${MENU_SLOT_LIMIT} active menu items. ` +
  'Upgrade to Premium or make an item unavailable to add another.';

function vendorKey(vendorId) {
  if (typeof vendorId !== 'string' || vendorId.trim() === '') {
    throw ApiError.unauthorized('Authentication required.', 'UNAUTHORIZED');
  }

  return vendorId;
}

function itemKey(itemId) {
  if (itemId === undefined || itemId === null || String(itemId) === '') {
    throw ApiError.badRequest('Invalid menu item id.', 'INVALID_MENU_ID');
  }

  return String(itemId);
}

function limitError() {
  return ApiError.conflict(LIMIT_MESSAGE, 'MENU_ITEM_LIMIT_REACHED');
}

/**
 * MongoDB work for slot reservations. The collection is injectable so tests use
 * a small fake store and never connect to Atlas.
 */
export function createMenuSlotService(dependencies = {}) {
  const collectionSource = dependencies.collection;

  function getCollection() {
    if (typeof collectionSource === 'function') {
      return collectionSource();
    }

    return collectionSource ?? getMenuSlotReservationsCollection();
  }

  /**
   * Seed a legacy vendor from the items that already consume slots. A duplicate
   * key simply means another request seeded the document first.
   */
  async function ensureVendor(vendorId, existingItemIds = [], unlimited = false) {
    const ids = existingItemIds.map(itemKey);
    const document = {
      _id: vendorKey(vendorId),
      itemIds: unlimited ? ids : ids.slice(0, MENU_SLOT_LIMIT),
    };

    try {
      await getCollection().updateOne(
        { _id: document._id },
        { $setOnInsert: document },
        { upsert: true },
      );
    } catch (error) {
      if (error?.code !== 11000 && error?.codeName !== 'DuplicateKey') {
        throw error;
      }
    }
  }

  async function has(vendorId, itemId) {
    const reserved = await getCollection().findOne({
      _id: vendorKey(vendorId),
      itemIds: itemKey(itemId),
    });

    return Boolean(reserved);
  }

  /**
   * Atomically append one item id while the free-plan list has room. The
   * `$cond` makes a retry for the same item a no-op even when the list is full.
   */
  async function reserve({
    vendorId,
    itemId,
    unlimited = false,
    existingItemIds = [],
    pending = false,
  }) {
    const key = vendorKey(vendorId);
    const id = itemKey(itemId);

    await ensureVendor(key, existingItemIds, unlimited);

    const freeFilter = {
      $or: [
        { $expr: { $lt: [{ $size: '$itemIds' }, MENU_SLOT_LIMIT] } },
        { itemIds: id },
      ],
    };
    const filter = { _id: key, ...(unlimited ? {} : freeFilter) };
    const set = {
      itemIds: {
        $cond: [
          { $in: [id, '$itemIds'] },
          '$itemIds',
          { $concatArrays: ['$itemIds', [id]] },
        ],
      },
    };

    // A new menu item is reserved before its document is inserted. Mark it as
    // pending so reconciliation cannot mistake that in-flight slot for a stale
    // id while another request is being created concurrently.
    if (pending) {
      set.pendingItemIds = {
        $cond: [
          { $in: [id, { $ifNull: ['$pendingItemIds', []] }] },
          { $ifNull: ['$pendingItemIds', []] },
          { $concatArrays: [{ $ifNull: ['$pendingItemIds', []] }, [id]] },
        ],
      };
    }

    const update = [{ $set: set }];

    const result = await getCollection().findOneAndUpdate(filter, update, {
      returnDocument: 'after',
    });
    const document = result?.value ?? result;

    if (!document) {
      throw limitError();
    }

    return true;
  }

  async function release(vendorId, itemId) {
    return getCollection().updateOne(
      { _id: vendorKey(vendorId) },
      { $pull: { itemIds: itemKey(itemId), pendingItemIds: itemKey(itemId) } },
    );
  }

  /** Clear an in-flight marker once the matching menu document exists. */
  async function confirm(vendorId, itemId) {
    return getCollection().updateOne(
      { _id: vendorKey(vendorId) },
      { $pull: { pendingItemIds: itemKey(itemId) } },
    );
  }

  /**
   * Replace the reservation with the ids that actually consume a slot right
   * now. Pending ids are read inside the same MongoDB update, so a concurrent
   * reservation cannot be lost between a separate read and write.
   * `forceRemoveItemIds` lets a completed hide/reject/delete heal a stale id
   * immediately. A duplicate on the upsert is retried because two concurrent
   * calls may race to create the same vendor document.
   */
  async function reconcile(vendorId, actualItemIds = [], options = {}) {
    const key = vendorKey(vendorId);
    const forced = [...new Set((options.forceRemoveItemIds ?? []).map(itemKey))];
    const forcedSet = new Set(forced);
    const actual = [...new Set(actualItemIds.map(itemKey))].filter(
      (id) => !forcedSet.has(id),
    );

    const preservedPending = {
      $filter: {
        input: { $ifNull: ['$pendingItemIds', []] },
        as: 'reservedId',
        cond: { $not: { $in: ['$$reservedId', forced] } },
      },
    };
    const pendingWithoutActual = {
      $filter: {
        input: preservedPending,
        as: 'reservedId',
        cond: { $not: { $in: ['$$reservedId', actual] } },
      },
    };
    const update = [
      {
        $set: {
          itemIds: { $concatArrays: [actual, pendingWithoutActual] },
          pendingItemIds: preservedPending,
        },
      },
    ];
    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await getCollection().updateOne({ _id: key }, update, { upsert: true });
        return true;
      } catch (error) {
        lastError = error;

        if (error?.code !== 11000 && error?.codeName !== 'DuplicateKey') {
          throw error;
        }
      }
    }

    throw lastError;
  }

  return Object.freeze({ ensureVendor, has, reserve, release, confirm, reconcile });
}
