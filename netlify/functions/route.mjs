// Route lookup from AeroDataBox: the primary route source while the monthly
// allowance is on pace, and the fallback when the free route file fails.
//
// The free source (vrs-standing-data) lists one route per flight number, and by
// November 2026 most of them no longer matched where the plane actually was:
// 4 of 15 live flights, mostly Southwest. AeroDataBox looks up the airframe
// itself (its ICAO 24-bit address) and returns the day's actual legs; it got 14
// of the same 15 right. FlightAware's AeroAPI was just as accurate but its
// Personal license forbids using it alongside another live feed (clause 12),
// which is exactly what this app does with adsb.fi.
//
// Terms (https://aerodatabox.com/terms/, Basic plan), and what each means here:
//   - Free plan = non-commercial only, and a visible credit linking to
//     aerodatabox.com without `noreferrer`. The credit is in the info panel.
//   - Cache only as long as needed, never more than 7 days (5.5). CACHE_TTL_MS
//     below is hours, and expired entries are deleted, not just ignored.
//   - No passing data on as a feed or API. This returns only the few fields the
//     panel shows, for one airframe at a time.
//   - 400 units/month, 2 per lookup, about 200 lookups. Past that the API rejects
//     calls until the cycle renews -- it never bills -- but MONTHLY_CAP stops us
//     a little short so the panel says "Unavailable" quietly instead. Within
//     that, spending is paced across the cycle; see PACE_HEAD_START.
//
// The key lives in the Netlify environment variable AERODATABOX_KEY (a RapidAPI
// key subscribed to AeroDataBox). Never put it in this repo: it's public.

import { getStore } from '@netlify/blobs';

const UPSTREAM = 'https://aerodatabox.p.rapidapi.com/flights/icao24';

// About 200 lookups fit in the quota. Stop at 170 so that racing instances, which
// can each read the same count before either writes it back, can't push us over.
const MONTHLY_CAP = Number(process.env.AERODATABOX_MONTHLY_CAP) || 170;

// RapidAPI renews units on the subscription date, not the 1st: the cycle runs
// from this day of the month. The subscription began on 2026-11-09.
const CYCLE_DAY = Number(process.env.AERODATABOX_CYCLE_DAY) || 9;

// One airframe flies several legs a day, and the answer is the whole day's list,
// so one lookup serves every tap on that plane for hours. The browser picks the
// current leg by clock and position, so a cached list doesn't go stale as the
// plane moves on to its next leg. An empty answer is kept for less time, in case
// AeroDataBox simply hadn't picked the flight up yet.
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 60 * 60 * 1000;

const json = (status, body) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

// Lookups the browser asks for *before* trying the free route ("first" mode) are
// only made while the cycle's spending is on pace: no more than its share of the
// cap for the time elapsed, plus this head start so a new cycle isn't blocked
// outright on day one. Past that pace, first-mode requests are declined and the
// browser uses the free route, coming back in fallback mode only if that fails.
// Fallback mode spends right up to the cap. So AeroDataBox is the primary source
// whenever the budget can afford it, and the allowance never runs dry early.
const PACE_HEAD_START = 5;

// The billing cycle a given moment falls in. `key` names it by its start date,
// e.g. "2026-11-09", and keys the counter so it resets itself each cycle.
function cycle(now = new Date()) {
    let y = now.getUTCFullYear();
    let m = now.getUTCMonth();
    if (now.getUTCDate() < CYCLE_DAY) m -= 1;
    if (m < 0) { m = 11; y -= 1; }
    const start = Date.UTC(y, m, CYCLE_DAY);
    const end = Date.UTC(y, m + 1, CYCLE_DAY);
    const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(CYCLE_DAY).padStart(2, '0')}`;
    return { key, start, end };
}

// How many lookups this cycle may have used by now and still be on pace.
function paceAllowance(now = Date.now()) {
    const { start, end } = cycle(new Date(now));
    return MONTHLY_CAP * ((now - start) / (end - start)) + PACE_HEAD_START;
}

// "2026-11-09 14:40Z" -> epoch ms. AeroDataBox puts a space where ISO wants a T.
const parseTime = (s) => (s ? Date.parse(s.replace(' ', 'T')) : null) || null;

// The best time AeroDataBox has for one end of a leg: actual (runway), then
// revised, then scheduled.
const bestTime = (end) =>
    parseTime(end?.runwayTime?.utc) ??
    parseTime(end?.revisedTime?.utc) ??
    parseTime(end?.scheduledTime?.utc);

// Only what the panel needs, in the same shape as the free route file's airports
// so the browser can treat both alike.
function airport(a) {
    if (!a) return null;
    return {
        icao: a.icao || null,
        iata: a.iata || null,
        name: a.name || a.shortName || null,
        location: a.municipalityName || null,
        countryiso2: a.countryCode || null,
        lat: a.location?.lat ?? null,
        lon: a.location?.lon ?? null
    };
}

function compactLegs(list) {
    return (Array.isArray(list) ? list : [])
        .map((f) => ({
            status: f.status || null,
            callsign: f.callSign || null,
            departs: bestTime(f.departure),
            arrives: bestTime(f.arrival),
            origin: airport(f.departure?.airport),
            destination: airport(f.arrival?.airport)
        }))
        .filter((l) => l.origin?.icao && l.destination?.icao);
}

export default async (req, context) => {
    const params = new URL(req.url).searchParams;
    const hex = (params.get('hex') || '').toLowerCase();
    // "first": the browser hasn't tried the free route yet, so only spend if on pace.
    const first = params.get('mode') === 'first';
    // Real ICAO addresses only. The feed marks non-ICAO (TIS-B) ones with a
    // leading ~, and AeroDataBox can't look those up anyway.
    if (!/^[0-9a-f]{6}$/.test(hex)) {
        return json(400, { error: 'hex must be a 6-digit ICAO address' });
    }

    const key = process.env.AERODATABOX_KEY;
    if (!key) return json(200, { legs: null, reason: 'not-configured' });

    const store = getStore({ name: 'aerodatabox', consistency: 'strong' });
    const now = Date.now();

    const cached = await store.get(`route/${hex}`, { type: 'json' });
    if (cached) {
        const ttl = cached.legs.length ? CACHE_TTL_MS : EMPTY_TTL_MS;
        if (now - cached.at < ttl) return json(200, { legs: cached.legs, cached: true });
        // Expired: delete rather than leave it, per the terms' caching rules.
        await store.delete(`route/${hex}`);
    }

    const counterKey = `usage/${cycle().key}`;
    const used = (await store.get(counterKey, { type: 'json' })) || 0;
    if (used >= MONTHLY_CAP) return json(200, { legs: null, reason: 'cap' });
    if (first && used >= paceAllowance(now)) {
        return json(200, { legs: null, reason: 'ahead-of-pace' });
    }
    // Counted before the call: a failed lookup may still cost units, and
    // undercounting is the direction that wastes calls on a spent quota.
    await store.setJSON(counterKey, used + 1);

    let legs;
    try {
        const res = await fetch(
            `${UPSTREAM}/${hex}?withAircraftImage=false&withLocation=false`,
            {
                signal: AbortSignal.timeout(6000),
                headers: {
                    'X-RapidAPI-Key': key,
                    'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com'
                }
            }
        );
        // 204 is how AeroDataBox says "no flights for this airframe today".
        if (res.status === 204) {
            legs = [];
        } else if (!res.ok) {
            console.log(`aerodatabox returned ${res.status} for ${hex}`);
            return json(200, { legs: null, reason: `upstream-${res.status}` });
        } else {
            legs = compactLegs(await res.json());
        }
    } catch (error) {
        console.log(`aerodatabox lookup failed for ${hex}:`, error);
        return json(200, { legs: null, reason: 'upstream-error' });
    }

    await store.setJSON(`route/${hex}`, { at: now, legs });
    // After the response, so the tap isn't kept waiting on housekeeping.
    context.waitUntil(sweep(store, now));
    return json(200, { legs, used: used + 1, cap: MONTHLY_CAP });
};

// Delete cache entries past their TTL. Taps on a given plane rarely repeat, so
// without this most entries would only expire on paper and sit in storage --
// which the terms don't allow past 7 days. Runs after each paid lookup, which is
// at most ~170 times a month over at most a few hundred keys.
async function sweep(store, now) {
    try {
        const { blobs } = await store.list({ prefix: 'route/' });
        for (const { key } of blobs) {
            const entry = await store.get(key, { type: 'json' });
            if (!entry || now - entry.at > CACHE_TTL_MS) await store.delete(key);
        }
    } catch (error) {
        console.log('aerodatabox cache sweep failed:', error);
    }
}

export const config = { path: '/api/route' };
