// SSRF guard for backend-initiated fetches of a URL the CLIENT supplied
// (as opposed to a URL our own code generated from a search result --
// those come from a request WE made, not from client input). The current
// browser page is exactly this case: the extension sends the librarian's
// active tab URL, the backend fetches and parses it as ISBN evidence (see
// isbnLookup.js's fetchPageEvidence) -- a malicious or compromised client
// could otherwise point that at an internal service (a metadata endpoint,
// an admin panel on localhost, another container on the same network) and
// use the backend as an open proxy into infrastructure it can't reach
// directly. assertFetchableUrl rejects anything that isn't a plain public
// http(s) URL before a single byte is fetched.
import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE_IPV4_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^169\.254\./, // link-local (also covers cloud metadata endpoints, e.g. 169.254.169.254)
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918 172.16.0.0/12
  /^0\./, // "this network"
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
];

function isPrivateIPv4(ip) {
  return PRIVATE_IPV4_PATTERNS.some((re) => re.test(ip));
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

// assertFetchableUrl(rawUrl) -- throws with a clear reason for anything
// unsafe/unfetchable; returns the parsed URL on success. DNS resolution
// happens here (not left to `fetch` itself) specifically so a hostname
// that only LOOKS public but resolves to a private address is still
// caught before the real request goes out.
export async function assertFetchableUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? ''));
  } catch {
    throw new Error('not a valid URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('only http/https URLs are allowed');
  }

  const hostname = parsed.hostname;
  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    if (isPrivateIPv4(hostname)) throw new Error('private/internal address not allowed');
    return parsed;
  }
  if (ipVersion === 6) {
    if (isPrivateIPv6(hostname)) throw new Error('private/internal address not allowed');
    return parsed;
  }

  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('local/internal hostname not allowed');
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('could not resolve hostname');
  }
  if (addresses.length === 0) throw new Error('hostname resolved to no addresses');
  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIPv4(address)) throw new Error('hostname resolves to a private/internal address');
    if (family === 6 && isPrivateIPv6(address)) throw new Error('hostname resolves to a private/internal address');
  }
  return parsed;
}
