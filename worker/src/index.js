// Proxies the OpenSky Network states API, adding CORS headers the browser needs
// and authenticating server-side so credentials never reach the client.

const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_URL = 'https://opensky-network.org/api/states/all';

// OpenSky refreshes state vectors every ~5-10s; caching this long keeps us well
// inside the daily credit budget without the data going stale.
const CACHE_SECONDS = 8;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken(env) {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.OPENSKY_CLIENT_ID,
      client_secret: env.OPENSKY_CLIENT_SECRET,
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
// Note this is an anti-abuse measure, not a security boundary: the Origin header
// is only enforced by browsers, and anything else can send whatever it likes. It
// stops other websites from silently spending our OpenSky credits.
function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
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

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
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
          { status: 400, headers: { ...corsHeaders(request, env), 'Content-Type': 'application/json' } }
        );
      }
      params.set(key, String(value));
    }

    const upstream = `${STATES_URL}?${params}`;

    // Serve from the edge cache when we can; a hit costs no OpenSky credits.
    const cache = caches.default;
    const cacheKey = new Request(upstream);
    const hit = await cache.match(cacheKey);
    if (hit) {
      const res = new Response(hit.body, hit);
      for (const [k, v] of Object.entries(corsHeaders(request, env))) res.headers.set(k, v);
      res.headers.set('X-Proxy-Cache', 'HIT');
      return res;
    }

    let token;
    try {
      token = await getToken(env);
    } catch (err) {
      return new Response(JSON.stringify({ error: 'auth failed', detail: String(err) }), {
        status: 502,
        headers: { ...corsHeaders(request, env), 'Content-Type': 'application/json' },
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
        { status: 502, headers: { ...corsHeaders(request, env), 'Content-Type': 'application/json' } }
      );
    }

    const body = await res.text();
    const out = new Response(body, {
      status: 200,
      headers: {
        ...corsHeaders(request, env),
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        'X-Proxy-Cache': 'MISS',
        'X-RateLimit-Remaining': res.headers.get('x-rate-limit-remaining') || '',
      },
    });

    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  },
};
