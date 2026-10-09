"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { env } from "@/lib/env";

export type KeeperHealth = { ok: boolean; chainId: number; guard: Address; keeper: Address; pollIntervalMs: number; lastTickAt?: string };
export type KeeperExecution = {
  outcome: "executed" | "reverted" | "skipped" | "failed";
  txHash?: Hex;
  assetsRepaid?: string;
  ltvAfter?: string;
  targetReached?: boolean;
  reason?: string;
};
export type KeeperTick = { positions: number; checks: { executable: boolean; status: number }[]; executions: KeeperExecution[]; error?: string };

/** Talks to the off-chain keeper service (services/keeper). Optional: only if NEXT_PUBLIC_KEEPER_URL is set. */
export function useKeeper() {
  const url = env.keeperUrl.replace(/\/$/, "");
  const qc = useQueryClient();

  const health = useQuery({
    queryKey: ["keeper-health", url],
    enabled: !!url,
    refetchInterval: 10_000,
    retry: 0,
    queryFn: async (): Promise<KeeperHealth> => {
      const r = await fetch(`${url}/health`, { cache: "no-store" });
      if (!r.ok) throw new Error(`keeper ${r.status}`);
      return r.json();
    },
  });

  const trigger = useMutation({
    mutationFn: async (body: { user: Address; marketId: Hex }): Promise<KeeperTick> => {
      const r = await fetch(`${url}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(r.status === 429 ? "Keeper is rate-limiting manual runs, retry in a moment" : `Keeper error ${r.status}`);
      return r.json();
    },
    onSettled: () => qc.invalidateQueries(),
  });

  return { url, configured: !!url, online: health.isSuccess && !!health.data?.ok, health: health.data, trigger };
}
