# Arise's visit counter

A small Cloudflare Worker that counts how many times each page of a person's website (Your website in Arise) was opened, per day. It's off unless the person turns on **Count visits** for their site, which Arise marks **Less private**.

- **What a page sends:** `POST /v1/hit` with `{"s": site id, "p": page}` (for example `{"s": "…", "p": "about"}`), with no cookies and no referrer. Pages don't send it when the visitor's browser asks sites not to track them (Global Privacy Control or Do Not Track).
- **What it keeps:** for each site, page and day (UTC), a number. Nothing about the visitor: it never reads or keeps an IP address, a browser's name, where they came from or a cookie, and it sets no cookies. It can't tell two visitors apart. Counts older than 400 days go. No request logs (`observability` is off). Cloudflare still sees the request on its way in, as it does for any website.
- **Sites:** Arise asks for one with `POST /v1/sites` and gets a public site id (it goes into the published pages) and a private read key (it stays on the person's device; only its SHA-256 is kept here). `POST /v1/read` with both gives the counts back, and `POST /v1/forget` deletes the site and all its counts. Only Arise's own addresses (`ALLOWED_ORIGINS` in `wrangler.toml`) may make, read or forget a site; a visit can come from any address.
- **Limits:** 300 visits a minute per site (counted per site, never per visitor), 200 different pages a day per site, 20 new sites a minute, `MAX_SITES` sites in all.

## Set it up

`bash scripts/setup-workers.sh` deploys it with the other Workers and puts its address into `src/visits-config.ts`. Nothing to create first: the Durable Object makes its own database.

By hand: `cd worker/visits && npx -y wrangler@4 deploy`, then put the address it prints into `src/visits-config.ts` (`server: 'https://arise-visits.<you>.workers.dev'`).

Check it: `curl https://arise-visits.<you>.workers.dev/health` answers `{"ok":true,"name":"arise-visits"}`.
