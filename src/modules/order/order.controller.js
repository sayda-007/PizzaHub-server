import { ApiError } from '../../utils/api-error.js';

/**
 * Thin Express adapter for customer and vendor order routes.
 *
 * Authentication and role checks run in the router. The id below comes from
 * req.user, which authenticate fills from the MongoDB user document; client
 * role claims and body fields are never used as identity.
 */
export function createOrderController(service) {
  function currentUser(req) {
    const user = req.user;

    if (!user || typeof user.id !== 'string' || user.id.trim() === '') {
      throw ApiError.unauthorized('Authentication required.', 'UNAUTHORIZED');
    }

    return user;
  }

  return {
    async create(req, res, next) {
      try {
        const order = await service.create(currentUser(req).id, req.body);

        return res.status(201).json({ order });
      } catch (error) {
        return next(error);
      }
    },

    async listMine(req, res, next) {
      try {
        const result = await service.listMine(currentUser(req).id, req.query);

        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async getMine(req, res, next) {
      try {
        const order = await service.getMine(currentUser(req).id, req.params.id);

        return res.json({ order });
      } catch (error) {
        return next(error);
      }
    },

    async cancel(req, res, next) {
      try {
        const order = await service.cancel(currentUser(req).id, req.params.id, req.body);

        return res.json({ order });
      } catch (error) {
        return next(error);
      }
    },

    async vendorList(req, res, next) {
      try {
        const result = await service.vendorList(currentUser(req).id, req.query);

        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async vendorUpdateStatus(req, res, next) {
      try {
        const order = await service.vendorUpdateStatus(
          currentUser(req).id,
          req.params.id,
          req.body,
        );

        return res.json({ order });
      } catch (error) {
        return next(error);
      }
    },
  };
}
