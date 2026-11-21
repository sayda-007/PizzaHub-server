import { getDb } from './mongo.js';

/**
 * Central list of collection names so queries, indexes and future modules all
 * use the same strings.
 *
 * Better Auth owns `users`; the subscription module reads and conditionally
 * updates those records through getUsersCollection(). It never creates a
 * competing user record or bypasses Better Auth's own collections.
 */
export const COLLECTIONS = Object.freeze({
  USERS: 'users',
  MENU_ITEMS: 'menuItems',
  ORDERS: 'orders',
  TRANSACTIONS: 'transactions',
});

/** Accessors reuse the single connection pool opened during startup. */
export function getUsersCollection() {
  return getDb().collection(COLLECTIONS.USERS);
}

export function getMenuItemsCollection() {
  return getDb().collection(COLLECTIONS.MENU_ITEMS);
}

export function getOrdersCollection() {
  return getDb().collection(COLLECTIONS.ORDERS);
}

export function getTransactionsCollection() {
  return getDb().collection(COLLECTIONS.TRANSACTIONS);
}
