// ──────────────────────────────────────────────────────────────
// /auth/v1/* — GoTrue-compatible stub.
//
// In the cloud, GoTrue handles signup, signin, sessions, JWTs.
// Locally, we operate in "no-auth" mode: any anon caller is
// authenticated as a single dev user, the JWT is self-signed
// with a known key (the VITE_SUPABASE_PUBLISHABLE_KEY env var
// can be anything since we never validate signatures locally).
//
// Endpoints implemented (the ones the suite's @supabase/supabase-
// js client calls):
//   GET  /auth/v1/user         — current user
//   GET  /auth/v1/settings     — provider config
//   POST /auth/v1/token        — refresh / password grant
//   POST /auth/v1/logout       — no-op
//   GET  /auth/v1/session      — current session
// ──────────────────────────────────────────────────────────────

import { Router } from 'express';
import { createHmac, randomBytes } from 'crypto';

const ANON_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'dev@local',
  phone: '',
  app_metadata: { provider: 'local', providers: ['local'] },
  user_metadata: { full_name: 'Local Dev' },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  confirmed_at: '2026-01-01T00:00:00.000Z',
  email_confirmed_at: '2026-01-01T00:00:00.000Z',
  last_sign_in_at: '2026-01-01T00:00:00.000Z',
};

function signJwt(payload, secret) {
  // HS256
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export default function makeAuthRouter({ dbUrl }) {
  const router = Router();
  const JWT_SECRET = process.env.LOCAL_JWT_SECRET || 'local-dev-secret-not-secure';
  const TOKEN_TTL = 60 * 60 * 24 * 7; // 7 days

  function makeToken(role = 'authenticated', uid = ANON_USER.id) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({
      aud: 'authenticated',
      role,
      sub: uid,
      email: ANON_USER.email,
      exp: now + TOKEN_TTL,
      iat: now,
      app_metadata: ANON_USER.app_metadata,
      user_metadata: ANON_USER.user_metadata,
    }, JWT_SECRET);
  }

  // GET /auth/v1/settings
  router.get('/settings', (_req, res) => {
    res.json({
      mailer_autoconfirm: true,
      phone_autoconfirm: true,
      saml_enabled: false,
      external: { anonymous_users: true, email: true, phone: false, google: false, github: false, azure: false, gitlab: false, facebook: false, twitter: false, keycloak: false, linkedin: false, notion: false, slack: false, spotify: false, workos: false, zoom: false },
      disable_signup: false,
      autoconfirm: true,
      jwt_secret: 'local-dev-secret-not-secure',
      api: { name: 'local-supabase' },
    });
  });

  // GET /auth/v1/user
  router.get('/user', (req, res) => {
    const tok = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!tok || tok === 'undefined' || tok === 'null') {
      // Anon — return the dev user anyway (suite expects a user)
      return res.json(ANON_USER);
    }
    res.json(ANON_USER);
  });

  // GET /auth/v1/admin/user (supabase admin client)
  router.get('/admin/user', (req, res) => res.json(ANON_USER));

  // GET /auth/v1/admin/users
  router.get('/admin/users', (_req, res) => res.json({ users: [ANON_USER], aud: 'authenticated' }));

  // POST /auth/v1/token
  //   ?grant_type=password     → { email, password }
  //   ?grant_type=refresh_token → { refresh_token }
  router.post('/token', (req, res) => {
    const grant = (req.query.grant_type || req.body?.grant_type || 'password');
    const access = makeToken();
    const refresh = randomBytes(32).toString('base64url');
    res.json({
      access_token: access,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: TOKEN_TTL,
      expires_at: Math.floor(Date.now() / 1000) + TOKEN_TTL,
      user: ANON_USER,
      _local: { grant_type: grant },
    });
  });

  // POST /auth/v1/logout
  router.post('/logout', (_req, res) => res.json({}));

  // GET /auth/v1/session
  router.get('/session', (req, res) => {
    res.json({
      access_token: makeToken(),
      refresh_token: 'local-refresh',
      token_type: 'bearer',
      expires_in: TOKEN_TTL,
      expires_at: Math.floor(Date.now() / 1000) + TOKEN_TTL,
      user: ANON_USER,
    });
  });

  // POST /auth/v1/otp, /magiclink, /signup, /anonymous — accept and return success
  for (const path of ['/otp', '/magiclink', '/signup', '/anonymous', '/authorize', '/callback']) {
    router.post(path, (req, res) => res.json({
      access_token: makeToken(),
      refresh_token: 'local-refresh',
      token_type: 'bearer',
      expires_in: TOKEN_TTL,
      expires_at: Math.floor(Date.now() / 1000) + TOKEN_TTL,
      user: ANON_USER,
      _local: true,
    }));
    router.get(path, (req, res) => res.json({ user: ANON_USER, _local: true }));
  }

  // .well-known/jwks.json — return empty
  router.get('/.well-known/jwks.json', (_req, res) => res.json({ keys: [] }));

  return router;
}
