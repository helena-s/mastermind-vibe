import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';

// The vibe gateway (oauth2-proxy) logs users in with Elastx SSO and forwards
// their OIDC ID token in this header. Plain identity headers are also sent,
// but anything inside the cluster could forge those; the token's signature
// can only come from the identity provider.
export const TOKEN_HEADER = 'x-auth-request-id-token';

const ISSUER = process.env.OIDC_ISSUER || 'https://auth.elastx.cloud/auth/realms/elastx';
const AUDIENCE = process.env.OIDC_AUDIENCE || 'vibe-gateway';
const JWKS_URL = process.env.OIDC_JWKS_URL || `${ISSUER}/protocol/openid-connect/certs`;

// ID tokens expire after minutes, but the gateway may keep forwarding the one
// from login for its whole session. So expiry isn't enforced; instead the
// token must have been issued within a session's lifetime.
const MAX_TOKEN_AGE_SECONDS = 8 * 24 * 3600;

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

// Verified tokens are cached briefly so we don't re-verify every request.
const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

/** Returns { sub, email, name } for a valid token, or throws. */
export async function identify(token) {
  if (!token) throw new Error('no identity token');
  const key = createHash('sha256').update(token).digest('hex');
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.identity;

  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: AUDIENCE,
    // Tolerate expiry for up to the age limit; the iat checks below decide.
    clockTolerance: MAX_TOKEN_AGE_SECONDS,
  });
  const issuedAt = payload.iat ?? 0;
  if (Date.now() / 1000 - issuedAt > MAX_TOKEN_AGE_SECONDS) throw new Error('token too old');
  if (issuedAt > Date.now() / 1000 + 300) throw new Error('token issued in the future');
  if (!payload.sub) throw new Error('token has no subject');

  const email = typeof payload.email === 'string' ? payload.email : null;
  const name =
    (typeof payload.name === 'string' && payload.name.trim()) ||
    (typeof payload.preferred_username === 'string' && payload.preferred_username.split('@')[0]) ||
    (email && email.split('@')[0]) ||
    'Player';
  const identity = { sub: payload.sub, email, name: name.slice(0, 80) };

  cache.set(key, { identity, until: Date.now() + CACHE_MS });
  if (cache.size > 5000) cache.clear();
  return identity;
}
