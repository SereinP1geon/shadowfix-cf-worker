/**
 * Shadowrocket-only VLESS REALITY subscription fingerprint override.
 *
 * Public:   https://shadowrocket-vps.example.com/subscribe/<sub-id>
 * Origin:   https://vps.example.com:2096/subscribe/<sub-id>
 *
 * Works with both plain VLESS URI lists and base64-encoded 3x-ui lists.
 * Does NOT rewrite non-REALITY links or other protocols.
 */

const ORIGIN = 'https://*protected*';
const UPSTREAM_PATH = '/subscription_encrypted_URL/';
const ALLOWED_PATH = /^\/(?:subscription_encrypted_URL)\/([A-Za-z0-9_-]{1,128})\/?$/;

function transformVlessLinks(text) {
  let changed = 0;
  const body = text.replace(/^vless:\/\/[^\r\n]+/gm, (link) => {
    const question = link.indexOf('?');
    if (question < 0) return link;

    const hash = link.indexOf('#', question + 1);
    const end = hash < 0 ? link.length : hash;
    const params = link.slice(question + 1, end).split('&');

    if (!params.some((p) => /^security=reality$/i.test(p))) return link;

    const index = params.findIndex((p) => /^fp=chrome$/i.test(p));
    if (index < 0) return link;

    params[index] = 'fp=chrome140';
    changed++;
    return link.slice(0, question + 1) + params.join('&') + link.slice(end);
  });

  return { body, changed };
}

function decodeBase64Text(value) {
  const compact = value.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;

  try {
    const unpadded = compact.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    if (unpadded.length % 4 === 1) return null;
    const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
    const binary = atob(padded);
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function encodeBase64Text(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export function transformSubscription(body) {
  // 3x-ui can disable subEncrypt, so handle plain text first.
  if (body.includes('vless://')) {
    return transformVlessLinks(body);
  }

  // 3x-ui normally sends a base64-encoded list of URI lines.
  const decoded = decodeBase64Text(body);
  if (decoded === null) return { body, changed: 0 };

  const result = transformVlessLinks(decoded);
  if (result.changed === 0) return { body, changed: 0 };

  return { body: encodeBase64Text(result.body), changed: result.changed };
}

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET', },
      });
    }

    const inputURL = new URL(request.url);
    const match = inputURL.pathname.match(ALLOWED_PATH);
    if (!match) return new Response('Not Found', { status: 404 });

    // Fixed origin and fixed path: this is not an open HTTP proxy.
    const upstreamURL = `${ORIGIN}${UPSTREAM_PATH}${match[1]}${inputURL.search}`;

    let upstream;
    try {
      upstream = await fetch(upstreamURL, {
        method: 'GET',
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Shadowrocket',
          Accept: 'text/plain', // Prevent 3x-ui from serving its HTML info page
          'Accept-Encoding': 'identity',
        },
        redirect: 'manual',
      });
    } catch {
      return new Response('Subscription origin fetch failed', {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // Do not rewrite errors, redirects, or unexpected status codes.
if (!upstream.ok) {
  const html = await upstream.text();

  const errorCode =
    html.match(/Error\s*(?:code)?\s*:?\s*(1\d{3})\b/i)?.[1] ??
    html.match(/\b(1016|1033)\b/)?.[1] ??
    'unknown';

  return new Response(
    `Upstream HTTP: ${upstream.status}\nCloudflare error: ${errorCode}`,
    {
      status: 502,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }
  );
}

    const originalBody = await upstream.text();
    const { body, changed } = transformSubscription(originalBody);

    const headers = new Headers(upstream.headers);
    // The body changed; origin validators, compression and length are stale.
    for (const key of [
      'Content-Length', 'Content-Encoding', 'ETag', 'Content-MD5',
      'Last-Modified', 'Accept-Ranges', 'Set-Cookie',
    ]) headers.delete(key);
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    headers.set('Cache-Control', 'private, no-store, max-age=0');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Fingerprint-Overrides', String(changed));

    return new Response(body, { status: 200, headers });
  },
};
