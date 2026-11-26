# Arise's web connector

Arise for AI apps on the web: claude.ai, ChatGPT, Gemini and any app that takes a remote MCP server address (Streamable HTTP). It runs the same tools as the MCP server for desktop apps (`mcp/core.mjs`) for one app's me link, plus `search`, `fetch` and, if the person allowed them, `add_note`, `add_todo`, `list_files`, `read_file` and `save_file`.

- **Address:** `https://arise-connector.<you>.workers.dev/mcp/<id>.<key>`, which Arise shows for each app once the web is on for it. It's a page of its own (a `shares/<id>` page like a me link's), apart from the app's link, so the AI app never gets the link. Turning the web off empties that page for good; so does Arise after the end date. The address is the only secret.
- **Only when allowed:** a page works here only if it says so (`web` in the page, which only the person's account can write), and only until the date they picked.
- **What it keeps:** for each address, a log of which tools the app used and when, and the notes it added, sealed with a key made from the page's key (`src/lib/feed.ts`). Reading the log back, or letting it go, needs a token only the person's Arise has; the page holds its SHA-256, and the connector checks against that, so the AI app can't read or wipe its own log. Arise takes them and they're deleted; anything left goes after 60 days unused (only a count stays). No request logs.
- **The person's rules:** from 1.1.0 it keeps to the rules in the page (`rules`: ask first, never, house rules), through `mcp/core.mjs`: what a rule says never isn't offered, what it says to ask first is sealed in the log as a request (`ask`) that their Arise shows them, and the house rules go with every answer. `/health` says `"features":["rules"]`; until it does, Arise says the connector needs its update (and still checks what the app adds against the rules itself). A page without rules works as before.
- **Switches and files (1.2.0):** the page says what the app may do: read about the person (unless `web.read` is `false`), add notes and to-dos (`web.notes`), and, for one folder they share with it, read its files and save files there (`web.files`). `list_files` and `read_file` only see the files the page lists (`files`): a small one is in the page, a bigger one is in sealed parts, each a `shares/<id>` page under a key made from the page's key (`src/lib/me-files.ts`), which this fetches and opens only while it answers. `save_file` seals the file in the log, like a note (a saved file is kept under a key of its own, at most 10 waiting). The rules apply on top (`file`: ask first or never). `/health` says `"features":["rules","files"]`; until it does, Arise keeps the file switches off and says the connector needs its update. A page without these works as before.
- **Less private:** while it answers, this Worker (and Cloudflare) could read what that app gets. The app says so before it can be turned on.

## Set it up

`bash scripts/setup-workers.sh` deploys it with the other two Workers and puts its address into `src/connector-config.ts`. Nothing to create first: the Durable Object and rate limits come from `wrangler.toml`.

By hand: `cd worker/connector && npx -y wrangler@4 deploy`, then put the address it prints into `src/connector-config.ts`.

Check it: `curl https://arise-connector.<you>.workers.dev/health` answers `{"ok":true,"name":"arise-connector",…}`.
