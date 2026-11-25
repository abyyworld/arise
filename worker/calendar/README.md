# Arise's calendar helper

A small Cloudflare Worker that fetches a calendar's private link (ICS or webcal) for the Arise web app, because most calendar servers don't let web pages read them. The phone apps never use it: they read calendars straight from the calendar's server. It also fetches one web page when the person presses "Keep a copy" on Your links.

- **Only when asked:** the web app goes through it only for a calendar where the person turned on "read it through Arise's helper", which the app marks **Less private**. Otherwise it tries the calendar's server straight from the browser and says when that doesn't work.
- **What it does:** `POST /fetch` with `{"url": "https://…"}` in the body (never in the address). It fetches that link (following up to 4 redirects), and answers with the calendar's text. Only text that starts like a calendar (`BEGIN:VCALENDAR`) is passed back, at most 5 MB.
- **Keep a copy:** `POST /page` with `{"url": "https://…"}`. It fetches that one page the same way (http or https only, never a private network), and passes it back only if the site says it's HTML (`text/html`), at most 2 MB, inside JSON (`{"url": where it ended up, "html": the page}`), so it's never shown as a page. No cookies go with it and none come back. Arise turns it into plain text on the device. The helper sees the page's address, nothing else of the person's.
- **What it keeps:** nothing. No storage, no request logs (`observability` is off), no cookies. While it fetches, it (and Cloudflare) could read the link and the events; that's why the app calls it less private.
- **Who may call it:** only Arise's own web address (`ALLOWED_ORIGINS` in `wrangler.toml`), at most 60 requests a minute per address, calendars and pages together. Links to this computer or a private network (localhost, 10.x, 192.168.x and so on) are refused.

## Set it up

`bash scripts/setup-workers.sh` deploys it with the other Workers and puts its address into `src/calendar-config.ts`. Nothing to create first.

By hand: `cd worker/calendar && npx -y wrangler@4 deploy`, then put the address it prints into `src/calendar-config.ts` (`server: 'https://arise-calendar.<you>.workers.dev'`).

Check it: `curl https://arise-calendar.<you>.workers.dev/health` answers `{"ok":true,"name":"arise-calendar"}`.
