"use client";

import { Boxes } from "lucide-react";
import { fmtPct } from "@rwa/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboard } from "@/hooks/use-dashboard";
import { AddressLink } from "./primitives";

export function ContractsCard() {
  const d = useDashboard();
  const dep = d.deployment;
  if (!dep) return null;
  const rows: [string, string, string][] = [
    ["Morpho Blue", dep.morpho, "real (official deployment on Sepolia; official bytecode locally)"],
    ["Interest rate model", dep.irm, "real AdaptiveCurveIrm"],
    ["RWASafetyGuard", dep.rwaSafetyGuard, "custom protection contract"],
    ["mUSDC (MockUSDC)", dep.mockUSDC, "mock 6-dec stablecoin, faucet"],
    ["mSPY (MockRWAToken)", dep.mockRWAToken, "mock tokenized ETF exposure"],
    ["DemoMarketFactory", dep.demoMarketFactory, "creates per-user test markets"],
  ];
  if (d.market) rows.push(["Selected market oracle", d.market.params.oracle, "MockRWAOracle — TEST-ONLY prices"]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Boxes className="size-4 text-muted-foreground" /> Contracts & what is real
        </CardTitle>
        <CardDescription>
          {d.chainName} · market LLTV {d.market ? fmtPct(d.market.params.lltv, 0) : "—"} · market id{" "}
          <span className="font-mono text-xs">{d.market?.id.slice(0, 18)}…</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <ul className="space-y-2 text-sm">
          {rows.map(([name, addr, note]) => (
            <li key={name} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span>
                {name} <span className="text-xs text-muted-foreground">· {note}</span>
              </span>
              <AddressLink chainId={d.chainId} address={addr} />
            </li>
          ))}
        </ul>
        <div className="space-y-2 text-xs leading-relaxed text-ink-secondary">
          <p>
            <b className="text-foreground">Real on-chain:</b> Morpho Blue lending (supply, collateral, borrow, interest), risk computed from Morpho shares
            and the market oracle, the protection reserve, the trigger check and the partial repayment through <code>Morpho.repay()</code>, events.
          </p>
          <p>
            <b className="text-foreground">Mocked (testnet):</b> the RWA token (mSPY), the stablecoin (mUSDC) and the oracle price, which you move
            manually to simulate a crash. They have no real-world value.
          </p>
          <p>
            <b className="text-foreground">Off-chain:</b> the keeper that watches positions and sends <code>executeProtection</code>. If it is offline,
            nothing happens automatically (you can still execute manually).
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
