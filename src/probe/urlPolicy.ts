// URL egress policy for probing target apps.
//
// Defends against SSRF: a compromised config or supply-chain attack could
// set a target's URL to an internal service (AWS metadata at 169.254.169.254,
// localhost:6379 Redis, RFC1918 LAN ranges, etc.) and use monkey's HTTP
// fetch / browser navigation to probe internal infrastructure.
//
// Policy:
//   - Scheme must be http: or https:
//   - Hostname must NOT resolve to a private/loopback/link-local IPv4 or IPv6
//   - Both raw-IP hostnames and DNS names go through the same check
//
// Limitations:
//   - DNS rebinding: we resolve once at validation time. An attacker who
//     controls a DNS server and rebinds between this resolve and the actual
//     fetch could still reach internal IPs. Out of scope — threat model is
//     "compromised local config," not "attacker-controlled DNS."

import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

export type UrlPolicyResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/** Validate that a URL string is safe to fetch / navigate to.
 *  Returns the parsed URL when ok; a reason string when rejected. */
export async function validateTargetUrl(raw: string): Promise<UrlPolicyResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    return { ok: false, reason: `not a valid URL: ${(err as Error).message}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported scheme "${url.protocol}" — only http: and https: allowed` };
  }

  // Resolve hostname to IPs (or accept raw IP literal as-is). The WHATWG
  // URL spec preserves brackets around IPv6 hostnames (e.g. `[::1]`); strip
  // them so `isIP` recognizes the literal.
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const ipFamily = isIP(hostname);
  const ipsToCheck: string[] = [];
  if (ipFamily === 4 || ipFamily === 6) {
    ipsToCheck.push(hostname);
  } else {
    try {
      const resolver = new Resolver({ timeout: 5_000 });
      const [v4, v6] = await Promise.all([
        resolver.resolve4(hostname).catch(() => [] as string[]),
        resolver.resolve6(hostname).catch(() => [] as string[]),
      ]);
      ipsToCheck.push(...v4, ...v6);
      if (ipsToCheck.length === 0) {
        return { ok: false, reason: `hostname "${hostname}" did not resolve to any IP` };
      }
    } catch (err) {
      return { ok: false, reason: `DNS resolution failed for "${hostname}": ${(err as Error).message}` };
    }
  }

  for (const ip of ipsToCheck) {
    if (isPrivateOrLinkLocalOrLoopback(ip)) {
      return { ok: false, reason: `hostname "${hostname}" resolves to private/link-local/loopback IP "${ip}"` };
    }
  }

  return { ok: true, url };
}

/** True if `ip` is in any of: loopback (127/8, ::1), link-local (169.254/16,
 *  fe80::/10), private (10/8, 172.16/12, 192.168/16, fc00::/7), or
 *  unspecified (0.0.0.0, ::). */
export function isPrivateOrLinkLocalOrLoopback(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false; // Not a valid v4 address; let URL parse handle elsewhere
  }
  const [a, b] = parts;
  // 0.0.0.0/8 — current network / unspecified
  if (a === 0) return true;
  // 10.0.0.0/8 — RFC1918
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (AWS metadata lives at 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC1918
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — Carrier-grade NAT (RFC6598)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 — loopback
  if (lower === '::1') return true;
  // :: — unspecified
  if (lower === '::') return true;
  // fe80::/10 — link-local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // fc00::/7 — unique local addresses
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // IPv4-in-IPv6 forms — both mapped (::ffff:a.b.c.d) and compatible
  // (::a.b.c.d, deprecated). Both forms can arrive in either dotted notation
  // OR hex (Node's URL parser normalizes [::169.254.169.254] to
  // [::a9fe:a9fe], for example). Check both encodings — failing to do so
  // is a known SSRF bypass (the H5 finding; pre-fix the dotted regex
  // alone left the hex form open).

  // Dotted form: ::ffff:a.b.c.d or ::a.b.c.d
  const v4Dotted = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Dotted) return isPrivateIPv4(v4Dotted[1]);

  // Hex form (post-URL-normalization): ::ffff:H1:H2 or ::H1:H2 where H1/H2
  // are 1-4 hex digits each encoding 16 bits of the embedded IPv4.
  const v4Hex = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4Hex) {
    const h1 = parseInt(v4Hex[1], 16);
    const h2 = parseInt(v4Hex[2], 16);
    if (h1 <= 0xffff && h2 <= 0xffff) {
      const a = (h1 >> 8) & 0xff;
      const b = h1 & 0xff;
      const c = (h2 >> 8) & 0xff;
      const d = h2 & 0xff;
      return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
    }
  }

  return false;
}
