const crypto = require('node:crypto');
const sharp = require('sharp');
const { ALLOWED_TYPES } = require('./config');

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const THUMBNAIL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Detects the real file type from magic bytes, so a renamed .exe cannot pass as a PNG. */
function sniffType(buf) {
  const hex = buf.subarray(0, 8).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (hex.startsWith('504b0304')) return 'application/zip'; // also docx/xlsx containers
  return null;
}

function typeMatches(declared, sniffed) {
  if (declared.startsWith('text/')) return sniffed === null; // plain text has no magic bytes
  if (declared.includes('openxmlformats')) return sniffed === 'application/zip';
  return declared === sniffed;
}

const makeThumbnail = (buffer) =>
  sharp(buffer, { animated: false }).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();

function createFileService({ repo, storage, scanner, config }) {
  const maxBytes = config.MAX_FILE_MB * 1024 * 1024;

  async function requestUpload(ownerId, { name, contentType, size }) {
    if (!ALLOWED_TYPES.has(contentType)) throw new AppError(415, `File type ${contentType} is not allowed`);
    if (size > maxBytes) throw new AppError(413, `Files must be at most ${config.MAX_FILE_MB} MB`);

    const id = crypto.randomUUID();
    // Keys never contain user input: no path traversal, no collisions, no leaking filenames.
    const key = `uploads/${ownerId}/${id}`;
    const reserved = repo.reserve({ id, owner_id: ownerId, name, content_type: contentType, size, s3_key: key });
    if (!reserved) {
      const { used, limit } = repo.usage(ownerId);
      throw new AppError(413, `Storage quota exceeded (${(used / 1e6).toFixed(1)} of ${(limit / 1e6).toFixed(0)} MB used)`);
    }

    const upload = await storage.presignUpload({ key, contentType, size, expiresIn: config.UPLOAD_URL_TTL_SECONDS });
    return { id, upload, expiresIn: config.UPLOAD_URL_TTL_SECONDS };
  }

  /** Called by the client after the direct upload finishes: verify, scan, thumbnail, publish. */
  async function completeUpload(ownerId, id) {
    const file = repo.get(id, ownerId);
    if (!file) throw new AppError(404, 'File not found');
    if (file.status !== 'pending') return present(file);

    const head = await storage.head(file.s3_key);
    if (!head) throw new AppError(409, 'Upload not found in storage yet');

    const buffer = await storage.getBuffer(file.s3_key);
    const reject = async (status, message) => {
      await storage.remove([file.s3_key]);
      repo.complete(id, { status, size: 0 });
      throw new AppError(422, message);
    };

    if (buffer.length !== file.size) return reject('rejected', 'Uploaded size does not match the declared size');
    if (!typeMatches(file.content_type, sniffType(buffer))) return reject('rejected', 'File content does not match its declared type');

    const verdict = await scanner.scan(buffer);
    if (!verdict.clean) return reject('infected', `Malware detected (${verdict.signature}); the file was deleted`);

    let thumbnailKey = null;
    if (THUMBNAIL_TYPES.has(file.content_type)) {
      thumbnailKey = `thumbnails/${ownerId}/${id}.webp`;
      await storage.put(thumbnailKey, await makeThumbnail(buffer), 'image/webp');
    }

    repo.complete(id, { status: 'ready', size: buffer.length, thumbnailKey });
    return present(repo.get(id, ownerId));
  }

  async function downloadUrl(ownerId, id) {
    const file = repo.get(id, ownerId);
    if (!file || file.status !== 'ready') throw new AppError(404, 'File not found');
    return { url: await storage.presignDownload(file.s3_key, file.name), expiresIn: 300 };
  }

  async function remove(ownerId, id) {
    const file = repo.get(id, ownerId);
    if (!file) throw new AppError(404, 'File not found');
    await storage.remove([file.s3_key, file.thumbnail_key]);
    repo.remove(id);
  }

  function present(f) {
    return {
      id: f.id,
      name: f.name,
      contentType: f.content_type,
      size: f.size,
      status: f.status,
      thumbnailUrl: storage.publicUrl(f.thumbnail_key),
      createdAt: f.created_at,
    };
  }

  return {
    requestUpload,
    completeUpload,
    downloadUrl,
    remove,
    list: (ownerId, opts) => repo.list(ownerId, opts).map(present),
    usage: (ownerId) => repo.usage(ownerId),
  };
}

module.exports = { createFileService, AppError, sniffType, typeMatches, makeThumbnail };
