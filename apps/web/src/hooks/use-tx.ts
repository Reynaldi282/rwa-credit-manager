"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { useConfig, useConnection } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { toast } from "sonner";
import { explorerTxUrl, shortHash } from "@rwa/shared";
import type { AppChainId } from "@/lib/wagmi";

export type LocalTx = {
  hash: Hex;
  label: string;
  amount?: string;
  chainId: number;
  from: Address;
  status: "pending" | "confirmed" | "failed";
  timestamp: number;
  error?: string;
};

/* ───────── tiny persisted store for transactions sent from this browser ───────── */
const KEY = "rwa:local-txs:v1";
let txs: LocalTx[] = [];
const listeners = new Set<() => void>();
function load() {
  try {
    txs = JSON.parse(localStorage.getItem(KEY) ?? "[]") as LocalTx[];
  } catch {
    txs = [];
  }
}
if (typeof window !== "undefined") load();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(txs.slice(0, 200)));
  } catch {}
  listeners.forEach((l) => l());
}
function upsert(tx: Partial<LocalTx> & { hash: Hex }) {
  const i = txs.findIndex((t) => t.hash === tx.hash);
  txs = i >= 0 ? txs.map((t, j) => (j === i ? { ...t, ...tx } : t)) : [tx as LocalTx, ...txs];
  save();
}
const EMPTY: LocalTx[] = [];
export function useLocalTxs(): LocalTx[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => txs,
    () => EMPTY,
  );
}

/** Human-readable error: decoded custom error name, user rejection, or viem short message. */
export function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return "Rejected in wallet";
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) return `${name}${reverted.data?.args?.length ? `(${reverted.data.args.map(String).join(", ")})` : ""}`;
      return reverted.reason ?? reverted.shortMessage;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export type ContractCall = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
};

/**
 * Sends real transactions from the connected wallet: simulate -> sign -> wait for the receipt.
 * Simulation surfaces reverts (with decoded custom errors) before the wallet prompt.
 */
export function useTx() {
  const config = useConfig();
  const qc = useQueryClient();
  const { address, chainId: connectedChainId } = useConnection();
  const chainId = connectedChainId as AppChainId | undefined;
  const [pending, setPending] = useState<string | null>(null);

  const send = useCallback(
    async (label: string, call: ContractCall, opts: { amount?: string; silent?: boolean } = {}): Promise<TransactionReceipt | undefined> => {
      if (!address || !chainId) {
        toast.error("Connect a wallet first");
        return undefined;
      }
      setPending(label);
      const id = toast.loading(label, { description: "Confirm in your wallet…" });
      let hash: Hex | undefined;
      try {
        const { request } = await simulateContract(config, { ...call, account: address, chainId } as never);
        hash = await writeContract(config, request as never);
        upsert({ hash, label, amount: opts.amount, chainId, from: address, status: "pending", timestamp: Date.now() });
        toast.loading(label, { id, description: `Submitted ${shortHash(hash)} — waiting for confirmation…` });
        const receipt = await waitForTransactionReceipt(config, { hash, chainId });
        if (receipt.status !== "success") throw new Error(`Transaction reverted (${shortHash(hash)})`);
        upsert({ hash, status: "confirmed" });
        const url = explorerTxUrl(chainId, hash);
        toast.success(label, {
          id,
          description: `Confirmed in block ${receipt.blockNumber} · ${shortHash(hash)}`,
          action: url ? { label: "Etherscan", onClick: () => window.open(url, "_blank", "noopener") } : undefined,
        });
        await qc.invalidateQueries();
        return receipt;
      } catch (e) {
        const msg = errorMessage(e);
        if (hash) upsert({ hash, status: "failed", error: msg });
        toast.error(`${label} failed`, { id, description: msg });
        return undefined;
      } finally {
        setPending(null);
      }
    },
    [address, chainId, config, qc],
  );

  return { send, pending, busy: pending !== null };
}
