// @vitest-environment jsdom
// The Location setting on screen (location-ui.ts): its own panel in the Android app, the choices,
// a typed number of minutes, the precision switch and places never to note.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Opts = Record<string, unknown>;

function fakeAndroid() {
  const config: Opts[] = [];
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    PluginHeaders: [{ name: 'AriseLife' }],
    nativePromise: async (_plugin: string, method: string, o: Opts = {}) => {
      if (method === 'status') return { sdk: 34 };
      if (method === 'checkPermissions') return { location: 'granted', backgroundLocation: 'granted' };
      if (method === 'requestPermissions') return { location: 'granted', backgroundLocation: 'granted' };
      if (method === 'setLocation') return config.push(o) && {};
      if (method === 'readQueue') return { items: [], last: 0 };
      if (method === 'locationNow') return { lat: 41.3111, lon: 69.2797 };
      throw new Error(`${method} isn't simulated`);
    },
  };
  return config;
}

async function load() {
  vi.resetModules();
  (await import('./store-port')).setLifeStore({ addEvents: async (e) => e.length });
  return import('./location-ui');
}

const panel = () => document.getElementById('locationPanel')!;
const tap = (UI: Awaited<ReturnType<typeof load>>, sel: string) => {
  const el = panel().querySelector<HTMLElement>(sel)!;
  return UI.handleAction(el.dataset.act!, el, UI.refresh);
};

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div><div id="toast"></div>';
});
afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('Location on screen', () => {
  it("isn't there on the web", async () => {
    const UI = await load();
    expect(UI.locationPanel()).toBe('');
  });

  it('starts off, suggests 30 minutes, and turns on with a tap', async () => {
    const config = fakeAndroid();
    const UI = await load();
    document.getElementById('app')!.innerHTML = UI.locationPanel();
    const choices = [...panel().querySelectorAll<HTMLElement>('[data-act="loc-mode"]')].map((b) => b.textContent);
    expect(choices).toEqual(['Off', 'Places only', 'Every 5 min', 'Every 15 min', 'Every 30 min (suggested)', 'Every hour']);
    expect(panel().querySelector('[data-mode="off"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(await tap(UI, '[data-every="15"]')).toBe(true);
    expect(config.pop()).toMatchObject({ mode: 'interval', every: 15 });
    expect(panel().querySelector('[data-every="15"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(panel().textContent).toContain('One point every 15 minutes');
  });

  it('takes a typed number, and says when it is not one', async () => {
    const config = fakeAndroid();
    const UI = await load();
    document.getElementById('app')!.innerHTML = UI.locationPanel();
    (panel().querySelector('#locEvery') as HTMLInputElement).value = '1000';
    await tap(UI, '[data-act="loc-every"]');
    expect(document.getElementById('toast')!.textContent).toMatch(/from 1 to 720/);
    expect(config).toEqual([]);
    (panel().querySelector('#locEvery') as HTMLInputElement).value = '7';
    await tap(UI, '[data-act="loc-every"]');
    expect(config.pop()).toMatchObject({ mode: 'interval', every: 7 });
    expect(panel().textContent).toContain('small notification');
  });

  it('rounds to about 1 km, and adds where the phone is as a place never to note', async () => {
    const config = fakeAndroid();
    const UI = await load();
    document.getElementById('app')!.innerHTML = UI.locationPanel();
    await tap(UI, '[data-act="loc-exact"]');
    expect(config.pop()).toMatchObject({ exact: false });
    (panel().querySelector('#locNeverName') as HTMLInputElement).value = 'Home';
    await tap(UI, '[data-act="loc-never-add"]');
    expect(config.pop()).toMatchObject({ never: [{ lat: 41.3111, lon: 69.2797, radius: 250 }] });
    expect(panel().textContent).toContain('Home');
    await tap(UI, '[data-act="loc-never-del"]');
    expect(panel().textContent).toContain('None yet.');
  });

  it('leaves the Days screen its own buttons', async () => {
    const UI = await load();
    expect(await UI.handleAction('loc-range', document.body, () => {})).toBe(false);
    expect(await UI.handleAction('lock-toggle', document.body, () => {})).toBe(false);
  });
});
