"use client";

import { useState, type ReactNode } from "react";
import { CircleCheck, CircleDashed, FlaskConical, LoaderCircle, Play, RotateCcw } from "lucide-react";
import { anvilLocal, fmtUsd, sepolia, WAD, type MarketParams } from "@rwa/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useActions } from "@/hooks/use-actions";
import { useDashboard } from "@/hooks/use-dashboard";

const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const AMOUNTS = {
  spy: 4n * E18, // $2,000 at $500
  usdcFaucet: 5_200n * E6, // 5,000 liquidity + 200 reserve
  liquidity: 5_000n * E6,
  borrow: 1_200n * E6, // 60% LTV
  reserve: 200n * E6,
  maxRepay: 500n * E6,
  priceE8: 500n * 10n ** 8n,
};

type Step = {
  n: number;
  title: string;
  desc: ReactNode;
  done: boolean;
  disabled?: string; // reason
  label: string;
  run: () => Promise<unknown>;
};

export function DemoPanel() {
  const d = useDashboard();
  const a = useActions();
  const [auto, setAuto] = useState(false);
  const r = d.risk;
  const pol = d.policy;
  const owned = !!d.market?.owned;
  const connected = !!d.address && !!d.deployment && !d.isWrongNetwork;

  const spyDone = d.balances.spy + (owned ? r?.collateral ?? 0n : 0n) >= AMOUNTS.spy;
  const usdcDone = d.balances.usdc >= AMOUNTS.usdcFaucet || (owned && (d.marketState?.totalSupplyAssets ?? 0n) >= AMOUNTS.liquidity);
  const liquidityDone = owned && (d.marketState?.totalSupplyAssets ?? 0n) >= AMOUNTS.borrow;
  const collateralDone = owned && (r?.collateral ?? 0n) >= AMOUNTS.spy;
  const borrowDone = owned && (r?.debt ?? 0n) >= (AMOUNTS.borrow * 99n) / 100n;
  const executed = owned && (pol?.lastExecutedAt ?? 0n) > 0n;
  const protectDone = owned && !!pol?.enabled && ((r?.reserve ?? 0n) >= AMOUNTS.reserve || executed);
  const dropped = owned && d.oracle.priceE8 !== undefined && d.oracle.initialPriceE8 !== undefined && d.oracle.priceE8 < d.oracle.initialPriceE8;
  const liquidity = (d.marketState?.totalSupplyAssets ?? 0n) - (d.marketState?.totalBorrowAssets ?? 0n);

  const protect = async (mp?: MarketParams) => {
    if (!(await a.depositReserve(AMOUNTS.reserve, mp))) return false;
    return a.savePolicy({ triggerLtv: (70n * WAD) / 100n, targetLtv: (65n * WAD) / 100n, maxRepay: AMOUNTS.maxRepay, cooldown: 0n, enabled: true }, mp);
  };

  const steps: Step[] = [
    { n: 1, title: "Mint Test RWA", desc: "4 mSPY from the rate-limited faucet (≈ $2,000 at $500).", done: spyDone, label: "Mint 4 mSPY", run: () => a.mintRwa(AMOUNTS.spy), disabled: d.faucetRemaining.spy < AMOUNTS.spy ? "daily faucet limit reached" : undefined },
    { n: 2, title: "Mint Test USDC", desc: "5,200 mUSDC: 5,000 for liquidity + 200 for the reserve.", done: usdcDone, label: "Mint 5,200 mUSDC", run: () => a.mintUsdc(AMOUNTS.usdcFaucet), disabled: d.faucetRemaining.usdc < AMOUNTS.usdcFaucet ? "daily faucet limit reached" : undefined },
    { n: 3, title: "Create / initialize lending market", desc: <>A fresh mSPY/mUSDC market on <b>Morpho Blue</b> (LLTV 77%, AdaptiveCurveIrm) with a TEST oracle only you can move.</>, done: owned, label: owned ? "Create another" : "Create market", run: () => a.createMarket(AMOUNTS.priceE8) },
    { n: 4, title: "Supply liquidity", desc: "Lend 5,000 mUSDC into your market so it can be borrowed.", done: liquidityDone, label: "Supply 5,000", run: () => a.supplyLiquidity(AMOUNTS.liquidity), disabled: !owned ? "create your market first" : d.balances.usdc < AMOUNTS.liquidity ? "need 5,000 mUSDC" : undefined },
    { n: 5, title: "Deposit collateral", desc: "4 mSPY into Morpho as collateral → $2,000.", done: collateralDone, label: "Deposit 4 mSPY", run: () => a.depositCollateral(AMOUNTS.spy), disabled: !owned ? "create your market first" : d.balances.spy < AMOUNTS.spy ? "need 4 mSPY" : undefined },
    { n: 6, title: "Borrow USDC", desc: "Borrow 1,200 mUSDC from Morpho → LTV 60%.", done: borrowDone, label: "Borrow 1,200", run: () => a.borrow(AMOUNTS.borrow), disabled: !collateralDone ? "deposit collateral first" : liquidity < AMOUNTS.borrow ? "not enough market liquidity" : undefined },
    { n: 7, title: "Deposit protection reserve", desc: "200 mUSDC into RWASafetyGuard + policy: trigger 70%, target 65%, max 500 per execution.", done: protectDone, label: "Deposit & protect", run: () => protect(), disabled: !owned ? "create your market first" : d.balances.usdc < AMOUNTS.reserve ? "need 200 mUSDC" : undefined },
    { n: 8, title: "Simulate price drop", desc: <>TEST ORACLE −20% → collateral $1,600, LTV 75% (crash only affects <i>your</i> market).</>, done: dropped, label: "Drop price 20%", run: () => a.priceShock(2_000), disabled: !owned ? "only on your own market" : !d.oracle.canUpdate ? "you don't control this oracle" : undefined },
    { n: 9, title: "Execute protection", desc: "On-chain repayment of ≈160 mUSDC via Morpho → LTV back to 65%. (Or let the keeper do it.)", done: executed, label: "Execute", run: () => a.executeProtection(), disabled: !d.preview?.executable ? "not executable yet (below trigger)" : undefined },
  ];

  const runGuided = async () => {
    setAuto(true);
    try {
      if (!spyDone && !(await a.mintRwa(AMOUNTS.spy))) return;
      if (!usdcDone && !(await a.mintUsdc(AMOUNTS.usdcFaucet))) return;
      let mp = owned ? d.market!.params : undefined;
      const fresh = !mp;
      if (!mp) mp = await a.createMarket(AMOUNTS.priceE8);
      if (!mp) return;
      if ((fresh || !liquidityDone) && !(await a.supplyLiquidity(AMOUNTS.liquidity, mp))) return;
      if ((fresh || !collateralDone) && !(await a.depositCollateral(AMOUNTS.spy, mp))) return;
      if ((fresh || !borrowDone) && !(await a.borrow(AMOUNTS.borrow, mp))) return;
      if (fresh || !protectDone) await protect(mp);
    } finally {
      setAuto(false);
    }
  };

  const noGas = connected && d.balances.eth === 0n;

  return (
    <Card className="ring-warning/30" data-testid="demo-panel">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="size-4 text-warning" /> Hackathon demo mode
            <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-foreground ring-1 ring-warning/30">TESTNET ONLY</span>
          </CardTitle>
          <CardDescription>
            Every button sends a real transaction from your wallet to the deployed contracts{d.chainId === anvilLocal.id ? " (local Anvil chain)" : ""}. Nothing is simulated in the browser.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={runGuided} disabled={!connected || a.busy || auto} data-testid="run-guided">
            {auto ? <LoaderCircle className="animate-spin" /> : <Play />} Run guided setup (steps 1–7)
          </Button>
          <Button variant="outline" onClick={() => a.resetPrice()} disabled={!connected || !owned || !d.oracle.canUpdate || a.busy} title="Restore the test oracle to its initial price">
            <RotateCcw /> Reset price
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {noGas && (
          <Alert className="border-warning/40">
            <AlertTitle>No ETH for gas</AlertTitle>
            <AlertDescription>
              {d.chainId === sepolia.id ? (
                <>Get Sepolia ETH from a faucet (e.g. Google Cloud Web3 faucet or Alchemy Sepolia faucet), then retry.</>
              ) : (
                <>Fund this account on Anvil: <code>cast send {d.address} --value 10ether --unlocked --from 0xf39F…2266</code></>
              )}
            </AlertDescription>
          </Alert>
        )}
        {!connected && <p className="text-sm text-muted-foreground">Connect a wallet on a supported network to run the demo.</p>}
        <ol className="grid gap-2 md:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n} className="flex flex-col justify-between gap-3 rounded-lg bg-background/40 p-3 ring-1 ring-border" data-testid={`demo-step-${s.n}`} data-done={s.done}>
              <div className="flex items-start gap-2">
                {s.done ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-good" aria-label="done" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="to do" />}
                <div>
                  <div className="text-sm font-medium">
                    {s.n}. {s.title}
                  </div>
                  <div className="text-xs leading-relaxed text-muted-foreground">{s.desc}</div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">{s.disabled && !s.done ? s.disabled : s.done ? "done" : ""}</span>
                <Button size="sm" variant={s.done ? "ghost" : "secondary"} onClick={() => s.run()} disabled={!connected || a.busy || auto || !!s.disabled} data-testid={`demo-step-${s.n}-btn`}>
                  {s.label}
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          Available liquidity in the selected market: {fmtUsd(liquidity > 0n ? liquidity : 0n)}. Reset: “Reset price” restores the test oracle to $500;
          step 3 “Create another” starts a completely fresh market. Exact figures include accrued interest, so expect e.g. $160.00x repaid.
        </p>
      </CardContent>
    </Card>
  );
}
