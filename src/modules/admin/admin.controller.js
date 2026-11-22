import { ApiError } from '../../utils/api-error.js';

function currentAdminId(req) {
  const id = req.user?.id;

  if (typeof id !== 'string' || id.trim() === '') {
    throw ApiError.unauthorized('Authentication required.', 'UNAUTHORIZED');
  }

  return id;
}

/** Thin Express adapter. Authentication and the Admin role check run in the router. */
export function createAdminController(service) {
  return {
    async dashboardStats(_req, res, next) {
      try {
        return res.json(await service.getDashboardStats());
      } catch (error) {
        return next(error);
      }
    },

    async listUsers(req, res, next) {
      try {
        return res.json(await service.listUsers(req.query));
      } catch (error) {
        return next(error);
      }
    },

    async getUser(req, res, next) {
      try {
        return res.json(await service.getUser(req.params.id));
      } catch (error) {
        return next(error);
      }
    },

    async blockUser(req, res, next) {
      try {
        const result = await service.blockUser(req.params.id, currentAdminId(req), req.body);

        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async unblockUser(req, res, next) {
      try {
        const result = await service.unblockUser(req.params.id, currentAdminId(req), req.body);

        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async listTransactions(req, res, next) {
      try {
        return res.json(await service.listTransactions(req.query));
      } catch (error) {
        return next(error);
      }
    },
  };
}
