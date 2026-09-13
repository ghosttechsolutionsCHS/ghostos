import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const BOOTSTRAP_SHA256 = '8e1d36fc0c13984f18ddcd45ed68bb7b1651d0180cc0e31dedaafe55666ce6e3';

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function getCookie(req, name) {
  const cookie = req.headers.get('cookie') || '';
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

export function ownerSessionFor(secret = '') {
  if (!secret) return '';
  return createHmac('sha256', secret).update('ghostos-owner-session-v1').digest('base64url');
}

export function validBootstrapToken(token = '') {
  const digest = createHash('sha256').update(String(token)).digest('hex');
  return safeEqual(digest, BOOTSTRAP_SHA256);
}

export function ownerAuthorized(req, secret = '') {
  if (!secret) return false;
  const header = req.headers.get('x-ghostos-secret') || '';
  if (safeEqual(header, secret)) return true;
  return safeEqual(getCookie(req, 'ghostos_owner'), ownerSessionFor(secret));
}
