/**
 * Node-level network probes — run outside the browser.
 * Checks TLS version, ALPN protocol, IPv6 availability, and HTTP/3 via alt-svc.
 */
import * as tls from "tls";
import * as dns from "dns";
import type { NetworkProbe } from "../core";

/** Parse a host from a URL string. Returns empty string on failure. */
function parseHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Probe TLS + ALPN by opening a raw TLS socket.
 * Returns { tlsVersion, alpn } or nulls on failure.
 */
async function probeTls(
  host: string,
): Promise<{ tlsVersion: string | null; alpn: string | null }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ tlsVersion: null, alpn: null });
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }, 8000);

    let resolved = false;
    const finish = (result: { tlsVersion: string | null; alpn: string | null }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    let socket: tls.TLSSocket;
    try {
      socket = tls.connect(
        { host, port: 443, servername: host, ALPNProtocols: ["h2", "http/1.1"] },
        () => {
          const tlsVersion = socket.getProtocol() ?? null;
          // alpnProtocol can be false when not negotiated
          const raw: string | false | null | undefined = socket.alpnProtocol;
          const alpn = raw !== false && raw != null && raw !== "" ? String(raw) : null;
          try {
            socket.destroy();
          } catch {
            // ignore
          }
          finish({ tlsVersion, alpn });
        },
      );
      socket.on("error", () => finish({ tlsVersion: null, alpn: null }));
    } catch {
      clearTimeout(timer);
      resolve({ tlsVersion: null, alpn: null });
    }
  });
}

/**
 * Probe IPv6 availability via DNS AAAA lookup.
 */
async function probeIpv6(host: string): Promise<boolean | null> {
  try {
    const addrs = await dns.promises.resolve6(host);
    return addrs.length > 0;
  } catch {
    return false;
  }
}

/**
 * Detect HTTP/3 from an alt-svc header value.
 * Returns true if the header contains `h3`, false otherwise.
 */
function detectHttp3(altSvcHeader: string | null | undefined): boolean | null {
  if (!altSvcHeader) return null;
  return /\bh3\b/.test(altSvcHeader) ? true : false;
}

/**
 * Run all network probes for a given URL.
 * Never throws — returns nulls on failure.
 */
export async function probeNetwork(
  url: string,
  altSvcHeader?: string | null,
): Promise<NetworkProbe> {
  const host = parseHost(url);
  if (!host) {
    return { tlsVersion: null, alpn: null, ipv6: null, http3: null };
  }

  const [tls, ipv6] = await Promise.all([
    probeTls(host).catch(() => ({ tlsVersion: null, alpn: null })),
    probeIpv6(host).catch(() => null),
  ]);

  const http3 = detectHttp3(altSvcHeader);

  return {
    tlsVersion: tls.tlsVersion,
    alpn: tls.alpn,
    ipv6,
    http3,
  };
}
