import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMenuSlotService } from '../modules/menu/menu-slots.js';
import { createFakeMenuSlots } from './menu-slot-fake.js';

// Fake ids and in-memory records only. No .env values or Atlas connection.
const VENDOR_ID = '65b000000000000000000002';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/**
 * Make a reconciliation write wait for a concurrent reservation to land. The
 * underlying fake updates are atomic, so this models the real MongoDB race:
 * the reconciliation expression must read pending ids when the write executes,
 * not from an earlier snapshot.
 */
function interleavedCollection(slots, { reserveFinished }) {
  return {
    state: slots.state,

    async findOne(filter) {
      return slots.findOne(filter);
    },

    async findOneAndUpdate(filter, update, options) {
      const document = await slots.findOneAndUpdate(filter, update, options);
      reserveFinished.resolve();
      return document;
    },

    async updateOne(filter, update, options) {
      const isReconcileWrite =
        Array.isArray(update) && update.some((stage) => stage?.$set?.itemIds);

      if (isReconcileWrite) {
        await reserveFinished.promise;
      }

      return slots.updateOne(filter, update, options);
    },
  };
}

test('only three concurrent free-plan reservations can win a slot', async () => {
  const slots = createFakeMenuSlots();
  const service = createMenuSlotService({ collection: slots });

  const results = await Promise.allSettled(
    Array.from({ length: 4 }, (_, index) =>
      service.reserve({ vendorId: VENDOR_ID, itemId: `item-${index + 1}` }),
    ),
  );

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'MENU_ITEM_LIMIT_REACHED');
  assert.equal(slots.state.documents[0].itemIds.length, 3);
});

test('reserving the same item again is idempotent even when the list is full', async () => {
  const slots = createFakeMenuSlots();
  const service = createMenuSlotService({ collection: slots });

  for (let index = 0; index < 3; index += 1) {
    await service.reserve({ vendorId: VENDOR_ID, itemId: `item-${index + 1}` });
  }

  assert.equal(await service.has(VENDOR_ID, 'item-1'), true);
  await service.reserve({ vendorId: VENDOR_ID, itemId: 'item-1' });
  assert.deepEqual(slots.state.documents[0].itemIds, ['item-1', 'item-2', 'item-3']);
});

test('releasing a reservation frees the slot for a different item', async () => {
  const slots = createFakeMenuSlots();
  const service = createMenuSlotService({ collection: slots });

  for (let index = 0; index < 3; index += 1) {
    await service.reserve({ vendorId: VENDOR_ID, itemId: `item-${index + 1}` });
  }

  await assert.rejects(() => service.reserve({ vendorId: VENDOR_ID, itemId: 'item-4' }), {
    code: 'MENU_ITEM_LIMIT_REACHED',
  });

  await service.release(VENDOR_ID, 'item-2');
  await service.reserve({ vendorId: VENDOR_ID, itemId: 'item-4' });

  assert.equal(await service.has(VENDOR_ID, 'item-2'), false);
  assert.equal(await service.has(VENDOR_ID, 'item-4'), true);
});

test('premium vendors can reserve beyond the free-plan limit', async () => {
  const slots = createFakeMenuSlots();
  const service = createMenuSlotService({ collection: slots });

  for (let index = 0; index < 4; index += 1) {
    await service.reserve({ vendorId: VENDOR_ID, itemId: `premium-${index + 1}`, unlimited: true });
  }

  assert.equal(slots.state.documents[0].itemIds.length, 4);
});

test('reconciliation replaces stale and truncated reservation ids', async () => {
  const slots = createFakeMenuSlots([
    { _id: VENDOR_ID, itemIds: ['deleted-item', 'still-active', 'ghost'.slice(0, 2)] },
  ]);
  const service = createMenuSlotService({ collection: slots });

  await service.reconcile(VENDOR_ID, ['still-active', 'new-item']);

  assert.deepEqual(slots.state.documents[0].itemIds, ['still-active', 'new-item']);
  assert.equal(await service.has(VENDOR_ID, 'deleted-item'), false);
  assert.equal(await service.has(VENDOR_ID, 'new-item'), true);
});

test('reconciliation preserves in-flight reservations until they are confirmed', async () => {
  const slots = createFakeMenuSlots();
  const service = createMenuSlotService({ collection: slots });

  for (let index = 1; index <= 3; index += 1) {
    await service.reserve({ vendorId: VENDOR_ID, itemId: `in-flight-${index}`, pending: true });
  }

  // The menu documents are not inserted yet; a concurrent reconciliation must
  // not mistake these reserved slots for stale ids.
  await service.reconcile(VENDOR_ID, []);

  assert.deepEqual(slots.state.documents[0].itemIds, [
    'in-flight-1',
    'in-flight-2',
    'in-flight-3',
  ]);
  await assert.rejects(() => service.reserve({ vendorId: VENDOR_ID, itemId: 'item-4' }), {
    code: 'MENU_ITEM_LIMIT_REACHED',
  });

  await service.confirm(VENDOR_ID, 'in-flight-1');
  await service.reconcile(VENDOR_ID, ['in-flight-1', 'in-flight-2', 'in-flight-3']);

  assert.deepEqual(slots.state.documents[0].pendingItemIds, ['in-flight-2', 'in-flight-3']);
  assert.equal(await service.has(VENDOR_ID, 'in-flight-1'), true);
});

test('forced reconciliation removes a stale id from both reservation fields', async () => {
  const slots = createFakeMenuSlots();
  const service = createMenuSlotService({ collection: slots });

  await service.reserve({ vendorId: VENDOR_ID, itemId: 'deleted-item', pending: true });
  await service.reconcile(VENDOR_ID, [], { forceRemoveItemIds: ['deleted-item'] });

  assert.deepEqual(slots.state.documents[0].itemIds, []);
  assert.deepEqual(slots.state.documents[0].pendingItemIds, []);

  // A later reconcile must not re-add the forced id from the stale marker.
  await service.reconcile(VENDOR_ID, []);
  assert.equal(await service.has(VENDOR_ID, 'deleted-item'), false);
});

test('a reservation racing reconciliation cannot be dropped from the slot count', async () => {
  const slots = createFakeMenuSlots([
    { _id: VENDOR_ID, itemIds: ['item-1', 'item-2'], pendingItemIds: [] },
  ]);
  const reserveFinished = deferred();
  const service = createMenuSlotService({
    collection: interleavedCollection(slots, { reserveFinished }),
  });

  const [, reserved] = await Promise.all([
    service.reconcile(VENDOR_ID, ['item-1', 'item-2']),
    service.reserve({ vendorId: VENDOR_ID, itemId: 'in-flight-3', pending: true }),
  ]);

  assert.equal(reserved, true);
  assert.deepEqual(slots.state.documents[0].itemIds, ['item-1', 'item-2', 'in-flight-3']);
  assert.deepEqual(slots.state.documents[0].pendingItemIds, ['in-flight-3']);

  // The freed slot was consumed by the in-flight item, not by a fourth item.
  await assert.rejects(() => service.reserve({ vendorId: VENDOR_ID, itemId: 'item-4' }), {
    code: 'MENU_ITEM_LIMIT_REACHED',
  });
});

test('forced reconciliation after hide/reject/delete keeps concurrent reservations', async () => {
  const slots = createFakeMenuSlots([
    { _id: VENDOR_ID, itemIds: ['hidden-item', 'item-2'], pendingItemIds: [] },
  ]);
  const reserveFinished = deferred();
  const service = createMenuSlotService({
    collection: interleavedCollection(slots, { reserveFinished }),
  });

  const [, reserved] = await Promise.all([
    service.reconcile(VENDOR_ID, ['item-2'], { forceRemoveItemIds: ['hidden-item'] }),
    service.reserve({ vendorId: VENDOR_ID, itemId: 'in-flight-3', pending: true }),
  ]);

  assert.equal(reserved, true);
  assert.deepEqual(slots.state.documents[0].itemIds, ['item-2', 'in-flight-3']);
  assert.deepEqual(slots.state.documents[0].pendingItemIds, ['in-flight-3']);
  assert.equal(await service.has(VENDOR_ID, 'hidden-item'), false);

  // Hiding the stale item legitimately frees one slot; the in-flight item and
  // exactly one replacement may use the capacity, but not a fourth consumer.
  await service.reserve({ vendorId: VENDOR_ID, itemId: 'item-4' });
  await assert.rejects(() => service.reserve({ vendorId: VENDOR_ID, itemId: 'item-5' }), {
    code: 'MENU_ITEM_LIMIT_REACHED',
  });
});
