import { validateUploadedFiles } from '../../services/imgbb.js';
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
  /**
   * `authenticate` fills req.user from the MongoDB user record, so this object
   * carries the current server-owned subscription state. JWT claims are ignored.
   */
  function currentVendor(req) {
    const user = req.user;

    if (!user || typeof user.id !== 'string' || user.id.trim() === '') {
      throw ApiError.unauthorized('Authentication required.', 'UNAUTHORIZED');
    }

    return user;
  }

  return {
    async create(req, res, next) {
      try {
        const vendor = currentVendor(req);
        const vendorId = vendor.id;
        const validatedData = validateMenuCreate(req.body);

        // Reject bad files before any database or ImgBB work. The uploader
        // repeats this check when it builds the ImgBB request.
        validateUploadedFiles(req.files ?? []);

        // Check the DB-backed subscription before spending an ImgBB upload.
        // The service repeats the check so the database boundary stays safe.
        if (typeof service.assertCanCreate === 'function') {
          await service.assertCanCreate(vendorId, vendor);
        }

        // Upload only after the text fields and slot limit are valid. The
        // uploader validates file type/size/count and returns only ImgBB URLs.
        const imageUrls = await imageUploader.uploadImages(req.files ?? []);

        const item = await service.create(vendorId, validatedData, imageUrls, vendor);

        return res.status(201).json({ item });
      } catch (error) {
        return next(error);
      }
    },

    async listMine(req, res, next) {
      try {
        const vendorId = currentVendor(req).id;
        const result = await service.listMine(vendorId, req.query);

        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async update(req, res, next) {
      try {
        const vendorId = currentVendor(req).id;
        const item = await service.update(vendorId, req.params.id, req.body);

        return res.json({ item });
      } catch (error) {
        return next(error);
      }
    },

    async toggleAvailability(req, res, next) {
      try {
        const vendor = currentVendor(req);
        const item = await service.toggleAvailability(vendor.id, req.params.id, vendor);

        return res.json({ item });
      } catch (error) {
        return next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const vendorId = currentVendor(req).id;
        await service.remove(vendorId, req.params.id);

        return res.status(204).end();
      } catch (error) {
        return next(error);
      }
    },
  };
}
