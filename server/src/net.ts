import { config } from "./config.js";

/**
 * Resolve a client IP. X-Forwarded-For is only trusted when TRUST_PROXY=1
 * (i.e. the server sits behind a proxy that sets it, like Caddy). Without that,
 * a directly-exposed server would let clients spoof XFF to bypass per-IP caps.
 */
export function clientIp(xff: string | string[] | undefined, addr: string | undefined): string {
  if (config.trustProxy && xff) {
    const v = Array.isArray(xff) ? xff[0] : xff;
    if (v) return v.split(",")[0]!.trim();
  }
  return addr ?? "unknown";
}

// Per-IP concurrent socket-connection counter (flood protection).
const conns = new Map<string, number>();

export function canConnect(ip: string): boolean {
  return (conns.get(ip) ?? 0) < config.maxSocketsPerIp;
}
export function addConn(ip: string): void {
  conns.set(ip, (conns.get(ip) ?? 0) + 1);
}
export function removeConn(ip: string): void {
  const n = (conns.get(ip) ?? 0) - 1;
  if (n <= 0) conns.delete(ip);
  else conns.set(ip, n);
}
