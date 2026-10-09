"use client";

import type { Hex } from "viem";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDashboard } from "@/hooks/use-dashboard";

export function MarketSelector() {
  const d = useDashboard();
  if (!d.deployment || d.markets.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <Select value={d.market?.id} onValueChange={(v) => d.selectMarket(v as Hex)}>
        <SelectTrigger className="w-[300px] max-w-[70vw]" aria-label="Morpho market" data-testid="market-select">
          <SelectValue placeholder="Select market" />
        </SelectTrigger>
        <SelectContent>
          {d.markets.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              <span>{m.label}</span>
              <span className="ml-2 font-mono text-[11px] text-muted-foreground">{m.id.slice(0, 10)}…</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="ghost" size="icon" onClick={() => d.refresh()} aria-label="Refresh on-chain data">
        <RefreshCw />
      </Button>
    </div>
  );
}
