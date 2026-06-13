/** Compact token count: 50000 -> "50k", 1500000 -> "1.5M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}

function trim(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/** USD with sensible precision: <$1 shows cents+, else two decimals. */
export function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 1) return `$${n.toFixed(n < 0.01 ? 4 : 3)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "in ~3h", "in ~12m", "soon". */
export function fmtExpiry(expiresAt: number, now = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `~${mins}m`;
  return `~${Math.round(mins / 60)}h`;
}
