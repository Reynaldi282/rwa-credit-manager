"use client";

import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DashboardProvider, useDashboard } from "@/hooks/use-dashboard";
import { ContractsCard } from "./contracts-card";
import { DemoPanel } from "./demo-panel";
import { Header, TestnetBanner } from "./header";
import { MarketSelector } from "./market-selector";
import { LtvMeterCard, PositionOverview } from "./position-overview";
import { ProtectionEngine } from "./protection-engine";
import { ProtectionSettings } from "./protection-settings";
import { RiskSimulator } from "./risk-simulator";
import { TxHistory } from "./tx-history";

function Body() {
  const d = useDashboard();
  return (
    <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Collateral protection</h1>
          <p className="text-sm text-muted-foreground">
            Your Morpho Blue loan backed by tokenized RWA collateral, monitored and auto-deleveraged by <code className="text-xs">RWASafetyGuard</code>.
          </p>
        </div>
        <MarketSelector />
      </div>

      {d.isWrongNetwork && (
        <Alert className="border-critical/40">
          <TriangleAlert className="text-critical" />
          <AlertTitle>Unsupported network</AlertTitle>
          <AlertDescription>Switch your wallet to Ethereum Sepolia{d.chainId === 31_337 ? " or the local Anvil chain" : ""}. Mainnet is not supported.</AlertDescription>
        </Alert>
      )}
      {!d.deployment && (
        <Alert className="border-warning/40">
          <TriangleAlert className="text-warning" />
          <AlertTitle>Contracts not deployed on {d.chainName}</AlertTitle>
          <AlertDescription>
            Deploy with <code>forge script script/DeploySepolia.s.sol</code> (or <code>npm run deploy:local</code> for Anvil), then run{" "}
            <code>npm run sync</code> and rebuild. See docs/DEPLOYMENT.md.
          </AlertDescription>
        </Alert>
      )}
      {d.error && d.deployment && (
        <Alert className="border-critical/40">
          <TriangleAlert className="text-critical" />
          <AlertTitle>Could not read the position</AlertTitle>
          <AlertDescription className="break-all">{d.error}</AlertDescription>
        </Alert>
      )}

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <LtvMeterCard />
          <PositionOverview />
        </div>
        <ProtectionEngine />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RiskSimulator />
        </div>
        <ProtectionSettings />
      </section>

      <DemoPanel />
      <TxHistory />
      <ContractsCard />
    </main>
  );
}

export function Dashboard() {
  return (
    <DashboardProvider>
      <Header />
      <TestnetBanner />
      <Body />
      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        RWA Credit Manager · hackathon MVP · Sepolia testnet only · not financial advice · mSPY is not an Ondo token or an ETF share
      </footer>
    </DashboardProvider>
  );
}
