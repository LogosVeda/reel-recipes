// Key/value storage that works on both hosts the app targets:
//   - Cloudflare Workers  → the RECIPES KV binding
//   - Vercel (or anywhere) → Upstash Redis over its REST API (plain fetch, no SDK)
// Everything else in the app calls kvGet/kvPut and never touches a host API.
import type { Env } from './types.js';

/** True when some storage backend is configured. */
export function storageAvailable(env: Env): boolean {
  return Boolean(env.RECIPES || (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN));
}

export async function kvGet(env: Env, key: string): Promise<string | null> {
  if (env.RECIPES) return env.RECIPES.get(key);
  const upstash = upstashConfig(env);
  if (!upstash) return null;
  const res = await fetch(`${upstash.url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${upstash.token}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { result?: string | null };
  return typeof body.result === 'string' ? body.result : null;
}

export async function kvPut(env: Env, key: string, value: string, ttlSeconds: number): Promise<void> {
  if (env.RECIPES) {
    await env.RECIPES.put(key, value, { expirationTtl: ttlSeconds });
    return;
  }
  const upstash = upstashConfig(env);
  if (!upstash) return;
  // Upstash's REST API takes the value in the body and options as path segments,
  // so keys and values of any length/shape are safe.
  await fetch(`${upstash.url}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${upstash.token}` },
    body: value,
  });
}

export async function kvDel(env: Env, key: string): Promise<void> {
  if (env.RECIPES) {
    await env.RECIPES.delete(key);
    return;
  }
  const upstash = upstashConfig(env);
  if (!upstash) return;
  await fetch(`${upstash.url}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${upstash.token}` },
  });
}

function upstashConfig(env: Env): { url: string; token: string } | null {
  const url = (env.UPSTASH_REDIS_REST_URL ?? '').replace(/\/+$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? '';
  if (!url || !token) return null;
  return { url, token };
}
