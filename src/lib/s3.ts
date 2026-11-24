// Signing requests for S3-style storage (AWS Signature Version 4), as Cloudflare R2 takes them:
// the Player's own bucket keeps their encrypted files (life/files-sync.ts, lib/own-storage.ts).
// Done here on the device with Web Crypto, so the secret key never goes anywhere but into the
// signature, and no storage library runs inside Arise.

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

async function hmac(key: Uint8Array | ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}

// RFC 3986, as SigV4 wants each path segment and query part.
const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface Signable {
  method: string;
  url: string;
  headers?: Record<string, string>; // more headers to sign (lower-case names), like range
  payloadHash: string; // hex SHA-256 of the body ('' body included), or 'UNSIGNED-PAYLOAD'
  keyId: string;
  secret: string;
  region?: string; // 'auto' for R2
  service?: string;
  date?: Date;
}

// The headers to send: the signed ones plus authorization.
export async function sign(r: Signable): Promise<Record<string, string>> {
  const u = new URL(r.url);
  const region = r.region || 'auto';
  const service = r.service || 's3';
  const amzDate = (r.date || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: u.host, 'x-amz-content-sha256': r.payloadHash, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(r.headers || {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const path = u.pathname
    .split('/')
    .map((p) => uriEncode(decodeURIComponent(p)))
    .join('/');
  const query = [...u.searchParams]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [r.method.toUpperCase(), path || '/', query, canonicalHeaders, signedHeaders, r.payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  let key: ArrayBuffer = await hmac(enc.encode(`AWS4${r.secret}`), day);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, 'aws4_request');
  const signature = hex(await hmac(key, toSign));
  const { host: _host, ...send } = headers;
  return { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${r.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}
