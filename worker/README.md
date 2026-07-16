# OpenSky proxy

OpenSky's API sends `Access-Control-Allow-Origin: https://opensky-network.org`, so a
browser on any other origin is blocked from reading the response. This Worker sits in
front of it, adds the CORS headers, and holds the OpenSky credentials server-side.

Authenticating also raises the daily budget from 400 credits (anonymous, per-IP) to
4000 (registered).

## First deploy

1. Create an API client at https://opensky-network.org/my-opensky/api-clients to get
   a client ID and secret. This is *not* your website login; the username/password
   flow was retired.

2. Check `ALLOWED_ORIGINS` in `wrangler.toml`. It must be scheme + host only, with
   **no trailing path** — `https://boxandpixel.github.io`, not
   `https://boxandpixel.github.io/air/`.

3. From this directory:

   ```
   npm install -g wrangler
   wrangler login
   wrangler secret put OPENSKY_CLIENT_ID
   wrangler secret put OPENSKY_CLIENT_SECRET
   wrangler deploy
   ```

4. Copy the printed `*.workers.dev` URL into `PROXY_URL` near the top of the
   `<script>` block in `../index.html`, then commit and push.

## Moving the app to another host

Add the new origin to `ALLOWED_ORIGINS` (comma-separated) and `wrangler deploy`.
Keep the old origin listed until the move is finished so there's no gap, then
remove it. The Worker itself does not need to move — it is independent of wherever
the page is served from.

## Notes

- Responses are edge-cached for 8s. OpenSky only refreshes state vectors every
  5-10s, so this costs no freshness and cuts credit burn when several people use
  the app at once. The cache key is the upstream URL and CORS headers are rewritten
  per request, so one origin's response can't be served to another.
- `X-RateLimit-Remaining` is passed through — watch it in the network tab.
- `X-Proxy-Cache: HIT|MISS` shows whether a request cost a credit.
- The bbox params are validated as finite numbers before being forwarded, so the
  Worker can't be used to proxy arbitrary requests.
- The origin allowlist is anti-abuse, not a security boundary: only browsers enforce
  `Origin`. It stops other *websites* from spending your credits; it does not stop a
  determined script. If it ever gets abused, rotate the secrets and consider a
  signed token.
