// Signing in with a passkey goes through the small passkey helper in worker/passkey. `server` is
// its address once it's deployed (scripts/setup-workers.sh puts it here), like
// https://arise-passkey.<you>.workers.dev. Until it's set, nothing about passkeys shows.

export const PASSKEY = {
  server: '',
};
