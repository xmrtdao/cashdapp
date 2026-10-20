// ──────────────────────────────────────────────────────────────
// /storage/v1/* — Storage stub backed by local disk.
//
// Layout: <storageDir>/<bucket>/<path>
// Endpoints implemented:
//   GET  /storage/v1/bucket                       — list buckets
//   POST /storage/v1/bucket                       — create bucket
//   GET  /storage/v1/object/<bucket>/<path>       — read object
//   POST /storage/v1/object/<bucket>/<path>       — write object (body or upload)
//   PUT  /storage/v1/object/<bucket>/<path>       — upsert object
//   DELETE /storage/v1/object/<bucket>/<path>     — delete object
//   GET  /storage/v1/object/list/<bucket>         — list prefix
//   POST /storage/v1/object/sign/<bucket>/<path>  — signed URL (returns local path)
//
// The suite mostly uses storage.from(bucket).upload() and
// storage.from(bucket).getPublicUrl() — both supported.
// ──────────────────────────────────────────────────────────────

import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join, dirname, extname, basename } from 'path';
import { createHmac, randomBytes } from 'crypto';

export default function makeStorageRouter({ storageDir, dbUrl }) {
  const router = Router();
  const META_DIR = join(storageDir, '.meta');
  if (!existsSync(storageDir)) mkdirSync(storageDir, { recursive: true });
  if (!existsSync(META_DIR)) mkdirSync(META_DIR, { recursive: true });

  function safeJoin(root, ...parts) {
    const p = join(root, ...parts);
    if (!p.startsWith(root)) throw new Error('path_traversal');
    return p;
  }

  // ── Buckets ──
  router.get('/bucket', (_req, res) => {
    const meta = readMeta();
    res.json(meta.buckets || []);
  });
  router.post('/bucket', (req, res) => {
    const name = req.body?.name;
    if (!name) return res.status(400).json({ error: 'name_required' });
    const meta = readMeta();
    meta.buckets = meta.buckets || [];
    if (meta.buckets.find((b) => b.name === name)) return res.status(409).json({ error: 'exists' });
    const bucket = {
      id: name,
      name,
      public: req.body?.public ?? true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    meta.buckets.push(bucket);
    writeMeta(meta);
    mkdirSync(join(storageDir, name), { recursive: true });
    res.json(bucket);
  });
  router.get('/bucket/:name', (req, res) => {
    const meta = readMeta();
    const b = (meta.buckets || []).find((x) => x.name === req.params.name);
    if (!b) return res.status(404).json({ error: 'not_found' });
    res.json(b);
  });
  router.delete('/bucket/:name', (req, res) => {
    const meta = readMeta();
    meta.buckets = (meta.buckets || []).filter((b) => b.name !== req.params.name);
    writeMeta(meta);
    res.json({});
  });
  router.put('/bucket/:name', (req, res) => {
    const meta = readMeta();
    const b = (meta.buckets || []).find((x) => x.name === req.params.name);
    if (!b) return res.status(404).json({ error: 'not_found' });
    if (typeof req.body?.public === 'boolean') b.public = req.body.public;
    b.updated_at = new Date().toISOString();
    writeMeta(meta);
    res.json(b);
  });

  // ── Object list (recursive prefix) ──
  router.get('/object/list/:bucket', (req, res) => {
    const bucket = req.params.bucket;
    const prefix = req.query.prefix || '';
    const root = safeJoin(storageDir, bucket);
    if (!existsSync(root)) return res.json([]);
    const out = [];
    walk(root, root, prefix, out);
    res.json(out);
  });

  // ── Object download ──
  router.get('/object/:bucket/*', (req, res) => {
    const filePath = safeJoin(storageDir, req.params.bucket, req.params[0]);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
    res.send(readFileSync(filePath));
  });

  // ── Object upload (POST or PUT) ──
  function handleUpload(req, res) {
    const bucket = req.params.bucket;
    const filePath = safeJoin(storageDir, bucket, req.params[0]);
    mkdirSync(dirname(filePath), { recursive: true });
    const body = req.body;
    if (Buffer.isBuffer(body)) writeFileSync(filePath, body);
    else if (typeof body === 'string') writeFileSync(filePath, body, 'utf8');
    else writeFileSync(filePath, JSON.stringify(body), 'utf8');
    const meta = readMeta();
    meta.objects = meta.objects || [];
    meta.objects = meta.objects.filter((o) => !(o.bucket === bucket && o.name === req.params[0]));
    meta.objects.push({
      bucket,
      name: req.params[0],
      size: statSync(filePath).size,
      content_type: req.headers['content-type'] || 'application/octet-stream',
      created_at: new Date().toISOString(),
    });
    writeMeta(meta);
    res.json({ Key: `${bucket}/${req.params[0]}` });
  }
  router.post('/object/:bucket/*', handleUpload);
  router.put('/object/:bucket/*', handleUpload);

  // ── Object delete ──
  router.delete('/object/:bucket/*', (req, res) => {
    const filePath = safeJoin(storageDir, req.params.bucket, req.params[0]);
    if (existsSync(filePath)) unlinkSync(filePath);
    res.json({});
  });

  // ── Signed URL (returns a relative path the client can GET) ──
  router.post('/object/sign/:bucket/*', (req, res) => {
    const bucket = req.params.bucket;
    const name = req.params[0];
    const expiresIn = req.body?.expiresIn || 60 * 60; // 1h
    const token = createHmac('sha256', 'local-storage-secret')
      .update(`${bucket}/${name}/${Date.now() + expiresIn * 1000}`)
      .digest('base64url');
    const url = `/storage/v1/object/sign/${bucket}/${name}?token=${token}&expires=${Date.now() + expiresIn * 1000}`;
    res.json({ signedURL: url });
  });

  // ── Public URL (just returns the direct GET path) ──
  router.get('/object/public/:bucket/*', (req, res) => {
    res.json({ publicURL: `/storage/v1/object/${req.params.bucket}/${req.params[0]}` });
  });

  function readMeta() {
    const p = join(META_DIR, 'storage.json');
    if (!existsSync(p)) return { buckets: [], objects: [] };
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  function writeMeta(obj) {
    writeFileSync(join(META_DIR, 'storage.json'), JSON.stringify(obj, null, 2), 'utf8');
  }

  return router;
}

function walk(root, current, prefix, out) {
  const entries = readdirSync(current);
  for (const name of entries) {
    const full = join(current, name);
    const rel = full.slice(root.length + 1).replace(/\\/g, '/');
    if (prefix && !rel.startsWith(prefix)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(root, full, prefix, out);
    } else {
      out.push({
        name: rel,
        id: rel,
        updated_at: st.mtime.toISOString(),
        created_at: st.birthtime.toISOString(),
        last_accessed_at: st.atime.toISOString(),
        size: st.size,
        content_type: 'application/octet-stream',
      });
    }
  }
}
