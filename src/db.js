const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL,
    name          TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    size          INTEGER NOT NULL,          -- declared at upload, verified on completion
    s3_key        TEXT NOT NULL UNIQUE,
    thumbnail_key TEXT,
    status        TEXT NOT NULL DEFAULT 'pending'  -- pending | ready | infected | rejected
                  CHECK (status IN ('pending', 'ready', 'infected', 'rejected')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_files_owner ON files (owner_id, status, created_at);

  CREATE TABLE IF NOT EXISTS quotas (
    owner_id    TEXT PRIMARY KEY,
    limit_bytes INTEGER NOT NULL
  );
`;

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

function createRepository(db, { defaultQuotaBytes }) {
  const q = {
    insert: db.prepare(`INSERT INTO files (id, owner_id, name, content_type, size, s3_key)
                        VALUES (@id, @owner_id, @name, @content_type, @size, @s3_key)`),
    get: db.prepare('SELECT * FROM files WHERE id = ? AND owner_id = ?'),
    list: db.prepare(`SELECT * FROM files WHERE owner_id = ? AND status = 'ready'
                      AND (? IS NULL OR name LIKE '%' || ? || '%') ORDER BY created_at DESC LIMIT ? OFFSET ?`),
    // Pending uploads count toward usage so parallel uploads can't overshoot the quota.
    usage: db.prepare("SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE owner_id = ? AND status IN ('pending', 'ready')"),
    quota: db.prepare('SELECT limit_bytes FROM quotas WHERE owner_id = ?'),
    setQuota: db.prepare('INSERT INTO quotas (owner_id, limit_bytes) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET limit_bytes = excluded.limit_bytes'),
    complete: db.prepare('UPDATE files SET status = ?, size = ?, thumbnail_key = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM files WHERE id = ?'),
    stalePending: db.prepare("SELECT * FROM files WHERE status = 'pending' AND created_at < datetime('now', ?)"),
  };

  const usage = (ownerId) => {
    const used = q.usage.get(ownerId).used;
    const limit = q.quota.get(ownerId)?.limit_bytes ?? defaultQuotaBytes;
    return { used, limit, available: Math.max(0, limit - used) };
  };

  return {
    usage,
    /** Reserves quota and creates the pending row atomically. Returns null when over quota. */
    reserve: db.transaction((file) => {
      if (usage(file.owner_id).available < file.size) return null;
      q.insert.run(file);
      return file;
    }),
    get: (id, ownerId) => q.get.get(id, ownerId),
    list: (ownerId, { search = null, limit = 50, offset = 0 } = {}) => q.list.all(ownerId, search, search, limit, offset),
    complete: (id, { status, size, thumbnailKey = null }) => q.complete.run(status, size, thumbnailKey, id),
    remove: (id) => q.remove.run(id),
    setQuota: (ownerId, bytes) => q.setQuota.run(ownerId, bytes),
    stalePending: (olderThanMinutes) => q.stalePending.all(`-${olderThanMinutes} minutes`),
  };
}

module.exports = { openDatabase, createRepository };
