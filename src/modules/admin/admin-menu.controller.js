/**
 * Thin Express adapter for Admin menu routes.
 *
 * Authentication and `requireRole('admin')` run in the router, so req.user came
 * from the MongoDB user record. No role or user data is read from the request
 * body here.
 */
export function createAdminMenuController(service) {
  return {
    async list(req, res, next) {
      try {
        const result = await service.listAdmin(req.query);

        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async moderate(req, res, next) {
      try {
        const item = await service.moderate(req.params.id, req.body);

        return res.json({ item });
      } catch (error) {
        return next(error);
      }
    },

    async remove(req, res, next) {
      try {
        await service.remove(req.params.id);

        return res.status(204).end();
      } catch (error) {
        return next(error);
      }
    },
  };
}
