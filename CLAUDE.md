# Arise: notes for working on this repo

Arise is a private, self-updating coach for your whole life: it writes your days down, asks how you are, shows what helps, and has goals when you want them (fitness has a full workout plan). Live at https://abyyworld.github.io/arise/. Version is in `package.json`. README.md is the user guide, `docs/LAUNCH.md` the owner's setup steps and the roadmap, `public/privacy.html` the privacy policy.

## Commands

- `npm ci`, then `npm run check` (typecheck, every test, production build). This is exactly what the required CI check `check` runs. Node 22 or newer.
- `npm run dev` for a local server. Tests are Vitest under jsdom; the worker tests live in `worker/*/src` and run with the rest.

## How a change ships

1. Work on a branch, open a pull request to `main`. `main` is protected: the **Checks** workflow (`check`) must pass and changes go through a pull request.
2. Merging to `main` runs `deploy.yml` (GitHub Pages) and `ios.yml` (the unsigned `Arise.ipa` on the `ios-latest` release). Every installed copy (web, home screen, laptop, sideloaded iPhone app) then updates itself; nobody reinstalls.
3. A change people will notice: bump `version` in `package.json` and add an entry at the top of `src/changelog.ts`. That's the "What's new" sheet after the update.

## Map

- `src/main.ts` boots the app (`src/app.js` is the UI; `src/share-view.ts` is the page a friend sees from a share link). `src/native-boot.ts` must stay the first import.
- To-dos (one-off things to do, on Today): model and merge `src/lib/todos.ts` (its own per-item merge with tombstones, synced since SCHEMA 8), store functions in `src/store.ts`, card and its sheet `src/todos-ui.js` (on the Calendar too), reminders at their time in `native.js` (`todoReminders`) and, in the web app while open, `src/todo-alerts.js`; the coach sees them (`buildContext` in `src/ai.js`) and web AI apps can add them (`add_todo`).
- Calendar (its own tab, `calendar-ui.js`: month, week, day and list; your events, to-dos and the life log's calendar events, each source with its colour and a filter): your own events are `src/lib/events.ts` (wall times with their IANA time zone, repeats worked out with `expand` from `src/connect/ics.ts`, one time skipped or changed by its key, the same per-item merge with tombstones as to-dos, synced since SCHEMA 10), .ics in and out `src/lib/events-ics.ts`, store functions in `src/store.ts`. Reminders only on the device: `eventReminders` in `native.js` and `src/todo-alerts.js` (never the reminders Worker, so no server learns event times). The coach sees the next 7 days (`buildContext`). AI apps can't add events yet (that needs a new connector tool and a Worker deploy).
- Looking ahead (1.31): the plan for the day and week, early warnings and next-step messages are worked out on the device with no AI in `src/lib/ahead.ts` (pure), gathered from the store, `life/insight.ts` (sleep, wake) and the life log (calendars, people in touch) in `src/ahead.ts`, shown by `src/ahead-ui.js` (Today cards, the week sheet, Settings, Your plan and next steps). Next-step messages go to `native.js` (`useNudges`, ids 8000+) and, on the web while open, `todo-alerts.js`; never to the reminders Worker. Decisions: model and merge `src/lib/decisions.ts` (per item with tombstones, synced since SCHEMA 11, with the warnings put away in `dismissed`), advice `adviseDecision` in `src/ai.js`, the sheet in `ahead-ui.js` on Coach; the coach reads the plan (`useAhead`) and past decisions (`decisionsText`), each only as far as its AI may.
- Data: `src/store.ts`; every field coming from storage, sync or a backup goes through `src/lib/validate.ts`, so a new setting or field needs a `clean*` rule there too.
- Sign in with Google (1.32, web only, opt-in, less private): a plain pop-up and an ID token in `src/signin-google.ts` (no Google script in Arise; reuses `connect/oauth.ts` with its own `SIGNIN` keys in `connect/return.ts`), then `signInWith`, `makeWith`, `unlockWith`, `link` in `src/account.ts` and the steps in `src/sync.ts` (`status.with`). A second way into an email account, never around its password. Client ID in `SIGN_IN_WITH` (`src/firebase-config.js`); console setup in `docs/LAUNCH.md`.
- Sync, end-to-end encrypted: `src/sync.ts`, `src/account.ts`, `src/lib/crypto.ts`, `src/lib/keystore.ts`, `src/lib/merge.ts`. Bump `SCHEMA` in `src/sync.ts` when the shape of synced data changes in a way an older app would lose.
- Database rules: `firestore.rules`. The server only ever holds ciphertext and the rules refuse anything else.
- AI: `src/ai.js` (engines: private Tinfoil enclave through `worker/ai-proxy`, free Workers AI marked less private, on-device Chrome on laptops, the person's own key). Addresses in `src/ai-config.ts`.
- Reminders: texts in `src/reminders.js`; web push through `src/web-reminders.ts` and `worker/reminders` (a Durable Object alarm); the iPhone app schedules its own in `src/native.js`.
- Updates: `src/update.ts` (service worker `src/sw.ts` on the web, `src/native-update.ts` in the iPhone app), `scripts/native-bundle.mjs`.
- App lock: `src/lib/lock.ts`, `src/app-lock.js`. Sharing: `src/share.ts`, `src/lib/share.ts`.
- Arise as "me" for other apps (About me, connected apps' me links, in What Arise knows): format `src/lib/me.ts` ("arise.me/v1", same `shares/{id}` pages as shared goals, sealed for `me/<id>`), links `src/me.ts` (on this device only), screen `src/life/me-ui.js`; the reader app makers load `public/me.js` (`docs/ME-LINK.md`); the MCP server `mcp/` (protocol in `mcp/core.mjs`, stdio in `server.mjs`; tested with the rest). AI apps on the web (claude.ai, ChatGPT, Gemini): the connector Worker `worker/connector` runs `mcp/core.mjs` over HTTP for links whose page has `web` (per app, opt-in, "Less private", with an end date and an optional notes switch); its sealed access log and notes are `src/lib/feed.ts`, read back by `pullFeeds` in `src/me.ts`; address in `src/connector-config.ts`. What Eternal has that Arise doesn't: `docs/ETERNAL-GAPS.md`.
- Calendars by link: `src/connect/ics.ts` (parser), `src/connect/ics-feeds.ts` (sync), helper `worker/calendar`, address in `src/calendar-config.ts`. Google Drive: `src/connect/drive.ts`. Quick notes with a file: `src/life/quick-note.ts` (its file store is set in `src/life/screens.js` to Photos and files).
- Search by meaning in the Days search (on the device, no AI): `find` in `src/life/embed/index.ts`, used by `runSearch` in `src/life/screens.js`. With the search model downloaded (Search by meaning on Days, `src/life/meaning-ui.js`; sources pinned with SHA-256 in `src/life/embed/model.ts`, run in `embed/worker.ts` with onnxruntime-web, our own tokenizer in `embed/tokenizer.ts`), the closest events by meaning; otherwise the related-word groups in `src/life/meaning.ts` through `search(..., { words })` in `src/life/log.ts`. The coach's lookup (`notesFor` in `memory.ts`) uses `byMeaning` too. `ortWasmStaysOut` in `vite.config.ts` keeps the engine's 15 MB WebAssembly out of the build (it's downloaded on the person's choice); keep `ORT_VERSION` in `model.ts` equal to the onnxruntime-web version in `package.json` (a test checks).
- Photos and files (end-to-end encrypted, kept on the device in IndexedDB 'arise-my-files' and synced as sealed parts in the life log's own Firestore folder under the same rules, no new rule): the storage API `src/life/files.ts` (putFile, getFile, listFiles, deleteFile, attachToNote), local store `files-store.ts`, sealing `files-seal.ts` (keys derived from the life key in `seal.ts`), sync `files-sync.ts` (a `FileRemote` interface, Firestore now), screen `src/life/files-ui.js`.
- Importers (Google Takeout, Maps Timeline, Spotify, Netflix, Apple Health, WhatsApp, bank CSV, the chat apps Telegram, Instagram, Messenger, X, TikTok, Snapchat, Discord, LinkedIn, and the AI apps Claude, ChatGPT, Gemini with a picker before import and delete per chat or per app after): `src/life/import/` (one parser per source, `index.ts` has `detect`/`importFile`, run in the worker `worker.ts` through `client.ts`), screen `src/life/import-ui.js`. The chat apps share `chat.ts` (one event per chat per day, the WhatsApp rule for text) and read deep JSON with `json-paths.ts`; a zip's files for one app are read together as one part (`Found.parts`). Events go to the life log through `src/life/store-port.ts`.
- Life log sync (end-to-end encrypted, monthly packs under a life key wrapped by the data key, HMAC doc ids, tombstones and wipes): `src/life/cloud.ts`, `packs.ts`, `seal.ts`; rules tested with `scripts/test-rules.mjs` on the emulator.
- Browser extension (Manifest V3, Chrome/Edge/Firefox): `extension/` (pure logic in `extension/src/lib/`, built by `npm run ext:build` into the Pages site); Arise side `src/life/browser-link.ts`, `src/life/browser-ui.js`.
- Mac helper (calls, notifications, Messages, Safari, app use; a LaunchAgent serving 127.0.0.1 with an HMAC handshake): `mac-helper/` (install with `mac-helper/install.sh`); Arise side `src/life/mac-link.ts`, `src/life/mac-panel.js`.
- What the iPhone app reads for the life log (Apple Health, motion, calendar, places, Shortcuts "Log to Arise"): `src/life/sense.ts`, events made in `src/life/sense-map.ts`, Settings panel in `src/life/sense-ui.ts` (hidden, and nothing read, until the build has the life log: `hasLifeStore()` in `src/life/store-port.ts`). Native side: `ios/App/App/AriseSense.swift`, `AriseInbox.swift`, `LogToArise.swift`, plus `@capgo/capacitor-health`. Pull requests build the iPhone app too (`ios.yml`, no publishing), so Swift is compiled before it reaches `main`.

## Things only the owner can do

Claude can't reach Firebase, Cloudflare or Tinfoil from a cloud session, so changes to these need the owner to run a command on their Mac:

- **`firestore.rules` changed:** `npx -y firebase-tools@13.35.1 deploy --only firestore:rules --project arise-a7349`. Test rules first with the emulator (needs Java): `npx -y firebase-tools@13.35.1 emulators:exec --only firestore --project demo-arise "<test command>"`.
- **`worker/` changed:** `bash scripts/setup-workers.sh` from a copy of the repo (press Return at the Tinfoil key and at the Arise Private questions to keep what's there, and answer **n** to putting the addresses on GitHub, since they're already there).

The one command that does both, straight from GitHub:

```
cd "$(mktemp -d)" && curl -sL https://github.com/abyyworld/arise/archive/refs/heads/main.tar.gz | tar xz && cd arise-* && bash scripts/setup-workers.sh && npx -y firebase-tools@13.35.1 login && npx -y firebase-tools@13.35.1 deploy --only firestore:rules --project arise-a7349 && echo "All set."
```

## Open items (October 2026)


- **Owner, for 1.30:** run the one command above once. `firestore.rules` gained the sign-out-everywhere document (until deployed, "Sign out of all devices" and deleting an account fail), and `worker/calendar` (the fetch-only helper for calendars by link on the web) is new. For Google Drive: enable the Google Drive API and add the `drive.readonly` scope in Google Cloud (`docs/LAUNCH.md`); Google stays "Coming soon" until `GOOGLE.clientId` is set.
- **Owner: run the command above once for 1.3**, if it hasn't been run since 1.3 went live. The rules for email-reset accounts and share links, and the free AI (its Workers AI binding and second model), need it. Until then those three don't work.
- **Owner: run the command above once more after the Android app is merged**, even if it ran for 1.3. The AI server only accepts the Android app's address (`https://localhost`, in `worker/ai-proxy/wrangler.toml`) once it's deployed again. Until then every AI question from the Android app is refused ("This origin may not use the Arise AI."). Also add the Android signing key once (`docs/LAUNCH.md`, Signing the Android app).
- **Owner: run the command above once for 1.18** (AI apps on the web). It deploys the new connector Worker (`worker/connector`). Until then Arise says the connector isn't answering, and Claude or ChatGPT on the web can't reach it.
- **Renamed to `abyyworld/arise` (1.27).** The old name is a small repo that keeps the old address working (`docs/LAUNCH.md`, The old address); don't delete it or turn off its Mirror workflow. When Google or Microsoft sign-in is set up (`src/connect-config.ts`), register `https://abyyworld.github.io/arise/` as the redirect address.
- **Owner: Tinfoil credit.** The private AI answers "out of credit" until the Tinfoil account has billing credit.
- **Owner: delete an obsolete old account** in the Firebase console (Authentication, Users, ⋮, Delete account). The owner knows which one.
- **Firebase App Check: on hold.** reCAPTCHA doesn't run inside the iPhone app (`capacitor://localhost`) and App Attest needs a paid Apple account; also never enforce it for Firestore, or share links break (see `docs/LAUNCH.md`).
- The rest of the roadmap is in `docs/LAUNCH.md`, What's next.

## Ground rules

- Never remove, skip or weaken a test to get a change through; fix the code.
- Plain words in anything a person reads (app text, README, LAUNCH): no jargon, short sentences.
- The owner prefers fast turnaround: one build and one review pass, not long review loops, and small changes without a separate review.
- Don't put anyone's email address or other personal details in the repo.

## Gotchas

- Byte arrays under jsdom: wrap Node `Buffer`s and fflate output in `new Uint8Array(...)`, or `instanceof Uint8Array` fails.
- `scripts/setup-workers.sh` must work in bash and zsh (macOS): no variable called `path` (zsh ties it to `PATH`).
- Adding a Capacitor plugin with iOS code changes the native key (`__APP_NATIVE__` in `vite.config.ts`). Phones then need the new `Arise.ipa` installed by hand once before they can take further updates.
- Arise's own Swift code in `ios/App/App` isn't a plugin, so the native key can't see it change: raise `OWN_NATIVE` in `vite.config.ts` whenever that code, `Info.plist` or `App.entitlements` changes in a way the web app relies on. Batch such changes, since each one means a reinstall.
