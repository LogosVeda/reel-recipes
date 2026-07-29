// Email + password accounts for Reel Recipes.
//
// Runs on both hosts the app targets (Cloudflare Workers and Vercel Edge), so
// everything here uses Web Crypto (crypto.subtle / crypto.getRandomValues) and
// the shared kv layer — no Node-only APIs, no external auth SDK.
//
// Two credentials identify a user:
//   - a session cookie (rr_session) for the website, and
//   - a long-lived personal API token the iOS Shortcut sends as a Bearer header,
// since a Shortcut can't hold a browser cookie. Both resolve to the same user.
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './types.js';
import { kvGet, kvPut, kvDel } from './kv.js';

export const SESSION_COOKIE = 'rr_session';

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const TOKEN_TTL = 60 * 60 * 24 * 365 * 5; // API token: effectively permanent
const PBKDF2_ITERATIONS = 100_000;

export interface UserRecord {
  id: string;
  email: string;
  /** PBKDF2-SHA256 derivation, hex */
  passwordHash: string;
  /** per-user salt, hex */
  salt: string;
  /** personal Bearer token for the iOS Shortcut */
  apiToken: string;
  createdAt: string;
}

export type AuthResult =
  | { ok: true; user: UserRecord }
  | { ok: false; code: 'exists' | 'invalid' | 'weak' | 'bad_email' | 'unavailable'; message: string };

// --- crypto helpers ----------------------------------------------------

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

/** Short opaque user id (base36 from randomness), unrelated to the email. */
function newUserId(): string {
  return 'u_' + randomHex(9);
}

async function derive(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return toHex(new Uint8Array(bits));
}

/** Length-safe, constant-time-ish comparison of two hex strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// --- storage ------------------------------------------------------------

async function getUser(env: Env, id: string): Promise<UserRecord | null> {
  const raw = await kvGet(env, `user:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserRecord;
  } catch {
    return null;
  }
}

async function saveUser(env: Env, user: UserRecord): Promise<void> {
  await kvPut(env, `user:${user.id}`, JSON.stringify(user), TOKEN_TTL);
  await kvPut(env, `useremail:${user.email}`, user.id, TOKEN_TTL);
  await kvPut(env, `apitoken:${user.apiToken}`, user.id, TOKEN_TTL);
}

// --- public API ---------------------------------------------------------

export async function signup(env: Env, emailRaw: string, password: string): Promise<AuthResult> {
  const email = normalizeEmail(emailRaw);
  if (!validEmail(email)) return { ok: false, code: 'bad_email', message: 'Enter a valid email address.' };
  if (!password || password.length < 8) {
    return { ok: false, code: 'weak', message: 'Use a password with at least 8 characters.' };
  }
  const existing = await kvGet(env, `useremail:${email}`);
  if (existing) return { ok: false, code: 'exists', message: 'An account with that email already exists. Try signing in.' };

  const salt = randomHex(16);
  const passwordHash = await derive(password, salt);
  const user: UserRecord = {
    id: newUserId(),
    email,
    passwordHash,
    salt,
    apiToken: randomHex(24),
    createdAt: new Date().toISOString(),
  };
  await saveUser(env, user);
  return { ok: true, user };
}

export async function login(env: Env, emailRaw: string, password: string): Promise<AuthResult> {
  const email = normalizeEmail(emailRaw);
  if (!validEmail(email) || !password) {
    return { ok: false, code: 'invalid', message: 'Incorrect email or password.' };
  }
  const id = await kvGet(env, `useremail:${email}`);
  if (!id) return { ok: false, code: 'invalid', message: 'Incorrect email or password.' };
  const user = await getUser(env, id);
  if (!user) return { ok: false, code: 'invalid', message: 'Incorrect email or password.' };
  const candidate = await derive(password, user.salt);
  if (!safeEqual(candidate, user.passwordHash)) {
    return { ok: false, code: 'invalid', message: 'Incorrect email or password.' };
  }
  return { ok: true, user };
}

/** Create a session, persist it, and set the cookie on the response. */
export async function startSession(env: Env, c: Context, userId: string): Promise<void> {
  const token = randomHex(24);
  await kvPut(env, `session:${token}`, userId, SESSION_TTL);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL,
  });
}

export async function endSession(env: Env, c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await kvDel(env, `session:${token}`);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/**
 * Resolve the current user from either credential:
 *   1. Authorization: Bearer <apiToken>  (the iOS Shortcut), or
 *   2. the rr_session cookie             (the website).
 * Returns null when neither is present or valid.
 */
export async function currentUser(env: Env, c: Context): Promise<UserRecord | null> {
  const auth = c.req.header('authorization') ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) {
    const id = await kvGet(env, `apitoken:${bearer[1]!.trim()}`);
    if (id) {
      const user = await getUser(env, id);
      if (user) return user;
    }
  }
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const id = await kvGet(env, `session:${token}`);
    if (id) return getUser(env, id);
  }
  return null;
}

/** Public-facing view of a user (never leaks the password hash/salt). */
export function publicUser(user: UserRecord): { email: string; apiToken: string } {
  return { email: user.email, apiToken: user.apiToken };
}
