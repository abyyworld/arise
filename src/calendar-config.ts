// Calendars added by their link (src/connect/ics-feeds.ts). The phone apps read them straight
// from the calendar's server. In a browser most calendar servers don't allow that, so the web app
// can, if the person says so, go through the small fetch-only helper in worker/calendar. `server`
// is its address once it's deployed (scripts/setup-workers.sh puts it here), like
// https://arise-calendar.<you>.workers.dev. Until then the web app only reads calendars whose
// server allows web pages, and says the helper isn't ready.

export const CALENDAR = {
  server: '',
};
