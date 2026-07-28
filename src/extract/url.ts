// URL validation shared by the extractor entry point and the network fetcher
// (which re-validates every redirect hop). Kept in its own module to avoid a
// circular import between extract/index.ts and platforms.ts.

export function validateUrl(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // Only default web ports — no fetching internal services on odd ports.
  if (url.port !== '' && url.port !== '80' && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  // Workers can't reach private networks anyway, but reject the obvious ones
  // so we fail fast with a clear error. (new URL() normalizes decimal/hex/octal
  // IPv4 to dotted-quad, so the dotted-quad check also covers those forms.)
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(':') || // raw IPv6
    host.includes('[') ||
    !host.includes('.') // bare host with no TLD (intranet name)
  ) {
    return null;
  }
  return url;
}
