import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';

import {
  createBodySizeGuard,
  createImageUploader,
  createImgbbUploader,
  IMGBB_UPLOAD_TIMEOUT_MS,
  MAX_IMAGE_FILE_SIZE_BYTES,
  MAX_IMAGES_PER_ITEM,
  MAX_UPLOAD_BODY_SIZE_BYTES,
  validateUploadedFiles,
} from '../services/imgbb.js';

// Fake credentials only. This suite never reads .env or makes a network call.
const API_KEY = 'imgbb-test-key-123456';
const IMAGE_URL = 'https://i.ibb.co/test/pizza.png';

const SIGNATURES = Object.freeze({
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBP'),
  ]),
  'image/gif': Buffer.from('GIF89a'),
});

function signedBuffer(mimeType) {
  const signature = SIGNATURES[mimeType];

  return Buffer.concat([signature, Buffer.alloc(Math.max(0, 32 - signature.length))]);
}

function makeFile(overrides = {}) {
  const buffer = overrides.buffer ?? signedBuffer('image/png');
  const file = {
    fieldname: 'images',
    originalname: 'pizza.png',
    mimetype: 'image/png',
    size: buffer.length,
    buffer,
    ...overrides,
  };

  if (!Object.hasOwn(overrides, 'size')) {
    file.size = buffer.length;
  }

  return file;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class FakeMulterError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MulterError';
    this.code = code;
  }
}

function fakeMulterFactory({ error = null, onParse = () => {} } = {}) {
  function factory() {
    return {
      array: () => (req, _res, callback) => {
        onParse(req);
        callback(error);
      },
    };
  }

  factory.memoryStorage = () => ({});
  factory.MulterError = FakeMulterError;
  return factory;
}

function runUploadMiddleware(middleware, req = { headers: {} }) {
  let forwarded = null;

  middleware(req, {}, (error) => {
    forwarded = error;
  });

  return { forwarded };
}

test('validateUploadedFiles rejects missing, wrong-type, oversized and excess files', () => {
  assert.throws(() => validateUploadedFiles([]), { code: 'IMAGE_REQUIRED' });

  assert.throws(
    () => validateUploadedFiles([makeFile({ mimetype: 'text/plain' })]),
    { code: 'INVALID_FILE_TYPE' },
  );

  assert.throws(
    () => validateUploadedFiles([makeFile({ size: MAX_IMAGE_FILE_SIZE_BYTES + 1 })]),
    (error) => {
      assert.equal(error.code, 'FILE_TOO_LARGE');
      assert.equal(error.statusCode, 413);
      return true;
    },
  );

  assert.throws(
    () => validateUploadedFiles(Array.from({ length: MAX_IMAGES_PER_ITEM + 1 }, makeFile)),
    { code: 'TOO_MANY_FILES' },
  );

  assert.throws(
    () => validateUploadedFiles([makeFile({ fieldname: 'avatar' })]),
    { code: 'INVALID_UPLOAD' },
  );

  const accepted = validateUploadedFiles([makeFile()]);
  assert.equal(accepted.length, 1);
});

test('validateUploadedFiles accepts correctly signed images with matching MIME types', () => {
  for (const mimeType of Object.keys(SIGNATURES)) {
    const files = validateUploadedFiles([
      makeFile({ buffer: signedBuffer(mimeType), mimetype: mimeType }),
    ]);

    assert.equal(files.length, 1);
  }
});

test('declared oversized multipart requests are rejected before parsing', () => {
  let parsed = false;

  const middleware = createImageUploader({
    multer: fakeMulterFactory({
      onParse: () => {
        parsed = true;
      },
    }),
  });

  const { forwarded } = runUploadMiddleware(middleware, {
    headers: { 'content-length': String(MAX_UPLOAD_BODY_SIZE_BYTES + 1) },
  });

  assert.equal(parsed, false);
  assert.equal(forwarded.statusCode, 413);
  assert.equal(forwarded.code, 'PAYLOAD_TOO_LARGE');
});

test('Multer LIMIT_FILE_SIZE becomes a structured 413 FILE_TOO_LARGE', () => {
  const middleware = createImageUploader({
    multer: fakeMulterFactory({ error: new FakeMulterError('LIMIT_FILE_SIZE') }),
  });

  const { forwarded } = runUploadMiddleware(middleware);

  assert.equal(forwarded.statusCode, 413);
  assert.equal(forwarded.code, 'FILE_TOO_LARGE');
});

test('validateUploadedFiles rejects text bytes claiming to be PNG', () => {
  assert.throws(
    () => validateUploadedFiles([makeFile({ buffer: Buffer.from('ordinary text file') })]),
    { code: 'INVALID_FILE_CONTENT' },
  );
});

test('validateUploadedFiles rejects PNG/JPEG signature and MIME mismatches', () => {
  assert.throws(
    () =>
      validateUploadedFiles([
        makeFile({ buffer: signedBuffer('image/png'), mimetype: 'image/jpeg' }),
      ]),
    { code: 'INVALID_FILE_CONTENT' },
  );

  assert.throws(
    () =>
      validateUploadedFiles([
        makeFile({ buffer: signedBuffer('image/jpeg'), mimetype: 'image/png' }),
      ]),
    { code: 'INVALID_FILE_CONTENT' },
  );
});

test('invalid file content is rejected before any ImgBB fetch occurs', async () => {
  const fetchCalls = [];
  const uploader = createImgbbUploader(
    { IMGBB_API_KEY: API_KEY },
    {
      fetch: async () => {
        fetchCalls.push('called');

        return jsonResponse({ success: true, data: { url: IMAGE_URL } });
      },
    },
  );

  await assert.rejects(
    () => uploader.uploadImages([makeFile({ buffer: Buffer.from('not an image') })]),
    { code: 'INVALID_FILE_CONTENT' },
  );

  assert.deepEqual(fetchCalls, []);
});

test('ImgBB uploader rejects a missing or placeholder API key before any fetch', async () => {
  const calls = [];
  const missingUploader = createImgbbUploader(
    {},
    {
      fetch: async () => {
        calls.push('called');
        throw new Error('must not be reached');
      },
    },
  );

  await assert.rejects(() => missingUploader.uploadImages([makeFile()]), {
    code: 'IMAGE_UPLOAD_UNAVAILABLE',
    message: 'Image upload is not configured.',
  });

  const placeholderUploader = createImgbbUploader(
    { IMGBB_API_KEY: 'replace-with-imgbb-api-key' },
    {
      fetch: async () => {
        calls.push('called');
        throw new Error('must not be reached');
      },
    },
  );

  await assert.rejects(() => placeholderUploader.uploadImages([makeFile()]), {
    code: 'IMAGE_UPLOAD_UNAVAILABLE',
  });

  assert.deepEqual(calls, []);
});

test('ImgBB uploader sends multipart files with built-in fetch and stores only the returned URL', async () => {
  const calls = [];
  const uploader = createImgbbUploader(
    { IMGBB_API_KEY: API_KEY },
    {
      fetch: async (url, options) => {
        calls.push({ url, options });

        return jsonResponse({
          success: true,
          status: 200,
          data: { url: IMAGE_URL, display_url: 'https://ibb.co/test' },
        });
      },
    },
  );

  const urls = await uploader.uploadImages([makeFile()]);

  assert.deepEqual(urls, [IMAGE_URL]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.ok(!String(calls[0].url).includes(API_KEY));

  const form = calls[0].options.body;
  assert.equal(form.get('key'), API_KEY);
  assert.equal(form.get('image').name, 'pizza.png');
  assert.equal(form.get('image').type, 'image/png');
});

test('ImgBB fetch failures and API errors are safe and never include the key', async () => {
  const networkUploader = createImgbbUploader(
    { IMGBB_API_KEY: API_KEY },
    {
      fetch: async () => {
        throw new Error(`request to key=${API_KEY} failed`);
      },
    },
  );

  await assert.rejects(() => networkUploader.uploadImages([makeFile()]), (error) => {
    assert.equal(error.code, 'IMAGE_UPLOAD_FAILED');
    assert.equal(error.message, 'Image upload failed. Please try again.');
    assert.ok(!error.message.includes(API_KEY));
    return true;
  });

  const apiUploader = createImgbbUploader(
    { IMGBB_API_KEY: API_KEY },
    {
      fetch: async () => jsonResponse({ success: false, error: { message: 'Invalid key' } }, 400),
    },
  );

  await assert.rejects(() => apiUploader.uploadImages([makeFile()]), {
    code: 'IMAGE_UPLOAD_FAILED',
    message: 'Image upload failed. Please try again.',
  });
});

test('ImgBB uploader rejects a returned URL from another host', async () => {
  const uploader = createImgbbUploader(
    { IMGBB_API_KEY: API_KEY },
    {
      fetch: async () =>
        jsonResponse({ success: true, status: 200, data: { url: 'https://evil.example/pizza.png' } }),
    },
  );

  await assert.rejects(() => uploader.uploadImages([makeFile()]), {
    code: 'IMAGE_UPLOAD_FAILED',
  });
});

test('ImgBB uploader rejects a returned URL that is not http or https', async () => {
  const uploader = createImgbbUploader(
    { IMGBB_API_KEY: API_KEY },
    {
      fetch: async () =>
        jsonResponse({ success: true, status: 200, data: { url: 'javascript:alert(1)' } }),
    },
  );

  await assert.rejects(() => uploader.uploadImages([makeFile()]), {
    code: 'IMAGE_UPLOAD_FAILED',
  });
});

test('chunked upload bodies over the real byte limit are rejected while streaming', async () => {
  assert.ok(IMGBB_UPLOAD_TIMEOUT_MS > 0);

  const request = new PassThrough();
  let deliveredBytes = 0;
  const busboy = new Writable({
    write(chunk, _encoding, callback) {
      deliveredBytes += chunk.length;
      callback();
    },
  });
  const busboyError = new Promise((resolve) => busboy.once('error', resolve));

  createBodySizeGuard({ limit: 10 })(request, busboy);
  request.write(Buffer.alloc(6));
  request.write(Buffer.alloc(6));

  const error = await busboyError;

  assert.equal(error.statusCode, 413);
  assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
  assert.ok(deliveredBytes <= 10);
});

test('an ImgBB fetch timeout becomes the same safe upload failure', async () => {
  let signal;
  const uploader = createImgbbUploader(
    { IMGBB_API_KEY: API_KEY },
    {
      timeoutMs: 5,
      fetch: (_url, options) => {
        signal = options.signal;

        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by test')), {
            once: true,
          });
        });
      },
    },
  );

  await assert.rejects(() => uploader.uploadImages([makeFile()]), {
    code: 'IMAGE_UPLOAD_FAILED',
    message: 'Image upload failed. Please try again.',
  });

  assert.equal(signal.aborted, true);
});

test('an ImgBB response body timeout becomes the same safe upload failure', async () => {
  let signal;
  const uploader = createImgbbUploader(
    { IMGBB_API_KEY: API_KEY },
    {
      timeoutMs: 5,
      fetch: (_url, options) => {
        signal = options.signal;

        return Promise.resolve({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('body stalled')), {
                once: true,
              });
            }),
        });
      },
    },
  );

  await assert.rejects(() => uploader.uploadImages([makeFile()]), {
    code: 'IMAGE_UPLOAD_FAILED',
    message: 'Image upload failed. Please try again.',
  });

  assert.equal(signal.aborted, true);
});
