import {
  getMenuItemsCollection,
  getOrdersCollection,
  getTransactionsCollection,
} from './collections.js';
import { getDb } from './mongo.js';

/**
 * Index definitions for the three business collections.
 *
 * Explicit names make repeated runs idempotent and prevent accidentally
 * creating two indexes with slightly different specifications. There is no
 * text index and no price index yet: search/sort endpoints arrive in a later
 * milestone, so adding them now would be speculative.
 */
const INDEX_DEFINITIONS = Object.freeze([
  {
    collection: getMenuItemsCollection,
    indexes: [
      // "My menu items", newest first. The leading vendorId also serves
      // simple vendorId lookups.
      { name: 'vendorId_1_createdAt_-1', key: { vendorId: 1, createdAt: -1 } },

      // Public browse filters on status: 'approved' only; pending, rejected
      // and inactive items are excluded by that single field.
      {
        name: 'status_1_createdAt_-1',
        key: { status: 1, createdAt: -1 },
      },

      // Category filter combined with the public status filter.
      {
        name: 'category_1_status_1_createdAt_-1',
        key: { category: 1, status: 1, createdAt: -1 },
      },

      // Location filter combined with the public status filter.
      {
        name: 'location_1_status_1_createdAt_-1',
        key: { location: 1, status: 1, createdAt: -1 },
      },

      // Admin listing sorted by submission time regardless of status.
      { name: 'createdAt_-1', key: { createdAt: -1 } },
    ],
  },
  {
    collection: getOrdersCollection,
    indexes: [
      // Customer's own orders, newest first.
      { name: 'customerId_1_createdAt_-1', key: { customerId: 1, createdAt: -1 } },

      // Vendor's incoming orders filtered by status.
      {
        name: 'vendorId_1_status_1_createdAt_-1',
        key: { vendorId: 1, status: 1, createdAt: -1 },
      },

      // Duplicate active-order check for the same item, customer and date.
      // Deliberately NOT unique: rejected/cancelled orders may be recreated.
      {
        name: 'itemId_1_customerId_1_deliveryDate_1',
        key: { itemId: 1, customerId: 1, deliveryDate: 1 },
      },

      // Delivery-date lookups for scheduling.
      { name: 'deliveryDate_1', key: { deliveryDate: 1 } },
    ],
  },
  {
    collection: getTransactionsCollection,
    indexes: [
      // Stripe session ids are externally generated and immutable, so this
      // uniqueness is safe and gives webhook handling idempotency. Sparse so
      // incomplete records do not collide with each other.
      {
        name: 'stripeSessionId_1',
        key: { stripeSessionId: 1 },
        options: { unique: true, sparse: true },
      },

      // Find all records belonging to one subscription (cancel/expire events).
      { name: 'stripeSubscriptionId_1', key: { stripeSubscriptionId: 1 } },

      // Vendor's payment history, newest first.
      { name: 'vendorId_1_createdAt_-1', key: { vendorId: 1, createdAt: -1 } },

      // Admin filtering by payment status.
      { name: 'status_1_createdAt_-1', key: { status: 1, createdAt: -1 } },

      // Admin listing of all transactions, newest first.
      { name: 'createdAt_-1', key: { createdAt: -1 } },
    ],
  },
]);

/**
 * Indexes created by an earlier version of this milestone. They reference an
 * isAvailable field that is not part of the assignment schema, so they are
 * removed during initialization when present. The key is verified before each
 * drop, so an unrelated index can never be removed by name alone.
 */
const OBSOLETE_MENU_ITEM_INDEXES = Object.freeze([
  {
    name: 'status_1_isAvailable_1_createdAt_-1',
    key: { status: 1, isAvailable: 1, createdAt: -1 },
  },
  {
    name: 'category_1_status_1_isAvailable_1_createdAt_-1',
    key: { category: 1, status: 1, isAvailable: 1, createdAt: -1 },
  },
  {
    name: 'location_1_status_1_isAvailable_1_createdAt_-1',
    key: { location: 1, status: 1, isAvailable: 1, createdAt: -1 },
  },
]);

function matchesKey(actual, expected) {
  if (!actual || typeof actual !== 'object') {
    return false;
  }

  const expectedFields = Object.keys(expected);
  const actualFields = Object.keys(actual);

  // Compare by position: the same fields in a different order are a different
  // index and must never be treated as an obsolete match.
  return (
    actualFields.length === expectedFields.length &&
    expectedFields.every(
      (field, position) =>
        actualFields[position] === field && actual[field] === expected[field],
    )
  );
}

/** Remove only the three verified obsolete menu indexes. Exported for focused tests. */
export async function removeObsoleteIndexes(collection) {
  // On a fresh database the collection does not exist yet. There are no
  // obsolete indexes to remove, and collection.indexes() would throw, so skip.
  const collections = await getDb()
    .listCollections({ name: collection.collectionName }, { nameOnly: true })
    .toArray();

  if (collections.length === 0) {
    return;
  }

  const existing = await collection.indexes();

  for (const obsolete of OBSOLETE_MENU_ITEM_INDEXES) {
    const found = existing.find((index) => index.name === obsolete.name);

    if (!found) {
      continue;
    }

    // Defensive: never touch _id or an index whose definition differs.
    if (found.name === '_id_' || !matchesKey(found.key, obsolete.key)) {
      console.warn(`[database] Skipped unexpected index named ${obsolete.name}; left it untouched.`);
      continue;
    }

    try {
      await collection.dropIndex(obsolete.name);
      console.log(`[database] Removed obsolete index ${obsolete.name}.`);
    } catch (error) {
      // Another process may have removed it between listIndexes and dropIndex.
      if (error?.code === 27 || error?.code === 26) {
        continue;
      }

      throw error;
    }
  }
}

/** Never log raw driver text; it can reveal connection details. */
function toSafeIndexError(error) {
  const diagnostic = [];

  if (typeof error?.name === 'string' && /^[A-Za-z]+$/.test(error.name)) {
    diagnostic.push(error.name);
  }

  if (Number.isInteger(error?.code)) {
    diagnostic.push(`code ${error.code}`);
  }

  return diagnostic.length > 0
    ? `Could not initialize database indexes. [${diagnostic.join(', ')}]`
    : 'Could not initialize database indexes.';
}

/**
 * Create all business indexes. Fixed names make this safe to run on every
 * startup and safe to call repeatedly. Returns the number of index specs.
 */
export async function initializeIndexes() {
  try {
    await removeObsoleteIndexes(getMenuItemsCollection());

    for (const definition of INDEX_DEFINITIONS) {
      const collection = definition.collection();

      await collection.createIndexes(
        definition.indexes.map(({ name, key, options }) => ({
          name,
          key,
          ...options,
        })),
      );
    }

    return INDEX_DEFINITIONS.reduce((total, definition) => total + definition.indexes.length, 0);
  } catch (error) {
    throw new Error(toSafeIndexError(error));
  }
}
