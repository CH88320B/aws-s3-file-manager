const { loadConfig } = require('./config');
const logger = require('./logger');
const { openDatabase, createRepository } = require('./db');
const { createStorage } = require('./storage');
const { createScanner, noopScanner } = require('./scanner');
const { createFileService } = require('./files');
const { createApp } = require('./app');

const config = loadConfig();
const db = openDatabase(config.DATABASE_FILE);
const repo = createRepository(db, { defaultQuotaBytes: config.DEFAULT_QUOTA_MB * 1024 * 1024 });
const storage = createStorage({ region: config.AWS_REGION, bucket: config.S3_BUCKET, endpoint: config.S3_ENDPOINT, cloudfrontUrl: config.CLOUDFRONT_URL });
const scanner = config.SCAN_ENABLED ? createScanner({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT }) : noopScanner;
if (!config.SCAN_ENABLED) logger.warn('Virus scanning is DISABLED');

const files = createFileService({ repo, storage, scanner, config });
const server = createApp({ files, jwtSecret: config.JWT_SECRET }).listen(config.PORT, () => logger.info(`File manager on :${config.PORT}`));

// Release quota held by uploads that were requested but never completed.
const sweeper = setInterval(async () => {
  for (const f of repo.stalePending(Math.ceil(config.UPLOAD_URL_TTL_SECONDS / 60) + 10)) {
    await storage.remove([f.s3_key]).catch(() => {});
    repo.remove(f.id);
  }
}, 5 * 60 * 1000);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearInterval(sweeper);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
