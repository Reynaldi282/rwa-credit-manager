"use client";

import { useEffect, useMemo, useState } from "react";
import { ChartLine, Table2 } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { zeroAddress } from "viem";
import { useReadContract } from "wagmi";
import {
  WAD,
  fmtPct,
  fmtUsd,
  isInfiniteLtv,
  oraclePriceToNumber,
  rwaSafetyGuardAbi,
  simulatePriceDrop,
  simulationCurve,
  wadToNumber,
  type SimulationInput,
} from "@rwa/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDashboard } from "@/hooks/use-dashboard";
import { StatusPill } from "./primitives";

// Hackathon reference position, used when the wallet has no open loan.
const SAMPLE: SimulationInput = {
  collateral: 4n * 10n ** 18n,
  debt: 1_200n * 10n ** 6n,
  oraclePrice: 5n * 10n ** 26n,
  lltv: (77n * WAD) / 100n,
  reserve: 200n * 10n ** 6n,
  policy: { enabled: true, triggerLtv: (70n * WAD) / 100n, targetLtv: (65n * WAD) / 100n, maxRepayPerExecution: 500n * 10n ** 6n },
};

const Y_CAP = 140; // % — beyond this the line is clipped (collateral nearly worthless)
const ltvToPct = (w: bigint) => (isInfiniteLtv(w) ? Y_CAP : Math.min(Y_CAP, wadToNumber(w) * 100));
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function useDebounced<T>(v: T, ms: number) {
  const [x, setX] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setX(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return x;
}

type Point = { drop: number; without: number; with: number; repay: number };

function ChartTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload as Point;
  return (
    <div className="rounded-lg bg-popover px-3 py-2 text-xs shadow-xl ring-1 ring-border">
      <div className="mb-1 font-medium text-foreground">Price −{p.drop}%</div>
      <div className="flex items-center gap-2 text-ink-secondary">
        <span className="h-0.5 w-3 rounded bg-chart-2" /> Without protection <span className="ml-auto tabular text-foreground">{p.without >= Y_CAP ? `>${Y_CAP}%` : `${p.without.toFixed(2)}%`}</span>
      </div>
      <div className="flex items-center gap-2 text-ink-secondary">
        <span className="h-0.5 w-3 rounded bg-chart-1" /> With protection <span className="ml-auto tabular text-foreground">{p.with >= Y_CAP ? `>${Y_CAP}%` : `${p.with.toFixed(2)}%`}</span>
      </div>
      {p.repay > 0 && <div className="mt-1 text-muted-foreground">repays {usd(p.repay)}</div>}
    </div>
  );
}

export function RiskSimulator() {
  const d = useDashboard();
  const [drop, setDrop] = useState(20);
  const [table, setTable] = useState(false);
  const r = d.risk;
  const pol = d.policy;
  const live = !!r && r.debt > 0n && r.oraclePrice > 0n;

  const input: SimulationInput = useMemo(
    () =>
      live && r
        ? {
            collateral: r.collateral,
            debt: r.debt,
            oraclePrice: r.oraclePrice,
            lltv: r.lltv,
            reserve: r.reserve,
            policy: {
              enabled: !!pol?.enabled,
              triggerLtv: pol?.triggerLtv ?? 0n,
              targetLtv: pol?.targetLtv ?? 0n,
              maxRepayPerExecution: pol?.maxRepayPerExecution ?? 0n,
            },
          }
        : SAMPLE,
    [live, r, pol],
  );

  const curve = useMemo(() => simulationCurve(input, 5_000, 100), [input]);
  const data: Point[] = curve.map((c) => ({ drop: c.dropBps / 100, without: ltvToPct(c.ltv), with: ltvToPct(c.ltvAfter), repay: Number(c.repayAmount) / 1e6 }));
  const s = simulatePriceDrop(input, drop * 100);
  const triggerPct = wadToNumber(input.policy.triggerLtv) * 100;
  const targetPct = wadToNumber(input.policy.targetLtv) * 100;
  const lltvPct = wadToNumber(input.lltv) * 100;
  const sel = data[drop]!;

  // Cross-check the selected scenario against the contract's own math (read-only eth_call, no transaction).
  const dDrop = useDebounced(drop, 350);
  const onchain = useReadContract({
    address: d.deployment?.rwaSafetyGuard,
    abi: rwaSafetyGuardAbi,
    functionName: "previewProtectionAtPrice",
    args: d.market ? [d.market.params, d.address ?? zeroAddress, (input.oraclePrice * BigInt(10_000 - dDrop * 100)) / 10_000n] : undefined,
    chainId: d.chainId,
    // Re-key on the live position so an execution made elsewhere (e.g. by the keeper) never leaves a stale answer.
    scopeKey: `${input.debt}:${input.reserve}:${input.collateral}`,
    query: { enabled: live && !!d.market && !!d.deployment, refetchInterval: d.chainId === 31_337 ? 4_000 : 15_000, placeholderData: undefined },
  });

  return (
    <Card data-testid="risk-simulator">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ChartLine className="size-4 text-muted-foreground" /> Risk simulator
          </CardTitle>
          <CardDescription>
            Hypothetical collateral decline of 0–50%, followed by one protection execution.{" "}
            {live ? "Based on your live position." : "Sample position: 4 mSPY @ $500, $1,200 debt, 200 reserve, 70% → 65%."}
          </CardDescription>
        </div>
        <StatusPill tone="info">
          Simulated — not on-chain balances
        </StatusPill>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Collateral price change</span>
            <span className="font-semibold tabular" data-testid="sim-drop">
              −{drop}% · {usd(oraclePriceToNumber(s.hypotheticalPrice, 18, 6))} / mSPY
            </span>
          </div>
          <Slider min={0} max={50} step={1} value={[drop]} onValueChange={(v) => setDrop(v[0] ?? 0)} aria-label="Simulated price decline" data-testid="sim-slider" />
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <SimStat label="Hypothetical collateral value" value={fmtUsd(s.collateralValue)} testId="sim-collateral" />
          <SimStat label="Simulated LTV" value={fmtPct(s.ltv)} sub={s.liquidatable ? "liquidatable on Morpho" : s.triggered ? "trigger reached" : "below trigger"} testId="sim-ltv" />
          <SimStat label="Expected repayment" value={fmtUsd(s.repayAmount)} sub={s.triggered && !s.targetReachable ? "capped by reserve / max" : undefined} testId="sim-repay" />
          <SimStat label="Post-repayment LTV" value={fmtPct(s.ltvAfter)} sub={s.liquidatableAfter ? "still liquidatable" : s.triggered ? (s.targetReachable ? "target restored" : "target not reached") : "no action"} testId="sim-ltv-after" />
          <SimStat label="Remaining reserve" value={fmtUsd(s.reserveAfter)} testId="sim-reserve" />
        </div>

        {/* Legend: always present for 2 series; thresholds keyed with label + color. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-secondary">
            <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-chart-2" />Without protection</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-chart-1" />With protection</span>
            {input.policy.enabled && <span className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t border-dashed border-warning" />Trigger {triggerPct.toFixed(0)}%</span>}
            {input.policy.enabled && <span className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t border-dashed border-good" />Target {targetPct.toFixed(0)}%</span>}
            <span className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t border-dashed border-critical" />LLTV {lltvPct.toFixed(0)}%</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setTable((t) => !t)}>
            {table ? <ChartLine /> : <Table2 />} {table ? "Chart view" : "Table view"}
          </Button>
        </div>

        {!table ? (
          <div className="h-[300px] w-full" aria-label="LTV versus collateral price decline, with and without protection">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="drop" type="number" domain={[0, 50]} ticks={[0, 10, 20, 30, 40, 50]} tickFormatter={(v) => `−${v}%`} stroke="var(--grid)" tick={{ fill: "#9d9b94", fontSize: 11 }} tickLine={false} />
                <YAxis domain={[0, Y_CAP]} ticks={[0, 20, 40, 60, 80, 100, 120, 140]} tickFormatter={(v) => `${v}%`} stroke="var(--grid)" tick={{ fill: "#9d9b94", fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
                <Tooltip content={(props) => <ChartTooltip active={props.active} payload={props.payload as ReadonlyArray<{ payload?: unknown }>} />} cursor={{ stroke: "#9d9b94", strokeWidth: 1 }} isAnimationActive={false} />
                <ReferenceLine y={lltvPct} stroke="var(--status-critical)" strokeDasharray="4 4" ifOverflow="extendDomain" />
                {input.policy.enabled && <ReferenceLine y={triggerPct} stroke="var(--status-warning)" strokeDasharray="4 4" />}
                {input.policy.enabled && <ReferenceLine y={targetPct} stroke="var(--status-good)" strokeDasharray="4 4" />}
                <ReferenceLine x={drop} stroke="#9d9b94" strokeOpacity={0.5} />
                <Line type="linear" dataKey="without" stroke="var(--chart-2)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }} isAnimationActive={false} />
                <Line type="linear" dataKey="with" stroke="var(--chart-1)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }} isAnimationActive={false} />
                <ReferenceDot x={sel.drop} y={sel.without} r={4} fill="var(--chart-2)" stroke="var(--card)" strokeWidth={2} />
                <ReferenceDot x={sel.drop} y={sel.with} r={4} fill="var(--chart-1)" stroke="var(--card)" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="max-h-[300px] overflow-auto rounded-lg ring-1 ring-border">
            <Table className="tabular">
              <TableHeader>
                <TableRow>
                  <TableHead>Price change</TableHead>
                  <TableHead>Collateral value</TableHead>
                  <TableHead>LTV (no protection)</TableHead>
                  <TableHead>Repayment</TableHead>
                  <TableHead>LTV after</TableHead>
                  <TableHead>Reserve left</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {curve.filter((c) => c.dropBps % 500 === 0).map((c) => (
                  <TableRow key={c.dropBps}>
                    <TableCell>−{c.dropBps / 100}%</TableCell>
                    <TableCell>{fmtUsd(c.collateralValue)}</TableCell>
                    <TableCell>{fmtPct(c.ltv)}</TableCell>
                    <TableCell>{fmtUsd(c.repayAmount)}</TableCell>
                    <TableCell>{fmtPct(c.ltvAfter)}</TableCell>
                    <TableCell>{fmtUsd(c.reserveAfter)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="rounded-lg bg-background/40 px-3 py-2 text-xs text-muted-foreground ring-1 ring-border" data-testid="sim-onchain">
          {live ? (
            onchain.data ? (
              <>
                Contract check at −{dDrop}% (<code>previewProtectionAtPrice</code>, read-only): repay <span className="text-foreground tabular">{fmtUsd(onchain.data.repayAmount)}</span>, LTV
                after <span className="text-foreground tabular">{fmtPct(onchain.data.expectedLtvAfter)}</span>
                {onchain.data.executable ? "" : " (would not execute: below trigger / disabled / no reserve)"}.
              </>
            ) : (
              "Verifying against the contract…"
            )
          ) : (
            "Open a position to cross-check simulations against the contract's own math."
          )}
          {" "}Simulations assume an instant price move and ignore interest accrued in the meantime.
        </div>
      </CardContent>
    </Card>
  );
}

function SimStat({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div className="rounded-lg bg-background/40 p-3 ring-1 ring-border ring-dashed" data-testid={testId}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold">{value}</div>
      {sub && <div className="text-[11px] text-ink-secondary">{sub}</div>}
    </div>
  );
}
