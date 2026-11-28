/**
 * Tiny in-memory stand-in for the menuSlotReservations collection.
 *
 * It evaluates only the query/update expressions used by createMenuSlotService.
 * Updates are synchronous, which models MongoDB's atomic findOneAndUpdate for
 * concurrency tests. Fake ids and records only; no Atlas connection or env.
 */

function valuesEqual(left, right) {
  if (left && typeof left.toString === 'function' && right && typeof right.toString === 'function') {
    return String(left) === String(right);
  }

  return left === right;
}

function evaluate(expression, document, variables = {}) {
  if (Array.isArray(expression)) {
    return expression.map((entry) => evaluate(entry, document, variables));
  }

  if (typeof expression === 'string' && expression.startsWith('$$')) {
    return variables[expression.slice(2)];
  }

  if (typeof expression === 'string' && expression.startsWith('$')) {
    return document[expression.slice(1)];
  }

  if (!expression || typeof expression !== 'object') {
    return expression;
  }

  if (Object.hasOwn(expression, '$size')) {
    const value = evaluate(expression.$size, document, variables);
    return Array.isArray(value) ? value.length : undefined;
  }

  if (Object.hasOwn(expression, '$ifNull')) {
    const value = evaluate(expression.$ifNull[0], document, variables);

    return value === undefined || value === null
      ? evaluate(expression.$ifNull[1], document, variables)
      : value;
  }

  if (Object.hasOwn(expression, '$lt')) {
    return evaluate(expression.$lt[0], document, variables) <
      evaluate(expression.$lt[1], document, variables);
  }

  if (Object.hasOwn(expression, '$in')) {
    const needle = evaluate(expression.$in[0], document, variables);
    const haystack = evaluate(expression.$in[1], document, variables);
    return Array.isArray(haystack) && haystack.some((entry) => valuesEqual(entry, needle));
  }

  if (Object.hasOwn(expression, '$not')) {
    return !evaluate(expression.$not, document, variables);
  }

  if (Object.hasOwn(expression, '$filter')) {
    const input = evaluate(expression.$filter.input, document, variables);
    const variable = expression.$filter.as;

    return Array.isArray(input)
      ? input.filter((entry) =>
          Boolean(evaluate(expression.$filter.cond, document, { ...variables, [variable]: entry })),
        )
      : [];
  }

  if (Object.hasOwn(expression, '$cond')) {
    const [condition, whenTrue, whenFalse] = expression.$cond;

    return evaluate(condition, document, variables)
      ? evaluate(whenTrue, document, variables)
      : evaluate(whenFalse, document, variables);
  }

  if (Object.hasOwn(expression, '$concatArrays')) {
    return expression.$concatArrays.flatMap((entry) => {
      const value = evaluate(entry, document, variables);
      return Array.isArray(value) ? value : [];
    });
  }

  return Object.fromEntries(
    Object.entries(expression).map(([key, value]) => [key, evaluate(value, document, variables)]),
  );
}

function matchesValue(expected, actual) {
  if (Array.isArray(actual) && !Array.isArray(expected)) {
    return actual.some((entry) => valuesEqual(entry, expected));
  }

  if (expected && typeof expected === 'object' && Object.hasOwn(expected, '$lt')) {
    return Number(actual) < Number(expected.$lt);
  }

  return valuesEqual(expected, actual);
}

function matches(filter, document) {
  return Object.entries(filter ?? {}).every(([key, expected]) => {
    if (key === '$or') {
      return expected.some((condition) => matches(condition, document));
    }

    if (key === '$and') {
      return expected.every((condition) => matches(condition, document));
    }

    if (key === '$expr') {
      return Boolean(evaluate(expected, document));
    }

    return matchesValue(expected, document[key]);
  });
}

function applyUpdate(document, update, isInsert = false) {
  if (Array.isArray(update)) {
    for (const stage of update) {
      if (stage?.$set) {
        for (const [field, expression] of Object.entries(stage.$set)) {
          document[field] = evaluate(expression, document);
        }
      }
    }

    return;
  }

  if (isInsert && update?.$setOnInsert) {
    Object.assign(document, update.$setOnInsert);
  }

  if (update?.$set) {
    Object.assign(document, update.$set);
  }

  for (const [field, value] of Object.entries(update?.$pull ?? {})) {
    if (!Array.isArray(document[field])) {
      continue;
    }

    document[field] = document[field].filter((entry) => {
      if (value && typeof value === 'object' && Array.isArray(value.$in)) {
        return !value.$in.some((candidate) => valuesEqual(candidate, entry));
      }

      return !valuesEqual(entry, value);
    });
  }
}

export function createFakeMenuSlots(initialDocuments = []) {
  const state = {
    documents: initialDocuments.map((document) => structuredClone(document)),
    calls: [],
  };

  function record(method, details) {
    state.calls.push({ method, ...details });
  }

  return {
    state,

    async findOne(filter) {
      record('findOne', { filter });

      return state.documents.find((document) => matches(filter, document)) ?? null;
    },

    async findOneAndUpdate(filter, update, options = {}) {
      record('findOneAndUpdate', { filter, update, options });
      const index = state.documents.findIndex((document) => matches(filter, document));

      if (index === -1) {
        return null;
      }

      const document = structuredClone(state.documents[index]);
      applyUpdate(document, update);
      state.documents[index] = document;

      return options.returnDocument === 'after' ? document : state.documents[index];
    },

    async updateOne(filter, update, options = {}) {
      record('updateOne', { filter, update, options });
      const index = state.documents.findIndex((document) => matches(filter, document));

      if (index === -1) {
        if (!options.upsert) {
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        }

        const document = { _id: filter._id };
        applyUpdate(document, update, true);
        state.documents.push(document);

        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: document._id };
      }

      const document = structuredClone(state.documents[index]);
      applyUpdate(document, update);
      state.documents[index] = document;

      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    },
  };
}
