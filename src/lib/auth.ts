/**
 * Owner session handling.
 *
 * Deliberately dependency-free and built only on Web Crypto so the identical
 * code verifies sessions in the Node functions and in the Deno edge gate.
 * Secrets are passed in by the caller — this module never reads the
 * environment, which keeps it portable across both runtimes.
 */

export const SESSION_COOKIE = 'ghostos_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h, re-login daily

export interface SessionPayload {
  v: 1;
  sub: 'owner';
  iat: number;
  exp: number;
}

const enc = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return new Uint8Array(sig);
}

/** Length-independent comparison, so a mismatch leaks no timing signal. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export async function createSessionToken(secret: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  const payload: SessionPayload = { v: 1, sub: 'owner', iat, exp: iat + SESSION_TTL_SECONDS };
  const body = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const sig = b64urlFromBytes(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function verifySessionToken(
  token: string | null | undefined,
  secret: string,
  now = Date.now(),
): Promise<SessionPayload | null> {
  if (!token || !secret) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expected = b64urlFromBytes(await hmac(secret, body));
  if (!constantTimeEqual(sig, expected)) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(body))) as SessionPayload;
    if (payload.v !== 1 || payload.sub !== 'owner') return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export function readSessionCookie(req: Request): string | null {
  return readCookie(req, SESSION_COOKIE);
}

/** Secure is set for anything but plain-http localhost, so dev still works. */
export function isSecureRequest(req: Request): boolean {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return proto === 'https' || !local;
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookieHeader(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Paths that must stay reachable without a session: the login screen and its
 * assets, the preserved public health surface, and the v1 lead webhook (which
 * authenticates with its own shared secret instead).
 */
export const PUBLIC_PATHS = [
  '/login',
  '/login.html',
  '/health',
  '/health.html',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/assets/login.css',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/status',
  '/api/ghostos',
  '/.netlify/functions/ghostos',
];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  // The public job-status feed for the customer website carries its own token.
  return pathname.startsWith('/api/public/');
}
