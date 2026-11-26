// The browser's extension API: `browser` in Firefox, `chrome` in Chrome, Edge, Brave and Arc.
// Both return promises in Manifest V3. Only the parts the extension uses are typed here.

export interface Tab {
  id?: number;
  windowId: number;
  url?: string;
  title?: string;
  active: boolean;
  incognito: boolean;
  audible?: boolean;
}
export interface Win {
  id?: number;
  left?: number;
  top?: number;
  width?: number;
  focused: boolean;
  incognito: boolean;
  type?: string;
  tabs?: Tab[];
}
export interface Sender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: Tab;
}
// A long-lived connection (to the content script on a Gemini tab: lib/gemini.ts).
export interface Port {
  name: string;
  sender?: Sender;
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: Evt<(msg: unknown) => void>;
  onDisconnect: Evt<() => void>;
}
interface Area {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
interface Evt<F> {
  addListener(f: F): void;
}

export interface Api {
  runtime: {
    id: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    sendMessage(msg: unknown): Promise<unknown>;
    onMessage: Evt<(msg: unknown, sender: Sender, respond: (r: unknown) => void) => boolean | void>;
    onInstalled: Evt<(d: { reason: string }) => void>;
    onStartup: Evt<() => void>;
    onConnect: Evt<(port: Port) => void>;
  };
  storage: { local: Area; session: Area };
  history: {
    search(q: { text: string; startTime?: number; endTime?: number; maxResults?: number }): Promise<{ url?: string; title?: string }[]>;
    getVisits(d: { url: string }): Promise<{ visitTime?: number; transition?: string; isLocal?: boolean }[]>;
    onVisited: Evt<(item: { url?: string }) => void>;
  };
  tabs: {
    query(q: { url?: string[]; active?: boolean; lastFocusedWindow?: boolean; windowType?: string }): Promise<Tab[]>;
    sendMessage(tabId: number, msg: unknown): Promise<unknown>;
    create(p: { url: string; active?: boolean }): Promise<Tab>;
    reload(tabId: number): Promise<void>;
    get(tabId: number): Promise<Tab & { status?: string }>;
    update(tabId: number, p: { url: string }): Promise<Tab>;
    connect(tabId: number, p: { name: string }): Port;
    onActivated: Evt<(info: { tabId: number; windowId: number }) => void>;
    onUpdated: Evt<(tabId: number, change: { url?: string; status?: string; audible?: boolean }, tab: Tab) => void>;
  };
  windows: {
    WINDOW_ID_NONE: number;
    getLastFocused(q?: { populate?: boolean }): Promise<Win>;
    getAll(q?: { windowTypes?: string[] }): Promise<Win[]>;
    create(p: { url: string; type?: string; width?: number; height?: number; left?: number; top?: number; focused?: boolean }): Promise<Win>;
    get(id: number): Promise<Win>;
    remove(id: number): Promise<void>;
    update(id: number, p: { focused?: boolean }): Promise<Win>;
    onFocusChanged: Evt<(windowId: number) => void>;
    onRemoved: Evt<(windowId: number) => void>;
  };
  idle: {
    queryState(seconds: number): Promise<'active' | 'idle' | 'locked'>;
    setDetectionInterval(seconds: number): void;
    onStateChanged: Evt<(state: 'active' | 'idle' | 'locked') => void>;
  };
  alarms: {
    create(name: string, p: { periodInMinutes?: number; delayInMinutes?: number; when?: number }): Promise<void> | void;
    get(name: string): Promise<unknown>;
    getAll(): Promise<{ name: string; scheduledTime?: number }[]>;
    clear(name: string): Promise<boolean>;
    onAlarm: Evt<(a: { name: string }) => void>;
  };
  // Reminders (lib/remind.ts): desktop notifications.
  notifications: {
    create(id: string, p: { type: 'basic'; iconUrl: string; title: string; message: string; priority?: number }): Promise<string>;
    clear(id: string): Promise<boolean>;
    onClicked: Evt<(id: string) => void>;
  };
  // "Save this page to Arise" on the menu a right click opens.
  contextMenus: {
    create(p: { id: string; title: string; contexts: string[] }, done?: () => void): void;
    removeAll(): Promise<void>;
    onClicked: Evt<(info: { menuItemId: string | number; pageUrl?: string; linkUrl?: string; selectionText?: string }, tab?: Tab) => void>;
  };
  // Gemini in your browser (lib/gemini.ts): the one optional site, asked for in allow.html.
  permissions: {
    contains(p: { origins: string[] }): Promise<boolean>;
    request(p: { origins: string[] }): Promise<boolean>;
    remove(p: { origins: string[] }): Promise<boolean>;
  };
  scripting: {
    executeScript(p: { target: { tabId: number }; files: string[] }): Promise<unknown[]>;
  };
  action: {
    setBadgeText(p: { text: string }): Promise<void>;
    setBadgeBackgroundColor(p: { color: string }): Promise<void>;
  };
}

// (Checked for `runtime`: on a page, an element with id="browser" would be window.browser too.)
const g = globalThis as unknown as { browser?: Api; chrome?: Api };
export const api: Api = (g.browser?.runtime ? g.browser : g.chrome)!;

// Arise's own addresses, set when the extension is built (scripts/build-extension.mjs).
declare const __EXT_ARISE__: string[];
export const ARISE: string[] = __EXT_ARISE__;
