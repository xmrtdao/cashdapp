// ──────────────────────────────────────────────────────────────
// /realtime/v1/* — HTTP-side of the Realtime service.
// The actual WebSocket upgrade is handled in server.mjs.
// This file just returns config / API endpoint info.
// ──────────────────────────────────────────────────────────────

import { Router } from 'express';

export default function makeRealtimeRouter() {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({
      name: 'local-realtime',
      version: '0.1.0',
      apis: { websocket: '/realtime/v1/websocket' },
      status: 'ok',
      _local: true,
    });
  });

  router.get('/websocket', (_req, res) => {
    res.status(426).json({ error: 'upgrade_required', detail: 'Use WebSocket protocol' });
  });

  router.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  return router;
}
