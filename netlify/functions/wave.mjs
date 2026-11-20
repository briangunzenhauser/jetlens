// Waves: someone on the ground sends one of four emojis to a plane, and people on
// board see it once their phone has shown it's on that plane, in the air. A
// passenger's wave back reaches only the people who waved in the hour before it.
// Behind ?wave for testing; see the "Waves" section in index.html.
//
// Test only, so it's deliberately simple:
//   - Access is a private link. Only the SHA-256 of its key is here, since this
//     repo is public. Every request carries the key.
//   - Storage is Netlify Blobs, one small entry per wave, reply and proof, kept
//     RETENTION_MS and then deleted. Fine for a handful of testers; a real launch
//     would move to something built for live traffic (e.g. a Durable Object per
//     flight).
//   - The "on board" proof is the phone's own GPS, checked against the live feed
//     in the browser, so a determined person can fake it. The stakes are emojis.
//   - A flight is the aircraft's address plus its callsign. An airline that keeps
//     one flight number across several stops (Southwest does) would carry waves
//     from one leg to the next within RETENTION_MS. Known hole.
//
// Senders' places come from their phone's position, which the browser rounds to
// about 5 km before sending, named from GeoNames' town list. Nothing finer than
// a town name is stored, and no wave is tied to a person.

import { getStore } from '@netlify/blobs';
import places from '../../data/places.mjs';

const KEY_HASHES = new Set([
    // The test link in refs/wave-test-link.txt (not committed).
    '9e68eacdf4cdd0eb2ba4ef4664bfab5bf0830e89f7a6ed21bc25b52badda3973',
]);

const EMOJIS = new Set(['👋', '👀', '👂', '❤️']);
const RETENTION_MS = 12 * 60 * 60 * 1000;
const REPLY_WINDOW_MS = 60 * 60 * 1000;
const SEND_GAP_MS = 2 * 60 * 1000;
const REPLY_GAP_MS = 60 * 1000;
// A reply needs a proof this recent; reading the summary needs any proof on the
// flight, so waves sent while the passenger was offline still reach them.
const FRESH_PROOF_MS = 10 * 60 * 1000;
// What "in the air" means. A phone on the ground can't reach either.
const AIRBORNE_MIN_ALT_M = 3000;
const AIRBORNE_MIN_SPEED_MS = 100;

const json = (status, body) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

async function sha256(text) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const clean = (s, max) => String(s ?? '').replace(/[^0-9A-Za-z-]/g, '').slice(0, max);
const flightId = (hex, callsign) => `${clean(hex, 6).toLowerCase()}-${clean(callsign, 8).toUpperCase() || 'NOCS'}`;
const validFlight = f => /^[0-9a-f]{6}-[0-9A-Z]{1,8}$/.test(f || '');

// --- Naming a place ---
// The biggest town within NEAR_KM ("Lancaster, PA"); else the biggest within
// AROUND_KM ("near Lancaster, PA"); else the state, province or country.
const NEAR_KM = 10;
const AROUND_KM = 40;

function distanceKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
        Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
}

export function placeName(lat, lon) {
    let near = null, around = null, closest = null, closestD = Infinity;
    const dLon = 0.6 / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    for (const p of places) {
        const [, , plat, plon, pop] = p;
        if (Math.abs(plat - lat) > 0.6 || Math.abs(plon - lon) > dLon) continue;
        const d = distanceKm(lat, lon, plat, plon);
        if (d < closestD) { closest = p; closestD = d; }
        if (d <= NEAR_KM && (!near || pop > near[4])) near = p;
        if (d <= AROUND_KM && (!around || pop > around[4])) around = p;
    }
    if (near) return `${near[0]}, ${near[1]}`;
    if (around) return `near ${around[0]}, ${around[1]}`;
    if (closest) return closest[5];
    // Empty country (a desert, the mountains): the region of the closest town
    // within a few hundred km. Out at sea, nothing.
    for (const p of places) {
        if (Math.abs(p[2] - lat) > 3 || Math.abs(p[3] - lon) > 4) continue;
        const d = distanceKm(lat, lon, p[2], p[3]);
        if (d < closestD) { closest = p; closestD = d; }
    }
    return closest ? closest[5] : 'somewhere below';
}

// --- Storage helpers ---
async function listValues(store, prefix) {
    const { blobs } = await store.list({ prefix });
    const values = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
    return values.filter(Boolean);
}

// Waves and replies are keyed "<prefix><time>-<device>", so old ones can be found
// and deleted without reading them. Proofs and send limits carry their time inside.
async function sweep(store, now) {
    try {
        const { blobs } = await store.list();
        for (const { key } of blobs) {
            const stamp = Number(key.split('/').pop().split('-')[0]);
            if (Number.isFinite(stamp) && stamp > 1e12) {
                if (now - stamp > RETENTION_MS) await store.delete(key);
            } else {
                const v = await store.get(key, { type: 'json' });
                if (!v || now - (v.t ?? 0) > RETENTION_MS) await store.delete(key);
            }
        }
    } catch (error) {
        console.log('wave sweep failed:', error);
    }
}

export default async (req, context) => {
    if (req.method !== 'POST') return json(405, { error: 'POST only' });
    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'bad JSON' }); }

    if (!body.key || !KEY_HASHES.has(await sha256(String(body.key)))) {
        return json(403, { error: 'This wave link is not valid.' });
    }
    const device = clean(body.device, 32);
    if (device.length < 16) return json(400, { error: 'device id missing' });

    const store = getStore({ name: 'waves', consistency: 'strong' });
    const now = Date.now();

    switch (body.action) {
        case 'send': {
            if (!EMOJIS.has(body.emoji)) return json(400, { error: 'unknown emoji' });
            const lat = Number(body.lat), lon = Number(body.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(400, { error: 'position missing' });
            const flight = flightId(body.hex, body.callsign);
            if (!validFlight(flight)) return json(400, { error: 'plane missing' });

            const limitKey = `l/${flight}/${device}`;
            const last = await store.get(limitKey, { type: 'json' });
            if (last && now - last.t < SEND_GAP_MS) {
                return json(429, { error: 'too soon', retryAfterS: Math.ceil((SEND_GAP_MS - (now - last.t)) / 1000) });
            }
            const place = placeName(lat, lon);
            await store.setJSON(`w/${flight}/${now}-${device}`, { t: now, emoji: body.emoji, place, device });
            await store.setJSON(limitKey, { t: now });

            // Others who waved at this plane from the same place in the last hour.
            const recent = await listValues(store, `w/${flight}/`);
            const nearby = new Set(recent
                .filter(w => w.device !== device && w.place === place && now - w.t < REPLY_WINDOW_MS)
                .map(w => w.device)).size;

            context.waitUntil(sweep(store, now));
            return json(200, { ok: true, flight, t: now, place, nearby, againInS: SEND_GAP_MS / 1000 });
        }

        case 'replies': {
            // The sender's own waves, as the browser remembers them: replies count
            // for a wave if they came within the hour after it.
            const waves = (Array.isArray(body.waves) ? body.waves : []).slice(0, 20)
                .filter(w => validFlight(w.flight) && Number.isFinite(w.t) && now - w.t < REPLY_WINDOW_MS + 60000);
            const out = [];
            for (const w of waves) {
                const replies = await listValues(store, `r/${w.flight}/`);
                for (const r of replies) {
                    if (r.t >= w.t && r.t <= w.t + REPLY_WINDOW_MS) out.push({ flight: w.flight, emoji: r.emoji, t: r.t });
                }
            }
            return json(200, { replies: out });
        }

        case 'board': {
            const altM = Number(body.altM), speed = Number(body.speedMs);
            const airborne = (Number.isFinite(altM) && altM >= AIRBORNE_MIN_ALT_M) ||
                (Number.isFinite(speed) && speed >= AIRBORNE_MIN_SPEED_MS);
            if (!airborne) return json(403, { error: 'not airborne' });
            const flight = flightId(body.hex, body.callsign);
            if (!validFlight(flight)) return json(400, { error: 'plane missing' });
            const proofKey = `p/${flight}/${device}`;
            const prior = await store.get(proofKey, { type: 'json' });
            await store.setJSON(proofKey, { t: now, first: prior?.first ?? now });
            // The town under the plane, for "35,000 ft over Lancaster, PA".
            const lat = Number(body.lat), lon = Number(body.lon);
            const below = Number.isFinite(lat) && Number.isFinite(lon) ? placeName(lat, lon) : null;
            return json(200, { ok: true, flight, first: prior?.first ?? now, below });
        }

        case 'feed': {
            const flight = String(body.flight || '');
            if (!validFlight(flight)) return json(400, { error: 'plane missing' });
            const proof = await store.get(`p/${flight}/${device}`, { type: 'json' });
            if (!proof) return json(403, { error: 'not on board' });
            const raw = await listValues(store, `w/${flight}/`);
            const waves = raw.map(w => ({ t: w.t, emoji: w.emoji, place: w.place }))
                .sort((a, b) => b.t - a.t);
            // How many people a wave back would reach right now.
            const wavers = new Set(raw.filter(w => now - w.t <= REPLY_WINDOW_MS).map(w => w.device)).size;
            const mine = (await listValues(store, `r/${flight}/`))
                .filter(r => r.device === device).map(r => ({ t: r.t, emoji: r.emoji }));
            return json(200, { waves, mine, wavers, proofAgeS: Math.round((now - proof.t) / 1000) });
        }

        case 'reply': {
            if (!EMOJIS.has(body.emoji)) return json(400, { error: 'unknown emoji' });
            const flight = String(body.flight || '');
            if (!validFlight(flight)) return json(400, { error: 'plane missing' });
            const proof = await store.get(`p/${flight}/${device}`, { type: 'json' });
            if (!proof || now - proof.t > FRESH_PROOF_MS) return json(403, { error: 'not on board' });
            const limitKey = `l/${flight}/${device}-r`;
            const last = await store.get(limitKey, { type: 'json' });
            if (last && now - last.t < REPLY_GAP_MS) {
                return json(429, { error: 'too soon', retryAfterS: Math.ceil((REPLY_GAP_MS - (now - last.t)) / 1000) });
            }
            await store.setJSON(`r/${flight}/${now}-${device}`, { t: now, emoji: body.emoji, device });
            await store.setJSON(limitKey, { t: now });
            // Everyone who waved in the hour before this reply receives it.
            const reached = new Set((await listValues(store, `w/${flight}/`))
                .filter(w => w.t <= now && now - w.t <= REPLY_WINDOW_MS).map(w => w.device)).size;
            context.waitUntil(sweep(store, now));
            return json(200, { ok: true, t: now, reached });
        }

        default:
            return json(400, { error: 'unknown action' });
    }
};

export const config = { path: '/api/wave' };
