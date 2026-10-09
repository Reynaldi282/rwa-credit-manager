"use client";

import { Coins, Gauge, Landmark, PiggyBank, ShieldCheck, TrendingDown, Wallet } from "lucide-react";
import { fmtPct, fmtToken, fmtUsd, isInfiniteLtv, oraclePriceToNumber, shortAddress, WAD } from "@rwa/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboard } from "@/hooks/use-dashboard";
import { Metric, StatusPill, type Tone } from "./primitives";

const usdPrice = (oraclePrice: bigint) => `$${oraclePriceToNumber(oraclePrice, 18, 6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function riskTone(ltv: bigint, trigger: bigint, lltv: bigint, hasDebt: boolean): { tone: Tone; label: string } {
  if (!hasDebt) return { tone: "neutral", label: "No open loan" };
  if (ltv >= lltv) return { tone: "critical", label: "Liquidatable" };
  if (trigger > 0n && ltv >= trigger) return { tone: "warning", label: "Protection zone" };
  if (ltv >= (lltv * 90n) / 100n) return { tone: "serious", label: "Near liquidation" };
  return { tone: "good", label: "Healthy" };
}

export function PositionOverview() {
  const d = useDashboard();
  const r = d.risk;
  const p = d.policy;

  if (!r) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[92px] rounded-xl" />
        ))}
      </div>
    );
  }

  const hasDebt = r.debt > 0n;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="position-overview">
      <Metric
        label="Connected wallet"
        icon={<Wallet className="size-3.5" />}
        value={<span className="font-mono text-base">{d.address ? shortAddress(d.address) : "—"}</span>}
        sub={d.chainName}
      />
      <Metric
        label="Tokenized RWA collateral"
        icon={<Coins className="size-3.5" />}
        value={fmtToken(r.collateral, 18, "mSPY", 4)}
        sub={r.oraclePrice > 0n ? `@ ${usdPrice(r.oraclePrice)} · test oracle` : "oracle price unavailable"}
        tip="Mock tokenized S&P 500 ETF exposure (educational). Valued by the Morpho market's own oracle."
      />
      <Metric label="Collateral value" value={fmtUsd(r.collateralValue)} sub="collateral × oracle price ÷ 1e36" testId="metric-collateral-value" />
      <Metric
        label="Outstanding loan"
        icon={<Landmark className="size-3.5" />}
        value={fmtUsd(r.debt)}
        sub="interest-accrued, from Morpho borrow shares"
        tip="toAssetsUp(borrowShares) with Morpho's view-side interest accrual — the same rounding Morpho uses for its health check."
        testId="metric-debt"
      />
      <Metric label="Morpho liquidation threshold" icon={<TrendingDown className="size-3.5" />} value={fmtPct(r.lltv, 0)} sub="market LLTV (immutable)" />
      <Metric
        label="Liquidation price"
        value={hasDebt ? usdPrice(r.liquidationPrice) : "—"}
        sub={hasDebt ? (r.priceDropToLiquidation > 0n ? `price can fall ${fmtPct(r.priceDropToLiquidation)}` : "at or below liquidation") : "no debt"}
        testId="metric-liquidation-price"
      />
      <Metric
        label="Protection threshold"
        icon={<ShieldCheck className="size-3.5" />}
        value={p && p.triggerLtv > 0n ? `${fmtPct(p.triggerLtv, 0)} → ${fmtPct(p.targetLtv, 0)}` : "Not set"}
        sub={p && p.triggerLtv > 0n && hasDebt ? `triggers at ${usdPrice(r.triggerPrice)} / mSPY` : "trigger → target LTV"}
      />
      <Metric
        label="Available reserve"
        icon={<PiggyBank className="size-3.5" />}
        value={fmtUsd(r.reserve)}
        sub={
          <span className="inline-flex items-center gap-1.5">
            {p?.enabled ? <StatusPill tone="good">Protection enabled</StatusPill> : <StatusPill tone="neutral">Protection disabled</StatusPill>}
          </span>
        }
        testId="metric-reserve"
      />
    </div>
  );
}

export function LtvMeterCard() {
  const d = useDashboard();
  const r = d.risk;
  const p = d.policy;
  if (!r) return <Skeleton className="h-[220px] rounded-xl" />;

  const hasDebt = r.debt > 0n;
  const trigger = p?.triggerLtv ?? 0n;
  const target = p?.targetLtv ?? 0n;
  const { tone, label } = riskTone(r.ltv, trigger, r.lltv, hasDebt);
  const pct = (w: bigint) => (isInfiniteLtv(w) ? 100 : Math.min(100, Number((w * 10_000n) / WAD) / 100));
  const fill = tone === "critical" ? "bg-critical" : tone === "warning" ? "bg-warning" : tone === "serious" ? "bg-serious" : "bg-chart-1";

  return (
    <Card data-testid="ltv-card">
      <CardHeader className="flex flex-row items-start justify-between">
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" /> Current loan-to-value
        </CardTitle>
        <StatusPill tone={tone}>{label}</StatusPill>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="text-5xl font-semibold tracking-tight" data-testid="current-ltv">
            {hasDebt ? fmtPct(r.ltv) : "0.00%"}
          </div>
          <div className="pb-1.5 text-sm text-ink-secondary">
            {hasDebt ? (
              <>
                {fmtUsd(r.debt)} debt / {fmtUsd(r.collateralValue)} collateral · max borrow {fmtUsd(r.maxBorrow)}
              </>
            ) : (
              "Open a Morpho position to see live risk"
            )}
          </div>
        </div>

        <div>
          <div className="relative h-3 rounded-full bg-chart-1/15" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(r.ltv)} aria-label="Loan-to-value">
            <div className={`absolute inset-y-0 left-0 rounded-full ${fill} transition-[width] duration-700`} style={{ width: `${pct(r.ltv)}%` }} />
            {target > 0n && <Marker at={pct(target)} className="bg-good" />}
            {trigger > 0n && <Marker at={pct(trigger)} className="bg-warning" />}
            <Marker at={pct(r.lltv)} className="bg-critical" />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-secondary">
            {target > 0n && <Key className="bg-good" text={`Target ${fmtPct(target, 0)}`} />}
            {trigger > 0n && <Key className="bg-warning" text={`Trigger ${fmtPct(trigger, 0)}`} />}
            <Key className="bg-critical" text={`Liquidation (LLTV) ${fmtPct(r.lltv, 0)}`} />
            <Key className={fill} text="Current LTV" bar />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Marker({ at, className }: { at: number; className: string }) {
  return <div className={`absolute -top-1 -bottom-1 w-0.5 rounded-full ring-2 ring-card ${className}`} style={{ left: `calc(${at}% - 1px)` }} aria-hidden />;
}

function Key({ className, text, bar }: { className: string; text: string; bar?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`${bar ? "h-2 w-4 rounded-full" : "h-3 w-0.5 rounded-full"} ${className}`} aria-hidden />
      {text}
    </span>
  );
}
