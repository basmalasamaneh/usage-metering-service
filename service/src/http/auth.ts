import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { findAccountIdByKeyHash } from '../repo/accounts';
import { HttpError } from './errors';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the API-key hook: the account the key belongs to. Every query is scoped by it. */
    accountId: string;
  }
}

export const hashApiKey = (key: string): Buffer => createHash('sha256').update(key).digest();

/** Keys are 256-bit random values, so a plain SHA-256 is enough (no need for a slow password hash). */
export function generateApiKey(): { key: string; hash: Buffer; prefix: string } {
  const key = `qk_${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 10) };
}

const CACHE_MAX = 10_000;

/**
 * Resolves X-API-Key to an account id. Keys never change, so successful lookups can be cached
 * safely (only SHA-256 digests are kept in memory). Failures are never cached.
 */
export function createApiKeyAuth(pool: Pool) {
  const cache = new Map<string, string>();
  return async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers['x-api-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) throw new HttpError(401, 'missing_api_key', 'Send your API key in the X-API-Key header.');
    const hash = hashApiKey(key);
    const hex = hash.toString('hex');
    let accountId = cache.get(hex);
    if (!accountId) {
      accountId = (await findAccountIdByKeyHash(pool, hash)) ?? undefined;
      if (!accountId) throw new HttpError(401, 'invalid_api_key', 'The API key is not valid.');
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(hex, accountId);
    }
    req.accountId = accountId;
  };
}

export function checkAdminToken(expected: string | null, req: FastifyRequest): void {
  if (!expected) return;
  const given = req.headers['x-admin-token'];
  const a = Buffer.from(typeof given === 'string' ? given : '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, 'invalid_admin_token', 'Creating accounts requires a valid X-Admin-Token header.');
  }
}
