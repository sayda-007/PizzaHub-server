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
  // Better Auth's default session model name. The JWT plugin stores the id of
  // this record in each token so logout can revoke tokens immediately.
  SESSIONS: 'session',
  MENU_ITEMS: 'menuItems',
  // One document per vendor holds the atomically reserved free-plan item ids.
  MENU_SLOT_RESERVATIONS: 'menuSlotReservations',
  ORDERS: 'orders',
  TRANSACTIONS: 'transactions',
});

/** Accessors reuse the single connection pool opened during startup. */
export function getUsersCollection() {
  return getDb().collection(COLLECTIONS.USERS);
}

export function getSessionsCollection() {
  return getDb().collection(COLLECTIONS.SESSIONS);
}

export function getMenuItemsCollection() {
  return getDb().collection(COLLECTIONS.MENU_ITEMS);
}

export function getMenuSlotReservationsCollection() {
  return getDb().collection(COLLECTIONS.MENU_SLOT_RESERVATIONS);
}

export function getOrdersCollection() {
  return getDb().collection(COLLECTIONS.ORDERS);
}

export function getTransactionsCollection() {
  return getDb().collection(COLLECTIONS.TRANSACTIONS);
}
