const request = require('supertest');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { openDatabase, createRepository } = require('../src/db');
const { createFileService, sniffType } = require('../src/files');
const { createApp } = require('../src/app');

const SECRET = 'test-secret-that-is-at-least-32-characters';
const config = { MAX_FILE_MB: 5, UPLOAD_URL_TTL_SECONDS: 300 };

/** In-memory stand-in for S3 that behaves like the real storage module. */
function fakeStorage() {
  const objects = new Map();
  return {
    objects,
    presignUpload: jest.fn(async ({ key }) => ({ url: 'https://bucket.s3.amazonaws.com', fields: { key } })),
    head: jest.fn(async (key) => (objects.has(key) ? { ContentLength: objects.get(key).length } : null)),
    getBuffer: jest.fn(async (key) => objects.get(key)),
    put: jest.fn(async (key, body) => objects.set(key, body)),
    presignDownload: jest.fn(async (key) => `https://signed.example.com/${key}`),
    remove: jest.fn(async (keys) => keys.forEach((k) => objects.delete(k))),
    publicUrl: (key) => (key ? `https://cdn.example.com/${key}` : null),
  };
}

function setup({ quotaBytes = 10 * 1024 * 1024, scanResult = { clean: true } } = {}) {
  const repo = createRepository(openDatabase(':memory:'), { defaultQuotaBytes: quotaBytes });
  const storage = fakeStorage();
  const scanner = { scan: jest.fn(async () => scanResult) };
  const files = createFileService({ repo, storage, scanner, config });
  const app = createApp({ files, jwtSecret: SECRET });
  const token = (sub = 'user-1') => `Bearer ${jwt.sign({ sub }, SECRET)}`;
  return { app, repo, storage, scanner, token };
}

const png = () => sharp({ create: { width: 800, height: 600, channels: 3, background: '#4f46e5' } }).png().toBuffer();

async function uploadFlow(ctx, buffer, { name = 'photo.png', contentType = 'image/png', size = buffer.length, user } = {}) {
  const res = await request(ctx.app).post('/api/files/uploads').set('Authorization', ctx.token(user))
    .send({ name, contentType, size });
  if (res.status !== 201) return { res };
  ctx.storage.objects.set(`uploads/${user ?? 'user-1'}/${res.body.id}`, buffer);
  const done = await request(ctx.app).post(`/api/files/${res.body.id}/complete`).set('Authorization', ctx.token(user));
  return { res, done, id: res.body.id };
}

describe('upload flow', () => {
  it('issues a pre-signed POST with an exact size condition and a server-generated key', async () => {
    const ctx = setup();
    const res = await request(ctx.app).post('/api/files/uploads').set('Authorization', ctx.token())
      .send({ name: '../../etc/passwd.png', contentType: 'image/png', size: 1234 });
    expect(res.status).toBe(400); // slashes rejected

    const ok = await request(ctx.app).post('/api/files/uploads').set('Authorization', ctx.token())
      .send({ name: 'photo.png', contentType: 'image/png', size: 1234 });
    expect(ok.status).toBe(201);
    const args = ctx.storage.presignUpload.mock.calls[0][0];
    expect(args).toMatchObject({ contentType: 'image/png', size: 1234 });
    expect(args.key).toBe(`uploads/user-1/${ok.body.id}`);
  });

  it('completes an image upload, scans it and generates a WebP thumbnail', async () => {
    const ctx = setup();
    const { done, id } = await uploadFlow(ctx, await png());

    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'ready', thumbnailUrl: `https://cdn.example.com/thumbnails/user-1/${id}.webp` });
    expect(ctx.scanner.scan).toHaveBeenCalledTimes(1);

    const meta = await sharp(ctx.storage.objects.get(`thumbnails/user-1/${id}.webp`)).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(320);
  });

  it('deletes infected files and reports the signature', async () => {
    const ctx = setup({ scanResult: { clean: false, signature: 'Eicar-Test-Signature' } });
    const { done, id } = await uploadFlow(ctx, await png());
    expect(done.status).toBe(422);
    expect(done.body.error).toContain('Eicar');
    expect(ctx.storage.objects.has(`uploads/user-1/${id}`)).toBe(false);
  });

  it('rejects files whose content does not match the declared type', async () => {
    const ctx = setup();
    const fake = Buffer.from('MZ\x90\x00 definitely not a png');
    const { done } = await uploadFlow(ctx, fake);
    expect(done.status).toBe(422);
    expect(done.body.error).toMatch(/does not match/);
  });

  it('rejects disallowed types and oversized files up front', async () => {
    const ctx = setup();
    const exe = await request(ctx.app).post('/api/files/uploads').set('Authorization', ctx.token())
      .send({ name: 'a.exe', contentType: 'application/x-msdownload', size: 10 });
    expect(exe.status).toBe(415);
    const big = await request(ctx.app).post('/api/files/uploads').set('Authorization', ctx.token())
      .send({ name: 'a.pdf', contentType: 'application/pdf', size: 6 * 1024 * 1024 });
    expect(big.status).toBe(413);
  });
});

describe('quotas', () => {
  it('counts pending uploads so parallel requests cannot exceed the quota', async () => {
    const ctx = setup({ quotaBytes: 1000 });
    const send = () => request(ctx.app).post('/api/files/uploads').set('Authorization', ctx.token())
      .send({ name: 'a.txt', contentType: 'text/plain', size: 600 });
    expect((await send()).status).toBe(201);
    const second = await send();
    expect(second.status).toBe(413);
    expect(second.body.error).toMatch(/quota/);
  });

  it('frees quota when a file is deleted', async () => {
    const ctx = setup({ quotaBytes: 2_000_000 });
    const { id } = await uploadFlow(ctx, await png());
    const before = (await request(ctx.app).get('/api/usage').set('Authorization', ctx.token())).body.used;
    await request(ctx.app).delete(`/api/files/${id}`).set('Authorization', ctx.token()).expect(204);
    const after = (await request(ctx.app).get('/api/usage').set('Authorization', ctx.token())).body.used;
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(0);
  });
});

describe('access control', () => {
  it('requires a valid token', async () => {
    const ctx = setup();
    expect((await request(ctx.app).get('/api/files')).status).toBe(401);
    expect((await request(ctx.app).get('/api/files').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('hides other users\' files', async () => {
    const ctx = setup();
    const { id } = await uploadFlow(ctx, await png());
    const other = await request(ctx.app).get(`/api/files/${id}/download`).set('Authorization', ctx.token('user-2'));
    expect(other.status).toBe(404);
    const list = await request(ctx.app).get('/api/files').set('Authorization', ctx.token('user-2'));
    expect(list.body.items).toHaveLength(0);
  });

  it('returns short-lived download links to the owner', async () => {
    const ctx = setup();
    const { id } = await uploadFlow(ctx, await png());
    const res = await request(ctx.app).get(`/api/files/${id}/download`).set('Authorization', ctx.token());
    expect(res.body).toMatchObject({ expiresIn: 300, url: expect.stringContaining(id) });
  });
});

describe('sniffType', () => {
  it('detects common formats from magic bytes', async () => {
    expect(sniffType(await png())).toBe('image/png');
    expect(sniffType(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffType(Buffer.from('hello'))).toBeNull();
  });
});
