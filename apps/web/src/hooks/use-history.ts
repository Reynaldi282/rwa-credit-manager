"use client";

import { useQuery } from "@tanstack/react-query";
import { parseEventLogs, type Abi, type Address, type Hex, type Log } from "viem";
import { usePublicClient } from "wagmi";
import {
  demoMarketFactoryAbi,
  fmtPct,
  fmtToken,
  fmtUsd,
  mockRwaOracleAbi,
  mockUsdcAbi,
  morphoAbi,
  rwaSafetyGuardAbi,
} from "@rwa/shared";
import { env } from "@/lib/env";
import { useDashboard } from "./use-dashboard";

export type HistoryRow = {
  key: string;
  type: string;
  detail: string;
  hash: Hex;
  blockNumber: bigint;
  logIndex: number;
  timestamp?: number;
  highlight?: boolean;
};

const eventsAbi = [
  ...rwaSafetyGuardAbi,
  ...morphoAbi,
  ...mockRwaOracleAbi,
  ...mockUsdcAbi,
  ...demoMarketFactoryAbi,
].filter((x) => x.type === "event") as Abi;

// Incremental log cache per (chain, address set): only new blocks are fetched on refresh.
const logCache = new Map<string, { logs: Log[]; toBlock: bigint }>();
const blockTimeCache = new Map<string, number>();

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const price8 = (v: bigint) => `$${(Number(v) / 1e8).toFixed(2)}`;

export function useOnchainHistory() {
  const d = useDashboard();
  const client = usePublicClient({ chainId: d.chainId });
  const dep = d.deployment;
  const me = d.address;
  const market = d.market;

  return useQuery({
    queryKey: ["onchain-history", d.chainId, me, market?.id],
    enabled: !!client && !!dep && !!me && !!market,
    refetchInterval: d.chainId === 31_337 ? 4_000 : 20_000,
    queryFn: async (): Promise<HistoryRow[]> => {
      if (!client || !dep || !me || !market) return [];
      const addresses = [dep.rwaSafetyGuard, dep.morpho, dep.mockUSDC, dep.mockRWAToken, dep.demoMarketFactory, market.params.oracle] as Address[];
      const cacheKey = `${d.chainId}:${addresses.join(",").toLowerCase()}`;
      const latest = await client.getBlockNumber();
      const cached = logCache.get(cacheKey);
      const floor = latest > env.historyLookbackBlocks ? latest - env.historyLookbackBlocks : 0n;
      let from = cached ? cached.toBlock + 1n : dep.startBlock > floor ? dep.startBlock : floor;
      const logs = cached ? [...cached.logs] : [];
      while (from <= latest) {
        const to = from + env.logChunkBlocks - 1n < latest ? from + env.logChunkBlocks - 1n : latest;
        logs.push(...(await client.getLogs({ address: addresses, fromBlock: from, toBlock: to })));
        from = to + 1n;
      }
      logCache.set(cacheKey, { logs, toBlock: latest });

      const decoded = parseEventLogs({ abi: eventsAbi, logs, strict: false });
      const rows: HistoryRow[] = [];
      for (const ev of decoded) {
        const a = (ev.args ?? {}) as Record<string, unknown>;
        const base = { key: `${ev.transactionHash}:${ev.logIndex}`, hash: ev.transactionHash!, blockNumber: ev.blockNumber!, logIndex: ev.logIndex! };
        const sameMarket = eq(a.id as string, market.id);
        const from = ev.address;
        switch (ev.eventName) {
          case "ReserveDeposited":
            if (eq(a.user as string, me) && sameMarket) rows.push({ ...base, type: "Reserve deposit", detail: fmtUsd(a.assets as bigint) });
            break;
          case "ReserveWithdrawn":
            if (eq(a.user as string, me) && sameMarket) rows.push({ ...base, type: "Reserve withdrawal", detail: fmtUsd(a.assets as bigint) });
            break;
          case "ProtectionConfigured":
            if (eq(a.user as string, me) && sameMarket)
              rows.push({
                ...base,
                type: a.enabled ? "Policy saved" : "Protection disabled",
                detail: `trigger ${fmtPct(a.triggerLtv as bigint, 1)} → target ${fmtPct(a.targetLtv as bigint, 1)} · max ${fmtUsd(a.maxRepayPerExecution as bigint)}`,
              });
            break;
          case "ProtectionExecuted":
            if (eq(a.user as string, me) && sameMarket)
              rows.push({
                ...base,
                type: "Protection executed",
                detail: `repaid ${fmtUsd(a.assetsRepaid as bigint)} · debt ${fmtUsd(a.debtBefore as bigint)} → ${fmtUsd(a.debtAfter as bigint)} · LTV ${fmtPct(a.ltvBefore as bigint)} → ${fmtPct(a.ltvAfter as bigint)}${a.targetReached ? "" : " · target not reached"}`,
                highlight: true,
              });
            break;
          case "Supply":
            if (eq(from, dep.morpho) && sameMarket && eq(a.onBehalf as string, me)) rows.push({ ...base, type: "Supply liquidity", detail: fmtUsd(a.assets as bigint) });
            break;
          case "SupplyCollateral":
            if (eq(from, dep.morpho) && sameMarket && eq(a.onBehalf as string, me)) rows.push({ ...base, type: "Deposit collateral", detail: fmtToken(a.assets as bigint, 18, "mSPY") });
            break;
          case "Borrow":
            if (eq(from, dep.morpho) && sameMarket && eq(a.onBehalf as string, me)) rows.push({ ...base, type: "Borrow", detail: fmtUsd(a.assets as bigint) });
            break;
          case "Repay":
            if (eq(from, dep.morpho) && sameMarket && eq(a.onBehalf as string, me))
              rows.push({ ...base, type: eq(a.caller as string, dep.rwaSafetyGuard) ? "Morpho repay (by guard)" : "Morpho repay", detail: fmtUsd(a.assets as bigint) });
            break;
          case "WithdrawCollateral":
            if (eq(from, dep.morpho) && sameMarket && eq(a.onBehalf as string, me)) rows.push({ ...base, type: "Withdraw collateral", detail: fmtToken(a.assets as bigint, 18, "mSPY") });
            break;
          case "TestPriceUpdated":
            if (eq(from, market.params.oracle))
              rows.push({ ...base, type: "Test oracle price", detail: a.oldPriceE8 === 0n ? `initial ${price8(a.newPriceE8 as bigint)}` : `${price8(a.oldPriceE8 as bigint)} → ${price8(a.newPriceE8 as bigint)}` });
            break;
          case "FaucetMinted":
            if (eq(a.to as string, me))
              rows.push({ ...base, type: eq(from, dep.mockUSDC) ? "Mint test mUSDC" : "Mint test mSPY", detail: eq(from, dep.mockUSDC) ? fmtUsd(a.amount as bigint) : fmtToken(a.amount as bigint, 18, "mSPY") });
            break;
          case "DemoMarketCreated":
            if (eq(a.creator as string, me)) rows.push({ ...base, type: "Market created", detail: `${String(a.id).slice(0, 10)}… · oracle ${String(a.oracle).slice(0, 8)}…` });
            break;
        }
      }

      // Block timestamps (cached).
      const blocks = [...new Set(rows.map((r) => r.blockNumber))];
      await Promise.all(
        blocks.map(async (bn) => {
          const k = `${d.chainId}:${bn}`;
          if (!blockTimeCache.has(k)) blockTimeCache.set(k, Number((await client.getBlock({ blockNumber: bn })).timestamp) * 1000);
        }),
      );
      for (const r of rows) r.timestamp = blockTimeCache.get(`${d.chainId}:${r.blockNumber}`);
      rows.sort((x, y) => (x.blockNumber === y.blockNumber ? y.logIndex - x.logIndex : Number(y.blockNumber - x.blockNumber)));
      return rows;
    },
  });
}
