// Proxy for adsb.fi's open data API.
//
// This exists because of CORS, not because of IP blocking. airplanes.live sent
// `Access-Control-Allow-Origin: *`, which is why this app could call it straight
// from the browser and ship with no backend at all. In August 2026 airplanes.live
// closed its data endpoints to anonymous callers -- /v2/* now answers 403 with a
// "contact us" message, while /status and /stats stay open, so the host looks
// healthy and their status page stays green. That is global, not specific to us:
// an unrelated datacenter IP gets the same 403.
//
// Of the replacements, none send an ACAO header, so browser-direct is off the
// table for all of them and something server-side has to make the call. adsb.fi
// answers fine from datacenter IPs -- unlike OpenSky, whose blanket block on
// those ranges is what killed the *previous* proxy and pushed this app to
// airplanes.live in the first place. That failure mode does not apply here.
//
// Terms (https://github.com/adsbfi/opendata): personal, non-commercial use, 1
// request/second, attribution with a link required. The attribution is on the
// start screen; the rate limit is what the cache and spacing below are for.

const UPSTREAM = 'https://opendata.adsb.fi/api/v2';

// adsb.fi allows 1 request/second and counts 4xx responses toward a limit that
// earns a temporary IP ban. Every visitor's poll now arrives from this one
// function rather than from their own phone, so the ceiling is shared: without
// throttling, six people with the app open would exceed it on their own.
const MIN_UPSTREAM_SPACING_MS = 1100;

// The browser polls every 5s. Serving anything younger than this from cache
// keeps a single viewer to roughly one upstream call per poll while letting
// several viewers in the same area share one.
const CACHE_TTL_MS = 4000;

// Query coordinates are snapped to this grid before going upstream, so nearby
// viewers share a cache entry instead of each cutting their own. It also means
// adsb.fi never receives a visitor's exact position.
//
// The offset this introduces has to stay inside the app's own margin: it fetches
// a 50nm radius (92.6km) but only displays planes within 80km, leaving 12.6km of
// slack. Half a grid step is at most 2.8km of latitude and 2.4km of longitude at
// mid-latitudes -- about 3.7km combined, comfortably inside that.
const GRID_DEG = 0.05;

// Module scope survives between invocations on a warm instance, so these persist
// across polls. Netlify may run several instances concurrently, in which case
// each keeps its own -- the spacing below is a good-faith floor, not a guarantee.
const cache = new Map();
// Keyed by location: a single shared slot would hand a viewer in one city the
// aircraft over another, since whoever asked first owns the pending call.
const inFlight = new Map();
// The time the next upstream call is allowed to start. Reserved synchronously so
// that concurrent invocations queue up behind each other instead of all reading
// the same "last call" timestamp and firing together.
let nextUpstreamAt = 0;

const snap = (n) => Math.round(n / GRID_DEG) * GRID_DEG;

const json = (statusCode, body, maxAge = 0) => ({
    statusCode,
    headers: {
        'Content-Type': 'application/json',
        'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store'
    },
    body: JSON.stringify(body)
});

export const handler = async (event) => {
    const lat = Number(event.queryStringParameters?.lat);
    const lon = Number(event.queryStringParameters?.lon);
    const radius = Number(event.queryStringParameters?.radius);

    // Reject anything malformed here rather than passing it upstream, where a
    // 4xx would count against the IP that every visitor now shares.
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        return json(400, { error: 'lat must be a number between -90 and 90' });
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
        return json(400, { error: 'lon must be a number between -180 and 180' });
    }
    if (!Number.isFinite(radius) || radius <= 0 || radius > 250) {
        return json(400, { error: 'radius must be a number between 0 and 250' });
    }

    const gridLat = snap(lat);
    const gridLon = snap(lon);
    const key = `${gridLat.toFixed(2)}/${gridLon.toFixed(2)}/${radius}`;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return json(200, hit.body);
    }

    // Two viewers of the same patch of sky landing together shouldn't each open
    // their own upstream call; the second waits on the first and they share it.
    const pending = inFlight.get(key);
    if (pending) {
        try {
            return json(200, await pending);
        } catch {
            // The shared call failed. Fall through and try again below rather
            // than failing this request on someone else's error.
        }
    }

    // Claim the next slot before awaiting anything, so a second invocation
    // arriving now reserves the one after it rather than the same one.
    const slot = Math.max(Date.now(), nextUpstreamAt);
    nextUpstreamAt = slot + MIN_UPSTREAM_SPACING_MS;

    const attempt = (async () => {
        const wait = slot - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        // Without a timeout a hung upstream would hold the function open until
        // Netlify kills it, and the browser would sit on a stale sky meanwhile.
        const abort = AbortSignal.timeout(8000);
        const res = await fetch(
            `${UPSTREAM}/lat/${gridLat.toFixed(4)}/lon/${gridLon.toFixed(4)}/dist/${radius}`,
            { signal: abort, headers: { 'User-Agent': 'JetLens (https://github.com/briangunzenhauser/jetlens)' } }
        );

        if (!res.ok) {
            const err = new Error(`adsb.fi returned ${res.status}`);
            err.status = res.status;
            err.retryAfter = res.headers.get('Retry-After');
            throw err;
        }

        const data = await res.json();

        // adsb.fi returns the aircraft under `aircraft`; the v2 shape this app
        // was written against calls it `ac`. Every field inside is identical,
        // so normalizing the one key is the whole translation.
        const body = { ac: data.aircraft ?? data.ac ?? [], now: data.now };
        cache.set(key, { at: Date.now(), body });

        // Entries are per-location and this instance may live for hours, so
        // without a sweep a well-travelled app would grow the map forever.
        for (const [k, v] of cache) {
            if (Date.now() - v.at > CACHE_TTL_MS * 10) cache.delete(k);
        }

        return body;
    })();

    inFlight.set(key, attempt);

    try {
        return json(200, await attempt);
    } catch (error) {
        // A stale sky beats no sky: if the upstream just failed but we hold a
        // recent answer for this spot, serve it rather than blanking the map.
        const stale = cache.get(key);
        if (stale) return json(200, stale.body);

        const status = error.status === 429 ? 429 : 502;
        const headers = {};
        if (error.retryAfter) headers['Retry-After'] = error.retryAfter;
        return {
            ...json(status, { error: String(error.message || 'upstream request failed') }),
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
        };
    } finally {
        if (inFlight.get(key) === attempt) inFlight.delete(key);
    }
};
