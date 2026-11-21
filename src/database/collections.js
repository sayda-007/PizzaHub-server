import { getDb } from './mongo.js';

/**
 * Central list of collection names so queries, indexes and future modules all
 * use the same strings.
 *
 * `users` is listed for reference only. Better Auth will own that collection
 * (and its auth collections) in a later milestone, so no accessor is provided
 * here and no competing user records are created by this module.
 */
export const COLLECTIONS = Object.freeze({
  USERS: 'users',
  MENU_ITEMS: 'menuItems',
  ORDERS: 'orders',
  TRANSACTIONS: 'transactions',
});

/** Accessors reuse the single connection pool opened during startup. */
export function getMenuItemsCollection() {
  return getDb().collection(COLLECTIONS.MENU_ITEMS);
}

export function getOrdersCollection() {
  return getDb().collection(COLLECTIONS.ORDERS);
}

export function getTransactionsCollection() {
  return getDb().collection(COLLECTIONS.TRANSACTIONS);
}
