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

// Fallback for when adsb.fi refuses or fails, so one provider's rate limit or
// outage doesn't blank the sky for everyone. Same v2 aircraft fields, already
// under `ac`, and it answers datacenter IPs too. Fallback only, never primary:
// its headers advertise 4/s, 60/min and just 500/day per IP, which steady
// traffic would exhaust by mid-morning. Data is ODbL -- credited on the start
// screen alongside adsb.fi.
const FALLBACK = 'https://api.adsb.lol/v2';

// adsb.fi allows 1 request/second and counts 4xx responses toward a limit that
// earns a temporary IP ban. Every visitor's poll now arrives from this one
// function rather than from their own phone, so the ceiling is shared: without
// throttling, six people with the app open would exceed it on their own.
const MIN_UPSTREAM_SPACING_MS = 1100;

// The browser polls every 10s. Serving anything younger than this from cache
// keeps a single viewer to roughly one upstream call per poll while letting
// several viewers in the same area share one.
//
// This in-memory cache only helps viewers who land on the same warm instance,
// which under concurrency they mostly don't: each Lambda instance handles one
// request at a time, so simultaneous viewers fan out to separate instances. The
// edge cache (CDN_CACHE below) is what actually dedupes across viewers.
const CACHE_TTL_MS = 8000;

// Netlify's edge caches function responses that ask for it, keyed on the full
// URL -- the browser snaps its coordinates to GRID_DEG so that everyone in a
// grid cell sends the same one. `durable` shares the entry across edge nodes
// rather than each node fetching its own. Kept just under the 10s poll so a
// steady viewer still sees each new answer; stale-while-revalidate lets a burst
// on an expired entry get the old answer while one request refreshes it.
// The browser itself must not cache, or it would never ask the edge again.
const CDN_CACHE = 'public, durable, s-maxage=8, stale-while-revalidate=10';

// In practice the Netlify cache above rarely hits: the durable layer reports
// fwd=bypass and the per-node edge cache is spread too thin. jetlens.app sits
// behind Cloudflare, which reads only this header (Netlify passes it through
// untouched), and a Cache Rule there makes /api/planes eligible for caching.
// Tiered Cache funnels its edge locations through one upper tier, so a busy grid
// cell costs one upstream call per 8s however many people are looking at it.
const CLOUDFLARE_CACHE = 'public, max-age=8, stale-while-revalidate=10';

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

async function fetchUpstream(name, url) {
    // Without a timeout a hung upstream would hold the function open until
    // Netlify kills it, and the browser would sit on a stale sky meanwhile.
    // 4s each so a primary timeout plus the fallback still fits in one poll.
    const res = await fetch(url, {
        signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': 'JetLens (https://github.com/briangunzenhauser/jetlens)' }
    });

    if (!res.ok) {
        const err = new Error(`${name} returned ${res.status}`);
        err.status = res.status;
        err.retryAfter = res.headers.get('Retry-After');
        throw err;
    }

    return res.json();
}

// Only fresh upstream answers are edge-cacheable. Errors must not be, and nor
// must a stale fallback, or the edge would keep serving it after recovery.
const json = (status, body, cacheable = false, extraHeaders = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...(cacheable
                ? {
                      'Cache-Control': 'public, max-age=0, must-revalidate',
                      'Netlify-CDN-Cache-Control': CDN_CACHE,
                      'Cloudflare-CDN-Cache-Control': CLOUDFLARE_CACHE
                  }
                : { 'Cache-Control': 'no-store' }),
            ...extraHeaders
        }
    });

// Functions API v2 (Request in, Response out) rather than the Lambda-style
// handler(event): Netlify documents the durable cache only for this format, and
// the Lambda-style version's responses were never stored there -- each edge node
// kept its own copy, so viewers on different nodes each cost an upstream call.
export default async (req) => {
    const params = new URL(req.url).searchParams;
    // `?? NaN` because a missing param is null, and Number(null) is 0 -- which
    // would pass the range checks below as a real coordinate off West Africa.
    const lat = Number(params.get('lat') ?? NaN);
    const lon = Number(params.get('lon') ?? NaN);
    const radius = Number(params.get('radius') ?? NaN);

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
        return json(200, hit.body, true);
    }

    // Two viewers of the same patch of sky landing together shouldn't each open
    // their own upstream call; the second waits on the first and they share it.
    const pending = inFlight.get(key);
    if (pending) {
        try {
            return json(200, await pending, true);
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

        let body;
        try {
            const data = await fetchUpstream(
                'adsb.fi',
                `${UPSTREAM}/lat/${gridLat.toFixed(4)}/lon/${gridLon.toFixed(4)}/dist/${radius}`
            );
            // adsb.fi returns the aircraft under `aircraft`; the v2 shape this app
            // was written against calls it `ac`. Every field inside is identical,
            // so normalizing the one key is the whole translation.
            body = { ac: data.aircraft ?? data.ac ?? [], now: data.now };
        } catch (primaryError) {
            try {
                const data = await fetchUpstream(
                    'adsb.lol',
                    `${FALLBACK}/point/${gridLat.toFixed(4)}/${gridLon.toFixed(4)}/${radius}`
                );
                // adsb.lol dates its answer in milliseconds, adsb.fi in seconds.
                body = { ac: data.ac ?? [], now: data.now / 1000 };
            } catch {
                // Report the primary's failure: its 429 and Retry-After are what
                // the browser's backoff is tuned around.
                throw primaryError;
            }
        }

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
        return json(200, await attempt, true);
    } catch (error) {
        // A stale sky beats no sky: if the upstream just failed but we hold a
        // recent answer for this spot, serve it rather than blanking the map.
        const stale = cache.get(key);
        if (stale) return json(200, stale.body);

        const status = error.status === 429 ? 429 : 502;
        return json(
            status,
            { error: String(error.message || 'upstream request failed') },
            false,
            error.retryAfter ? { 'Retry-After': error.retryAfter } : {}
        );
    } finally {
        if (inFlight.get(key) === attempt) inFlight.delete(key);
    }
};

// Served at the app's own URL directly instead of through a netlify.toml rewrite
// to /.netlify/functions/planes, so nothing sits between the edge cache and the
// function's headers.
export const config = { path: '/api/planes' };
