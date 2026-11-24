// System health: one check of every part of Arise that lives somewhere else, in Setup and
// connections (life/connect-hub.js). Each check says in plain words whether that part answers. It
// sends nothing of the person's: the servers are only asked whether they're there, and sync and
// storage are read the way they always are.

export type State = 'ok' | 'bad' | 'off';
export interface Result {
  id: string;
  name: string;
  state: State; // off: not set up (nothing wrong)
  text: string;
}

export interface Probe {
  id: string;
  name: string;
  run: () => Promise<Omit<Result, 'id' | 'name'>>;
}

const TIMEOUT = 8000;

// Whether a server answers at all: any HTTP answer counts (a 404 is still the server), a network
// error or no answer in time doesn't.
export async function answers(url: string, fetcher: typeof fetch = fetch, ms = TIMEOUT): Promise<boolean> {
  const stop = new AbortController();
  const t = setTimeout(() => stop.abort(), ms);
  try {
    await fetcher(url, { method: 'GET', cache: 'no-store', credentials: 'omit', signal: stop.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// A server Arise needs: off when it isn't set up in this build, ok when it answers.
export function serverProbe(id: string, name: string, url: string, what: string, fetcher?: typeof fetch): Probe {
  return {
    id,
    name,
    run: async () => {
      if (!url) return { state: 'off', text: `Not set up yet. ${what}` };
      return (await answers(url, fetcher)) ? { state: 'ok', text: 'Answers.' } : { state: 'bad', text: `Doesn't answer right now. ${what}` };
    },
  };
}

// Every probe, one after another so a slow one doesn't hold the others' answers back on screen.
export async function runAll(probes: Probe[], onResult?: (r: Result, all: Result[]) => void): Promise<Result[]> {
  const out: Result[] = [];
  await Promise.all(
    probes.map(async (p) => {
      let r: Result;
      try {
        r = { id: p.id, name: p.name, ...(await p.run()) };
      } catch (err) {
        r = { id: p.id, name: p.name, state: 'bad', text: (err as Error)?.message || "Couldn't check." };
      }
      out.push(r);
      onResult?.(r, out);
    }),
  );
  const order = new Map(probes.map((p, i) => [p.id, i]));
  return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export function summary(results: Result[]): string {
  const bad = results.filter((r) => r.state === 'bad');
  if (!results.length) return '';
  if (!bad.length) return 'Everything that is set up is working.';
  return `${bad.length === 1 ? '1 part needs' : `${bad.length} parts need`} a look: ${bad.map((r) => r.name).join(', ')}.`;
}

export const ago = (t: number, now = Date.now()) => {
  if (!t) return 'never';
  const min = Math.round((now - t) / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
};
