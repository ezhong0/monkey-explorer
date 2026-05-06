import { describe, it, expect } from 'vitest';
import { isPrivateOrLinkLocalOrLoopback, validateTargetUrl } from './urlPolicy.js';

describe('isPrivateOrLinkLocalOrLoopback — IPv4', () => {
  const trueCases = [
    '127.0.0.1', // loopback
    '127.5.4.3', // 127/8 entire range
    '10.0.0.1', // RFC1918
    '10.255.255.255',
    '172.16.0.1', // RFC1918 lower bound
    '172.31.255.255', // RFC1918 upper bound
    '192.168.1.1', // RFC1918
    '169.254.169.254', // AWS metadata (link-local)
    '169.254.0.1',
    '100.64.0.1', // CGNAT (RFC6598)
    '100.127.255.255',
    '0.0.0.0', // unspecified
    '0.255.0.0',
  ];
  for (const ip of trueCases) {
    it(`${ip} → blocked`, () => {
      expect(isPrivateOrLinkLocalOrLoopback(ip)).toBe(true);
    });
  }

  const falseCases = [
    '8.8.8.8', // Google DNS
    '1.1.1.1', // Cloudflare DNS
    '142.250.80.46', // google.com
    '172.15.0.0', // just below 172.16/12
    '172.32.0.0', // just above 172.31/12
    '169.255.0.0', // just outside 169.254/16
    '100.63.0.0', // just below 100.64/10
    '100.128.0.0', // just above 100.127/10
    '11.0.0.0', // just outside 10/8
    '193.168.0.0', // not RFC1918
  ];
  for (const ip of falseCases) {
    it(`${ip} → allowed`, () => {
      expect(isPrivateOrLinkLocalOrLoopback(ip)).toBe(false);
    });
  }
});

describe('isPrivateOrLinkLocalOrLoopback — IPv6', () => {
  const trueCases = [
    '::1', // loopback
    '::', // unspecified
    'fe80::1', // link-local (fe80::/10)
    'fe80:0:0:0:0:0:0:1',
    'feaf::1', // link-local (top of fe80::/10 range)
    'fc00::1', // ULA (fc00::/7)
    'fc01:abcd::1',
    'fdff::1', // ULA (top of fc00::/7)
    '::ffff:127.0.0.1', // IPv4-mapped IPv6 → 127.0.0.1
    '::ffff:169.254.169.254', // IPv4-mapped → AWS metadata
    '::169.254.169.254', // IPv4-compatible (deprecated, H5 regression test)
    '::127.0.0.1', // IPv4-compatible loopback
  ];
  for (const ip of trueCases) {
    it(`${ip} → blocked`, () => {
      expect(isPrivateOrLinkLocalOrLoopback(ip)).toBe(true);
    });
  }

  const falseCases = [
    '2001:4860:4860::8888', // Google DNS
    '2606:4700:4700::1111', // Cloudflare DNS
    '::ffff:8.8.8.8', // IPv4-mapped public IP
    '::8.8.8.8', // IPv4-compatible public IP
    'fec0::1', // site-local (deprecated, NOT in our block list — expected false)
  ];
  for (const ip of falseCases) {
    it(`${ip} → allowed`, () => {
      expect(isPrivateOrLinkLocalOrLoopback(ip)).toBe(false);
    });
  }
});

describe('validateTargetUrl — scheme + IP-literal hostname', () => {
  it('rejects non-http/https scheme', async () => {
    const result = await validateTargetUrl('file:///etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/scheme/);
  });

  it('rejects ftp scheme', async () => {
    const result = await validateTargetUrl('ftp://example.com');
    expect(result.ok).toBe(false);
  });

  it('rejects malformed URL', async () => {
    const result = await validateTargetUrl('not a url at all');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/valid URL/);
  });

  it('rejects raw IPv4 in private range', async () => {
    const result = await validateTargetUrl('http://10.0.0.1/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/private|link-local|loopback/);
  });

  it('rejects raw IPv6 loopback', async () => {
    const result = await validateTargetUrl('http://[::1]/');
    expect(result.ok).toBe(false);
  });

  it('rejects IPv4-compatible IPv6 (the H5 SSRF regression)', async () => {
    const result = await validateTargetUrl('http://[::169.254.169.254]/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/private|link-local/);
  });

  it('rejects AWS metadata via IPv4-mapped IPv6', async () => {
    const result = await validateTargetUrl('http://[::ffff:169.254.169.254]/');
    expect(result.ok).toBe(false);
  });
});
