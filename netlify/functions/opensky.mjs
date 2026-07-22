// Proxies the OpenSky Network states API, adding CORS headers the browser needs
// and authenticating server-side so credentials never reach the client.
//
// This is a port of worker/src/index.js. It exists because OpenSky's auth server
// stopped accepting connections from Cloudflare Workers egress IPs -- the Worker
// gets a 522 (connection timed out) on every token request while the exact same
// call from a laptop returns instantly. See worker/README.md for the original.

const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_URL = 'https://opensky-network.org/api/states/all';

// OpenSky refreshes state vectors every ~5-10s; caching this long keeps us well
// inside the daily credit budget without the data going stale.
const CACHE_SECONDS = 8;

// Module scope survives between invocations while the function stays warm, so a
// token is usually reused rather than re-fetched. A cold start just re-auths.
let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.OPENSKY_CLIENT_ID,
      client_secret: process.env.OPENSKY_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`token request failed: ${res.status}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Expire a minute early so an in-flight request can't race the deadline.
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ALLOWED_ORIGINS is a comma-separated list, so the app can be served from more
// than one place (production, a staging host, localhost) without a code change.
// An empty list means allow any origin.
//
// When the page and this function share an origin the browser sends no Origin
// header and runs no CORS check, so none of this applies -- it is inert, not
// wrong, in that setup.
//
// Note this is an anti-abuse measure, not a security boundary: the Origin header
// is only enforced by browsers, and anything else can send whatever it likes. It
// stops other websites from silently spending our OpenSky credits.
function corsHeaders(request) {
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const origin = request.headers.get('Origin');
  let allowOrigin = null;

  if (allowed.length === 0) {
    allowOrigin = '*';
  } else if (origin && allowed.includes(origin)) {
    allowOrigin = origin;
  }

  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    // Responses differ per origin, so they must not be shared across origins by
    // any cache sitting in front of this.
    'Vary': 'Origin',
  };
  // Omitting the header entirely (rather than sending a non-matching origin) is
  // what makes the browser block a disallowed caller.
  if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;
  return headers;
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(request.url);
  const bbox = ['lamin', 'lomin', 'lamax', 'lomax'];
  const params = new URLSearchParams();

  for (const key of bbox) {
    const raw = url.searchParams.get(key);
    const value = Number(raw);
    if (raw === null || !Number.isFinite(value)) {
      return new Response(
        JSON.stringify({ error: `missing or invalid parameter: ${key}` }),
        { status: 400, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }
    params.set(key, String(value));
  }

  const upstream = `${STATES_URL}?${params}`;

  let token;
  try {
    token = await getToken();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'auth failed', detail: String(err) }), {
      status: 502,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
    });
  }

  const res = await fetch(upstream, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 || res.status === 403) {
    // Token may have been revoked early; drop it so the next call re-auths.
    cachedToken = null;
    tokenExpiresAt = 0;
  }

  if (!res.ok) {
    return new Response(
      JSON.stringify({ error: 'upstream error', status: res.status }),
      { status: 502, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
    );
  }

  const body = await res.text();

  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'application/json',
      // The Worker did its own cache.match/cache.put against caches.default and
      // reported X-Proxy-Cache: HIT|MISS. Netlify has no equivalent API -- its CDN
      // caches in front of the function instead, so a hit never invokes this code
      // and could not set a header even in principle. Netlify-CDN-Cache-Control
      // drives the edge; Cache-Control drives the browser. To see whether a request
      // cost a credit, read Netlify's own `cache-status` response header.
      'Netlify-CDN-Cache-Control': `public, s-maxage=${CACHE_SECONDS}`,
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      'X-RateLimit-Remaining': res.headers.get('x-rate-limit-remaining') || '',
    },
  });
};

// Serve at a clean path instead of /.netlify/functions/opensky, so that a
// same-origin PROXY_URL is just '/api/opensky'.
export const config = {
  path: '/api/opensky',
};
