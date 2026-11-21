import { ObjectId } from 'mongodb';

import {
  getMenuItemsCollection,
  getOrdersCollection,
} from '../../database/collections.js';
import { ApiError } from '../../utils/api-error.js';
import { MENU_STATUS } from '../menu/menu.validator.js';
import {
  ACTIVE_ORDER_STATUSES,
  ORDER_STATUS,
  validateCancelBody,
  validateCustomerOrderQuery,
  validateOrderCreate,
  validateOrderStatusUpdate,
  validateVendorOrderQuery,
} from './order.validator.js';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** The internal key is never returned by serializeOrder(). */
export const ORDER_LIST_PROJECTION = Object.freeze({ activeOrderKey: 0 });

/** Only the fields needed to build an immutable snapshot are loaded. */
export const ORDERABLE_MENU_PROJECTION = Object.freeze({
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

function buildObjectIdFilter(id, code) {
  if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) {
    throw ApiError.badRequest('Invalid id.', code);
  }

  return { _id: new ObjectId(id) };
}

/** Canonical order id validation. The same helper is used by all order routes. */
export function buildOrderIdFilter(id) {
  return buildObjectIdFilter(id, 'INVALID_ORDER_ID');
}

function requireActorId(id) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw ApiError.unauthorized('Authentication required.', 'UNAUTHORIZED');
  }

  return id;
}

/**
 * Deterministic key for the unique partial index. It exists only while an
 * order is active; rejection and cancellation unset it so a new order is allowed.
 */
export function buildActiveOrderKey(customerId, itemId, deliveryDate) {
  return `${String(customerId).toLowerCase()}:${String(itemId).toLowerCase()}:${deliveryDate}`;
}

/** MongoDB duplicate-key errors from insertOne are translated by the service. */
export function isDuplicateKeyError(error) {
  return (
    error?.code === 11000 ||
    error?.codeName === 'DuplicateKey' ||
    error?.writeErrors?.some?.((writeError) => writeError?.code === 11000) === true
  );
}

/**
 * Copy menu values into the order instead of referencing the live document.
 * The returned object is frozen for the lifetime of the in-memory request.
 */
export function buildItemSnapshot(menuItem) {
  const source = menuItem && typeof menuItem === 'object' ? menuItem : {};

  return Object.freeze({
    itemId: source._id?.toString?.() ?? source.id ?? undefined,
    itemName: source.itemName,
    category: source.category,
    description: source.description,
    price: source.price,
    location: source.location,
    images: Array.isArray(source.images) ? [...source.images] : [],
    menuStatus: source.status,
    menuIsAvailable: source.isAvailable !== false,
  });
}

/** Public API shape. activeOrderKey and any future private field stay hidden. */
export function serializeOrder(document) {
  const source = document && typeof document === 'object' ? document : {};
  const id = source._id?.toString?.() ?? source.id;
  const result = {
    id: id === undefined || id === null ? undefined : String(id),
    customerId: source.customerId,
    vendorId: source.vendorId,
    itemId: source.itemId,
    status: source.status,
    price: source.price,
    deliveryDate: source.deliveryDate,
    deliveryAddress: source.deliveryAddress,
    itemSnapshot: source.itemSnapshot
      ? {
          ...source.itemSnapshot,
          images: Array.isArray(source.itemSnapshot.images)
            ? [...source.itemSnapshot.images]
            : [],
        }
      : null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };

  if (Object.hasOwn(source, 'additionalMessage')) {
    result.additionalMessage = source.additionalMessage;
  }

  return result;
}

/**
 * MongoDB work for customer and vendor orders.
 *
 * Collections and the clock are injectable so tests use fake stores and never
 * contact Atlas. Production uses the existing shared collection accessors.
 */
export function createOrderService(dependencies = {}) {
  const ordersSource = dependencies.ordersCollection ?? dependencies.orders;
  const menuSource = dependencies.menuItemsCollection ?? dependencies.menuItems;
  const now = dependencies.now ?? (() => new Date());

  function getOrders() {
    if (typeof ordersSource === 'function') {
      return ordersSource();
    }

    return ordersSource ?? getOrdersCollection();
  }

  function getMenuItems() {
    if (typeof menuSource === 'function') {
      return menuSource();
    }

    return menuSource ?? getMenuItemsCollection();
  }

  async function listMine(customerId, query) {
    const actorId = requireActorId(customerId);
    const options = validateCustomerOrderQuery(query);
    const filter = { customerId: actorId };
    const collection = getOrders();

    const [totalItems, documents] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter)
        .project(ORDER_LIST_PROJECTION)
        .sort({ createdAt: -1, _id: -1 })
        .skip((options.page - 1) * options.limit)
        .limit(options.limit)
        .toArray(),
    ]);

    return {
      items: documents.map(serializeOrder),
      pagination: {
        page: options.page,
        limit: options.limit,
        totalItems,
        totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / options.limit),
      },
    };
  }

  async function getMine(customerId, id) {
    const actorId = requireActorId(customerId);
    const filter = { ...buildOrderIdFilter(id), customerId: actorId };
    const document = await getOrders().findOne(filter, { projection: ORDER_LIST_PROJECTION });

    if (!document) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }

    return serializeOrder(document);
  }

  async function create(customerId, body) {
    const actorId = requireActorId(customerId);
    const input = validateOrderCreate(body);
    const itemFilter = buildObjectIdFilter(input.itemId, 'INVALID_MENU_ID');

    // The menu record is authoritative for price, vendor, name and status.
    const menuItem = await getMenuItems().findOne(itemFilter, {
      projection: ORDERABLE_MENU_PROJECTION,
    });

    if (!menuItem) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    const vendorId = menuItem.vendorId?.toString?.() ?? menuItem.vendorId;

    if (!vendorId || String(vendorId).trim() === '') {
      throw ApiError.conflict('Menu item is not orderable.', 'MENU_ITEM_NOT_ORDERABLE');
    }

    if (String(vendorId) === actorId) {
      throw ApiError.forbidden('A vendor cannot order their own menu item.', 'FORBIDDEN');
    }

    if (menuItem.status !== MENU_STATUS.APPROVED || menuItem.isAvailable === false) {
      throw ApiError.conflict('Menu item is not orderable.', 'MENU_ITEM_NOT_ORDERABLE');
    }

    // Fast, readable check for the common case. The unique partial index below
    // is the authoritative guard when two requests race.
    const activeFilter = {
      customerId: actorId,
      itemId: input.itemId,
      deliveryDate: input.deliveryDate,
      status: { $in: [...ACTIVE_ORDER_STATUSES] },
    };
    const existing = await getOrders().findOne(activeFilter, { projection: { _id: 1 } });

    if (existing) {
      throw ApiError.conflict(
        'An active order already exists for this item and delivery date.',
        'ORDER_ALREADY_ACTIVE',
      );
    }

    const timestamp = now();
    const order = {
      _id: new ObjectId(),
      customerId: actorId,
      vendorId: String(vendorId),
      itemId: input.itemId,
      status: ORDER_STATUS.PENDING,
      price: menuItem.price,
      deliveryDate: input.deliveryDate,
      deliveryAddress: input.deliveryAddress,
      itemSnapshot: buildItemSnapshot(menuItem),
      activeOrderKey: buildActiveOrderKey(actorId, input.itemId, input.deliveryDate),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (Object.hasOwn(input, 'additionalMessage')) {
      order.additionalMessage = input.additionalMessage;
    }

    try {
      await getOrders().insertOne(order);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw ApiError.conflict(
          'An active order already exists for this item and delivery date.',
          'ORDER_ALREADY_ACTIVE',
        );
      }

      throw error;
    }

    return serializeOrder(order);
  }

  async function cancel(customerId, id, body) {
    const actorId = requireActorId(customerId);
    validateCancelBody(body);
    const idFilter = buildOrderIdFilter(id);
    const ownedFilter = { ...idFilter, customerId: actorId };
    const collection = getOrders();
    const existing = await collection.findOne(ownedFilter, { projection: ORDER_LIST_PROJECTION });

    if (!existing) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }

    if (existing.status !== ORDER_STATUS.PENDING) {
      throw ApiError.conflict('Only pending orders can be cancelled.', 'ORDER_NOT_CANCELLABLE');
    }

    const result = await collection.updateOne(
      { ...ownedFilter, status: ORDER_STATUS.PENDING },
      {
        $set: { status: ORDER_STATUS.CANCELLED, updatedAt: now() },
        $unset: { activeOrderKey: '' },
      },
    );

    if ((result?.matchedCount ?? 0) === 0) {
      throw ApiError.conflict('Only pending orders can be cancelled.', 'ORDER_NOT_CANCELLABLE');
    }

    const updated = await collection.findOne(ownedFilter, { projection: ORDER_LIST_PROJECTION });

    if (!updated) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }

    return serializeOrder(updated);
  }

  async function vendorList(vendorId, query) {
    const actorId = requireActorId(vendorId);
    const options = validateVendorOrderQuery(query);
    const filter = { vendorId: actorId };

    if (options.status) {
      filter.status = options.status;
    }

    const collection = getOrders();

    const [totalItems, documents] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter)
        .project(ORDER_LIST_PROJECTION)
        .sort({ createdAt: -1, _id: -1 })
        .skip((options.page - 1) * options.limit)
        .limit(options.limit)
        .toArray(),
    ]);

    return {
      items: documents.map(serializeOrder),
      pagination: {
        page: options.page,
        limit: options.limit,
        totalItems,
        totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / options.limit),
      },
    };
  }

  async function vendorUpdateStatus(vendorId, id, body) {
    const actorId = requireActorId(vendorId);
    const targetStatus = validateOrderStatusUpdate(body).status;
    const idFilter = buildOrderIdFilter(id);
    const ownedFilter = { ...idFilter, vendorId: actorId };
    const collection = getOrders();
    const existing = await collection.findOne(ownedFilter, { projection: ORDER_LIST_PROJECTION });

    if (!existing) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }

    if (existing.status !== ORDER_STATUS.PENDING) {
      throw ApiError.conflict('Only pending orders can be updated.', 'ORDER_NOT_PENDING');
    }

    // Accepted orders stay active and keep the duplicate key. Rejected orders
    // release it so the customer may place a fresh order for that date.
    const update = { $set: { status: targetStatus, updatedAt: now() } };

    if (targetStatus === ORDER_STATUS.REJECTED) {
      update.$unset = { activeOrderKey: '' };
    }

    const result = await collection.updateOne(
      { ...ownedFilter, status: ORDER_STATUS.PENDING },
      update,
    );

    if ((result?.matchedCount ?? 0) === 0) {
      throw ApiError.conflict('Only pending orders can be updated.', 'ORDER_NOT_PENDING');
    }

    const updated = await collection.findOne(ownedFilter, { projection: ORDER_LIST_PROJECTION });

    if (!updated) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }

    return serializeOrder(updated);
  }

  return Object.freeze({
    listMine,
    getMine,
    create,
    cancel,
    vendorList,
    vendorUpdateStatus,
  });
}
