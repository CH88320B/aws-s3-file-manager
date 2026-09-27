require('dotenv').config();
const { z } = require('zod');

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  AWS_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ENDPOINT: z.string().url().optional(),          // MinIO/LocalStack for local development
  CLOUDFRONT_URL: z.string().url().optional(),       // serves thumbnails publicly via OAC
  JWT_SECRET: z.string().min(32),
  DATABASE_FILE: z.string().default('./data/files.db'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().default(3310),
  SCAN_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  DEFAULT_QUOTA_MB: z.coerce.number().int().positive().default(500),
  MAX_FILE_MB: z.coerce.number().int().positive().default(50),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
});

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** Allowed MIME types. The object's real content type is re-checked after upload. */
const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain', 'text/csv',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

module.exports = { loadConfig, ALLOWED_TYPES };
