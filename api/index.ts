// Vercel entry point (Edge runtime).
//
// The same Hono app powers both hosts. On Cloudflare, bindings arrive as the
// `env` argument; on Vercel there are no bindings, so env vars are read from
// process.env and storage falls back to Upstash Redis (see src/kv.ts).
import app from '../src/index.js';
import type { Env } from '../src/types.js';

export const config = { runtime: 'edge' };

function envFromProcess(): Env {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return {
    LLM_PROVIDER: p.LLM_PROVIDER,
    ANTHROPIC_API_KEY: p.ANTHROPIC_API_KEY,
    UPSTASH_REDIS_REST_URL: p.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: p.UPSTASH_REDIS_REST_TOKEN,
    YOUTUBE_API_KEY: p.YOUTUBE_API_KEY,
    WHISPER_API_KEY: p.WHISPER_API_KEY,
    WHISPER_API_URL: p.WHISPER_API_URL,
    WHISPER_MODEL: p.WHISPER_MODEL,
  };
}

/**
 * Vercel's catch-all rewrite can hand the function either the original path
 * (/r/abc123) or the rewrite destination (/api). When it's the latter, the
 * real path is still available in `x-matched-path`, so recover it — otherwise
 * every route would collapse onto one.
 */
function originalRequest(request: Request): Request {
  const url = new URL(request.url);
  const collapsed = url.pathname === '/api' || url.pathname === '/api/index';
  if (!collapsed) return request;
  const matched = request.headers.get('x-matched-path') ?? request.headers.get('x-vercel-original-path');
  if (!matched || matched === url.pathname) return request;
  const [path, query] = matched.split('?');
  url.pathname = path!;
  if (query && !url.search) url.search = query;
  return new Request(url.toString(), request);
}

export default function handler(request: Request): Response | Promise<Response> {
  return app.fetch(originalRequest(request), envFromProcess());
}
