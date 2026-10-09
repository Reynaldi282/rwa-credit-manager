"use client";

import { FlaskConical, ShieldCheck } from "lucide-react";
import { anvilLocal } from "@rwa/shared";
import { useDashboard } from "@/hooks/use-dashboard";
import { WalletButton } from "./wallet-button";

export function Header() {
  const d = useDashboard();
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/40">
            <ShieldCheck className="size-5 text-chart-1" />
          </div>
          <div className="min-w-0">
            <div className="truncate font-semibold tracking-tight">RWA Credit Manager</div>
            <div className="truncate text-xs text-muted-foreground">Protect Your Onchain Collateral</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="hidden items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs text-ink-secondary ring-1 ring-border sm:inline-flex"
            data-testid="network-badge"
          >
            {d.chainId === anvilLocal.id ? <FlaskConical className="size-3.5 text-warning" /> : <span className="size-2 rounded-full bg-chart-1" />}
            {d.chainName}
          </span>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

export function TestnetBanner() {
  return (
    <div className="border-b border-warning/20 bg-warning/5">
      <div className="mx-auto flex max-w-7xl items-start gap-2 px-4 py-2 text-xs leading-relaxed text-ink-secondary">
        <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p>
          <span className="font-medium text-foreground">Testnet demo.</span> mSPY is an educational mock token — not an ETF share, not an Ondo
          token, no real-world value. Oracle prices in demo markets are set manually (test-only). Lending and repayment run on the real Morpho
          Blue contracts. Not financial advice.
        </p>
      </div>
    </div>
  );
}
