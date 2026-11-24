# Arise's passkey helper

A small Cloudflare Worker that lets people sign in to Arise with a passkey (Face ID, Touch ID, Windows Hello, or a phone) instead of typing their password. Firebase has no passkeys of its own, so this checks the passkey and then gives the app a Firebase sign-in token for that account.

- **What it keeps:** for each passkey, its id, its public key, which account it signs in to, the name the person gave it, when it was added and last used. Nothing of anyone's data. A public key can only check a signature, so a copy of this store can't sign in to anything. No request logs (`observability` is off).
- **What it never sees:** the data, the password, or the secret that unlocks the data with a passkey. That secret is made by the passkey on the person's device (the WebAuthn `prf` extension) and stays there. The data key is wrapped with it in the account's keys document, next to the password and recovery code wraps.
- **How it checks:** WebAuthn by hand, with Web Crypto: ES256 and RS256 keys, the site (`rpId`), that the device checked who it is (face, fingerprint or screen lock), a one-time challenge for each request, and the signature. Tested with the WebAuthn spec's own test vectors.
- **Who may call it:** only Arise's own web address (`ALLOWED_ORIGINS` in `wrangler.toml`), at most 30 requests a minute per address. Adding, listing and removing passkeys need the account's sign-in (its Firebase ID token), and adding one needs a sign-in from the last 10 minutes.

## Set it up

`bash scripts/setup-workers.sh` deploys it with the other Workers, asks for the Firebase service account key file and saves it as the secret `FIREBASE_SERVICE_ACCOUNT`, and puts its address into `src/passkey-config.ts`. The button "Sign in with a passkey" stays hidden until that address is there.

The key file: Firebase console, Project settings, Service accounts, Generate new private key. It can sign in as any account, so keep it nowhere else: delete the downloaded file once it's saved.

Check it: `curl https://arise-passkey.<you>.workers.dev/health` answers `{"ok":true,"name":"arise-passkey","ready":true}` (`ready` is false until the key is set).
