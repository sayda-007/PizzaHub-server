import { Transform } from 'node:stream';

import multer from 'multer';

import { ApiError } from '../utils/api-error.js';

/**
 * ImgBB integration and upload limits.
 *
 * Multer parses `multipart/form-data` into memory buffers. The buffers are sent
 * straight to ImgBB with Node's built-in fetch and are never written to disk or
 * accepted as plain client-supplied URLs.
 */

/** Official ImgBB v1 upload endpoint (POST with multipart/form-data). */
export const IMGBB_UPLOAD_URL = 'https://api.imgbb.com/1/upload';

/**
 * 3 MB per file: below ImgBB's 32 MB ceiling and below Vercel's 4.5 MB request
 * body limit when a single maximum-size image is uploaded.
 */
export const MAX_IMAGE_FILE_SIZE_BYTES = 3 * 1024 * 1024;

/**
 * Keep the whole multipart request under Vercel's standard 4.5 MB limit, with
 * a small margin for boundary and field headers. Requests above the platform
 * limit are rejected by Vercel before Express runs.
 */
export const MAX_UPLOAD_BODY_SIZE_BYTES = 4 * 1024 * 1024;

/** Bound a slow or stalled ImgBB request without exposing fetch error details. */
export const IMGBB_UPLOAD_TIMEOUT_MS = 10_000;

/** Three images per menu item keeps a single request small and predictable. */
export const MAX_IMAGES_PER_ITEM = 3;

/** Text fields for create: itemName, category, description, price, location. */
const MAX_UPLOAD_FIELDS = 8;

export const ALLOWED_IMAGE_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const EXPECTED_FILE_FIELD = 'images';

const JPEG_SIGNATURE_PREFIX = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Inspect the bytes themselves; file.mimetype alone is client-supplied text. */
function detectImageMimeType(buffer) {
  if (
    buffer.length >= JPEG_SIGNATURE_PREFIX.length &&
    buffer.subarray(0, JPEG_SIGNATURE_PREFIX.length).equals(JPEG_SIGNATURE_PREFIX)
  ) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return 'image/png';
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (buffer.length >= 6) {
    const gifHeader = buffer.toString('ascii', 0, 6);

    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
      return 'image/gif';
    }
  }

  return null;
}

/** Example-file values must never be sent to ImgBB as if they were credentials. */
const PLACEHOLDER_API_KEY = /(replace[-_]?with|your[-_]|change[-_]?me|placeholder|dummy|fake|paste[-_]|todo|xxx|<[^>]+>)/i;

function isPlaceholderApiKey(value) {
  return typeof value !== 'string' || value.trim() === '' || PLACEHOLDER_API_KEY.test(value.trim());
}

/** Use only the final path segment and never echo it in an error message. */
function safeFileName(value) {
  const base = typeof value === 'string' ? value.replace(/^.*[\\/]/, '') : '';

  return base.slice(0, 120) || 'menu-image';
}

const IMGBB_CDN_HOSTS = Object.freeze(['i.ibb.co']);

/** Only URLs returned by the ImgBB CDN may become trusted menu images. */
export function isTrustedMenuImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    return false;
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    return (
      parsed.protocol === 'https:' &&
      IMGBB_CDN_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
    );
  } catch {
    return false;
  }
}

function safeProtocolUrl(value) {
  return isTrustedMenuImageUrl(value) ? value : null;
}

/**
 * Validate Multer's file objects before any network call. This is duplicated
 * deliberately: Multer enforces the same limits while parsing, but the upload
 * service must still be safe when called directly in tests or from new code.
 */
export function validateUploadedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw ApiError.badRequest('At least one image file is required.', 'IMAGE_REQUIRED');
  }

  if (files.length > MAX_IMAGES_PER_ITEM) {
    throw ApiError.badRequest(
      `At most ${MAX_IMAGES_PER_ITEM} images are allowed per menu item.`,
      'TOO_MANY_FILES',
    );
  }

  for (const file of files) {
    if (!file || typeof file !== 'object' || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw ApiError.badRequest('Uploaded images must be non-empty files.', 'INVALID_FILE');
    }

    if (Object.hasOwn(file, 'fieldname') && file.fieldname !== EXPECTED_FILE_FIELD) {
      throw ApiError.badRequest('Unexpected upload field.', 'INVALID_UPLOAD');
    }

    const mimeType = typeof file.mimetype === 'string' ? file.mimetype.toLowerCase() : '';

    if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
      throw ApiError.badRequest(
        'Only JPEG, PNG, WebP and GIF images are accepted.',
        'INVALID_FILE_TYPE',
      );
    }

    const size = Number.isFinite(file.size) ? file.size : file.buffer.length;

    if (size > MAX_IMAGE_FILE_SIZE_BYTES || file.buffer.length > MAX_IMAGE_FILE_SIZE_BYTES) {
      throw ApiError.payloadTooLarge(
        `Each image must be ${MAX_IMAGE_FILE_SIZE_BYTES / (1024 * 1024)} MB or smaller.`,
        'FILE_TOO_LARGE',
      );
    }

    const detectedMimeType = detectImageMimeType(file.buffer);

    if (!detectedMimeType) {
      throw ApiError.badRequest(
        'Uploaded file is not a recognized image.',
        'INVALID_FILE_CONTENT',
      );
    }

    if (detectedMimeType !== mimeType) {
      throw ApiError.badRequest(
        'Uploaded file content does not match its image type.',
        'INVALID_FILE_CONTENT',
      );
    }
  }

  return files;
}

function bodyTooLargeError() {
  return ApiError.payloadTooLarge(
    `Upload request must be ${MAX_UPLOAD_BODY_SIZE_BYTES / (1024 * 1024)} MB or smaller.`,
    'PAYLOAD_TOO_LARGE',
  );
}

/**
 * Count the real bytes delivered by a chunked request. `Content-Length` can be
 * absent or understated, so relying on the declared value alone is not enough.
 */
export function createBodySizeGuard(dependencies = {}) {
  const limit = dependencies.limit ?? MAX_UPLOAD_BODY_SIZE_BYTES;

  return function streamHandler(req, busboy) {
    let received = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;

        if (received > limit) {
          callback(bodyTooLargeError());
          return;
        }

        callback(null, chunk);
      },
    });

    counter.on('error', (error) => busboy.destroy(error));
    req.pipe(counter).pipe(busboy);
  };
}

/** Multer accepts only image files and stops oversized/count abuse early. */
export function createImageUploader(dependencies = {}) {
  const multerLib = dependencies.multer ?? multer;

  const parser = multerLib({
    storage: multerLib.memoryStorage(),
    streamHandler: dependencies.streamHandler ?? createBodySizeGuard(),
    limits: {
      fileSize: MAX_IMAGE_FILE_SIZE_BYTES,
      files: MAX_IMAGES_PER_ITEM,
      fields: MAX_UPLOAD_FIELDS,
      parts: MAX_IMAGES_PER_ITEM + MAX_UPLOAD_FIELDS,
      fieldNameSize: 100,
      fieldSize: 10_000,
      fieldNestingDepth: 1,
      fieldArrayIndexLimit: 0,
    },
    fileFilter(_req, file, callback) {
      const mimeType = typeof file?.mimetype === 'string' ? file.mimetype.toLowerCase() : '';

      if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
        return callback(
          ApiError.badRequest(
            'Only JPEG, PNG, WebP and GIF images are accepted.',
            'INVALID_FILE_TYPE',
          ),
        );
      }

      return callback(null, true);
    },
  }).array(EXPECTED_FILE_FIELD, MAX_IMAGES_PER_ITEM);

  return function uploadImagesMiddleware(req, res, next) {
    const declaredLength = Number(req.headers?.['content-length']);

    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BODY_SIZE_BYTES) {
      return next(
        ApiError.payloadTooLarge(
          `Upload request must be ${MAX_UPLOAD_BODY_SIZE_BYTES / (1024 * 1024)} MB or smaller.`,
          'PAYLOAD_TOO_LARGE',
        ),
      );
    }

    return parser(req, res, (error) => {
      if (!error) {
        return next();
      }

      if (error instanceof multerLib.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return next(
            ApiError.payloadTooLarge(
              `Each image must be ${MAX_IMAGE_FILE_SIZE_BYTES / (1024 * 1024)} MB or smaller.`,
              'FILE_TOO_LARGE',
            ),
          );
        }

        if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
          return next(
            ApiError.badRequest(
              `At most ${MAX_IMAGES_PER_ITEM} images are allowed per menu item.`,
              'TOO_MANY_FILES',
            ),
          );
        }

        return next(ApiError.badRequest('Invalid image upload.', 'INVALID_UPLOAD'));
      }

      // ApiError from fileFilter is safe; anything else reaches the central
      // handler unchanged so it becomes a generic 500 without raw details.
      return next(error);
    });
  };
}

/**
 * Build the ImgBB uploader.
 *
 * `fetch` and the endpoint are injectable so tests never make a network call.
 * Errors are converted to ApiError with fixed messages: the API key, response
 * body and fetch error text are never logged or returned to the client.
 */
export function createImgbbUploader(env, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const uploadUrl = dependencies.uploadUrl ?? IMGBB_UPLOAD_URL;
  const timeoutMs = dependencies.timeoutMs ?? IMGBB_UPLOAD_TIMEOUT_MS;
  const AbortControllerImpl = dependencies.AbortController ?? globalThis.AbortController;

  async function uploadOne(file) {
    const apiKey = env?.IMGBB_API_KEY;

    if (isPlaceholderApiKey(apiKey)) {
      throw new ApiError(
        500,
        'Image upload is not configured.',
        'IMAGE_UPLOAD_UNAVAILABLE',
      );
    }

    const form = new FormData();
    form.append('key', apiKey.trim());
    form.append(
      'image',
      new Blob([file.buffer], { type: file.mimetype.toLowerCase() }),
      safeFileName(file.originalname),
    );

    let response;
    let payload;
    const controller = new AbortControllerImpl();

    // Keep the deadline active through the body read as well. Headers can
    // arrive quickly while a malicious or broken server stalls the JSON stream.
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      response = await fetchImpl(uploadUrl, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });

      if (!response?.ok) {
        throw new ApiError(502, 'Image upload failed. Please try again.', 'IMAGE_UPLOAD_FAILED');
      }

      payload = await response.json();
    } catch {
      throw new ApiError(502, 'Image upload failed. Please try again.', 'IMAGE_UPLOAD_FAILED');
    } finally {
      clearTimeout(timer);
    }

    const imageUrl = safeProtocolUrl(payload?.data?.url ?? payload?.data?.display_url);

    if (payload?.success !== true || !imageUrl) {
      throw new ApiError(502, 'Image upload failed. Please try again.', 'IMAGE_UPLOAD_FAILED');
    }

    return imageUrl;
  }

  async function uploadImages(files) {
    const acceptedFiles = validateUploadedFiles(files);

    return Promise.all(acceptedFiles.map(uploadOne));
  }

  return Object.freeze({ uploadImages });
}
