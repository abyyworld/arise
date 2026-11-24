// Just enough CBOR (RFC 8949) to read what WebAuthn sends: the attestation object and the
// credential's public key (COSE). Whole numbers, byte strings, text, arrays, maps, true, false
// and null. Nothing of indefinite length, no floats and no tags, which WebAuthn never uses.

export class CborError extends Error {}

export type Cbor = number | Uint8Array | string | Cbor[] | Map<Cbor, Cbor> | boolean | null;

const MAX_DEPTH = 16;

// Reads one value from `bytes` at `at`. Returns it and where the next one starts.
export function decodeFirst(bytes: Uint8Array, at = 0): { value: Cbor; end: number } {
  let pos = at;
  const need = (n: number) => {
    if (pos + n > bytes.length) throw new CborError('The data ended too soon.');
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return bytes[pos++];
    }
    if (info === 25) {
      need(2);
      const v = (bytes[pos] << 8) | bytes[pos + 1];
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = ((bytes[pos] << 24) >>> 0) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3];
      pos += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const high = ((bytes[pos] << 24) >>> 0) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3];
      const low = ((bytes[pos + 4] << 24) >>> 0) + (bytes[pos + 5] << 16) + (bytes[pos + 6] << 8) + bytes[pos + 7];
      if (high > 0x1fffff) throw new CborError('A number is too big.');
      pos += 8;
      return high * 2 ** 32 + low;
    }
    throw new CborError('Lengths that are not given up front are not supported.');
  };
  const read = (depth: number): Cbor => {
    if (depth > MAX_DEPTH) throw new CborError('Nested too deep.');
    need(1);
    const first = bytes[pos++];
    const major = first >> 5;
    const info = first & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const n = length(info);
        need(n);
        const out = bytes.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        const n = length(info);
        need(n);
        const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(pos, pos + n));
        pos += n;
        return out;
      }
      case 4: {
        const n = length(info);
        if (n > bytes.length - pos) throw new CborError('The data ended too soon.');
        const out: Cbor[] = [];
        for (let i = 0; i < n; i++) out.push(read(depth + 1));
        return out;
      }
      case 5: {
        const n = length(info);
        if (n * 2 > bytes.length - pos) throw new CborError('The data ended too soon.');
        const out = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) {
          const k = read(depth + 1);
          if (typeof k !== 'number' && typeof k !== 'string') throw new CborError('Only numbers and text are used as map keys.');
          if (out.has(k)) throw new CborError('A map key is there twice.');
          out.set(k, read(depth + 1));
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new CborError('That kind of value is not supported.');
      default:
        throw new CborError('Tags are not supported.');
    }
  };
  const value = read(0);
  return { value, end: pos };
}

// One value that must fill all of `bytes`.
export function decode(bytes: Uint8Array): Cbor {
  const { value, end } = decodeFirst(bytes);
  if (end !== bytes.length) throw new CborError('There is more data after the value.');
  return value;
}
