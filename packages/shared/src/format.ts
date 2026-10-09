import { formatUnits } from "viem";
import { WAD, isInfiniteLtv } from "./risk";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/** Loan-token units (mUSDC, 6 decimals) to "$1,234.56". mUSDC is treated as $1 for display. */
export function fmtUsd(units: bigint, decimals = 6): string {
  return usd.format(Number(formatUnits(units, decimals)));
}

export function fmtToken(units: bigint, decimals: number, symbol: string, maxFractionDigits = 4): string {
  const n = Number(formatUnits(units, decimals));
  return `${n.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits })} ${symbol}`;
}

/** WAD to "75.00%". */
export function fmtPct(wad: bigint, fractionDigits = 2): string {
  if (isInfiniteLtv(wad)) return "∞";
  return `${(Number((wad * 1_000_000n) / WAD) / 10_000).toFixed(fractionDigits)}%`;
}

export const wadToNumber = (wad: bigint) => (isInfiniteLtv(wad) ? Number.POSITIVE_INFINITY : Number(wad) / 1e18);

/** "65" (percent number) to WAD. */
export const pctToWad = (pct: number) => (BigInt(Math.round(pct * 100)) * WAD) / 10_000n;

export function shortAddress(a?: string, chars = 4): string {
  if (!a) return "";
  return `${a.slice(0, 2 + chars)}…${a.slice(-chars)}`;
}

export function shortHash(h?: string): string {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "";
}
