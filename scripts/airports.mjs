// Builds data/airports.json, the list airport view uses to tell when someone is
// at an airport and how high its field is. Source: OurAirports
// (https://ourairports.com/data/, public domain).
//
//   curl -LO https://davidmegginson.github.io/ourairports-data/airports.csv
//   node scripts/airports.mjs airports.csv
//
// Kept: every large and medium airport, plus small ones with scheduled service --
// the places someone might stand at a window watching planes. About 6,000.
// Each entry is [code, lat, lon, elevation in metres or null, size], size being
// 'l', 'm' or 's'. Rerun now and then; airports rarely change.

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const src = process.argv[2];
if (!src) {
    console.error('usage: node scripts/airports.mjs airports.csv');
    process.exit(1);
}

// OurAirports quotes every text field and doubles quotes inside them.
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
}

const [header, ...rows] = parseCsv(readFileSync(src, 'utf8'));
const col = Object.fromEntries(header.map((name, i) => [name, i]));
const SIZE = { large_airport: 'l', medium_airport: 'm', small_airport: 's' };

const out = [];
for (const r of rows) {
    const size = SIZE[r[col.type]];
    if (!size) continue;
    if (size === 's' && r[col.scheduled_service] !== 'yes') continue;
    const elevFt = r[col.elevation_ft];
    out.push([
        r[col.iata_code] || r[col.icao_code] || r[col.ident],
        +Number(r[col.latitude_deg]).toFixed(4),
        +Number(r[col.longitude_deg]).toFixed(4),
        elevFt === '' ? null : Math.round(Number(elevFt) * 0.3048),
        size,
    ]);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
writeFileSync(join(root, 'data', 'airports.json'), JSON.stringify(out));
console.log(`wrote data/airports.json: ${out.length} airports`);
