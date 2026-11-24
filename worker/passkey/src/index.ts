// Arise's passkey helper (a Cloudflare Worker): signing in with a passkey (Face ID, Touch ID,
// Windows Hello, a phone) instead of typing the password. Firebase has no passkeys of its own, so
// this checks the passkey and then hands the app a Firebase sign-in token for that account. It
// only ever learns which account a passkey belongs to: the data stays end-to-end encrypted, and
// the secret that unlocks it with a passkey never leaves the person's device. See README.md.
//
// (The main module only exports the handler and the Durable Object class: the Workers runtime
// won't start one that exports anything else.)

import { handle, type Env } from './api';

export { Passkeys } from './store';

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};
