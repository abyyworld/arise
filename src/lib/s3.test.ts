// Signing for S3-style storage, checked against the worked example in Amazon's own SigV4 docs
// ("Signature Calculations for the Authorization Header", GET Object).

import { describe, expect, it } from 'vitest';
import { sha256Hex, sign } from './s3';

describe('signing a request (SigV4)', () => {
  it("matches Amazon's own example", async () => {
    const h = await sign({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadHash: await sha256Hex(''),
      keyId: 'AKIAIOSFODNN7EXAMPLE',
      secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      date: new Date(Date.UTC(2013, 4, 24)),
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(h['x-amz-date']).toBe('20130524T000000Z');
    expect(h.host).toBeUndefined(); // the browser sets it
  });

  it('hashes an empty body the way S3 expects', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
