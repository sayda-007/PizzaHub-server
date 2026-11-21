import { ApiError } from '../../utils/api-error.js';
import { validateMenuCreate } from './menu.validator.js';

/**
 * Thin Express adapter for vendor menu management.
 *
 * `authenticate` verifies the Bearer JWT and loads the current user from
 * MongoDB; `requireRole('vendor')` then guards every route in this module. The
 * controller only reads req.user.id and never trusts a client-supplied id.
 */
export function createMenuController(service, imageUploader) {
  function currentVendorId(req) {
    const id = req.user?.id;

    if (typeof id !== 'string' || id.trim() === '') {
      throw ApiError.unauthorized('Authentication required.', 'UNAUTHORIZED');
    }

    return id;
  }

  return {
    async create(req, res, next) {
      try {
        const vendorId = currentVendorId(req);
        const validatedData = validateMenuCreate(req.body);

        // Upload only after the text fields are valid. The uploader validates
        // file type/size/count and returns only ImgBB's direct image URLs.
        const imageUrls = await imageUploader.uploadImages(req.files ?? []);

        const item = await service.create(vendorId, validatedData, imageUrls);

        return res.status(201).json({ item });
      } catch (error) {
        return next(error);
      }
    },

    async listMine(req, res, next) {
      try {
        const vendorId = currentVendorId(req);
        const result = await service.listMine(vendorId, req.query);

        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async update(req, res, next) {
      try {
        const vendorId = currentVendorId(req);
        const item = await service.update(vendorId, req.params.id, req.body);

        return res.json({ item });
      } catch (error) {
        return next(error);
      }
    },

    async toggleAvailability(req, res, next) {
      try {
        const vendorId = currentVendorId(req);
        const item = await service.toggleAvailability(vendorId, req.params.id);

        return res.json({ item });
      } catch (error) {
        return next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const vendorId = currentVendorId(req);
        await service.remove(vendorId, req.params.id);

        return res.status(204).end();
      } catch (error) {
        return next(error);
      }
    },
  };
}
