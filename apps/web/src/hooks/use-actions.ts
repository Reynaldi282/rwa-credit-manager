"use client";

import { erc20Abi, maxUint256, parseEventLogs, type Abi, type Address } from "viem";
import {
  demoMarketFactoryAbi,
  fmtToken,
  fmtUsd,
  mockRwaOracleAbi,
  mockRwaTokenAbi,
  mockUsdcAbi,
  morphoAbi,
  rwaSafetyGuardAbi,
  type MarketParams,
} from "@rwa/shared";
import { useDashboard } from "./use-dashboard";
import { useTx } from "./use-tx";

const ok = (r: unknown) => r !== undefined;

/** All protocol interactions. Every call is a real transaction from the connected wallet. */
export function useActions() {
  const d = useDashboard();
  const { send, pending, busy } = useTx();
  const dep = d.deployment;
  const selected = d.market?.params;
  const me = d.address;

  async function ensureAllowance(token: Address, symbol: string, spender: Address, spenderName: string, amount: bigint, current: bigint) {
    if (current >= amount) return true;
    // Exact-amount approvals only (no infinite allowances).
    return ok(await send(`Approve ${symbol} for ${spenderName}`, { address: token, abi: erc20Abi as Abi, functionName: "approve", args: [spender, amount] }));
  }

  return {
    pending,
    busy,

    mintRwa: async (amount: bigint) => {
      if (!dep) return false;
      return ok(await send("Mint Test RWA (mSPY faucet)", { address: dep.mockRWAToken, abi: mockRwaTokenAbi as Abi, functionName: "faucet", args: [amount] }, { amount: fmtToken(amount, 18, "mSPY") }));
    },

    mintUsdc: async (amount: bigint) => {
      if (!dep) return false;
      return ok(await send("Mint Test USDC (mUSDC faucet)", { address: dep.mockUSDC, abi: mockUsdcAbi as Abi, functionName: "faucet", args: [amount] }, { amount: fmtUsd(amount) }));
    },

    /** Creates a fresh Morpho market with a caller-owned TEST oracle; returns its params (decoded from the event). */
    createMarket: async (priceE8: bigint): Promise<MarketParams | undefined> => {
      if (!dep) return undefined;
      const r = await send("Create lending market on Morpho Blue", { address: dep.demoMarketFactory, abi: demoMarketFactoryAbi as Abi, functionName: "createDemoMarket", args: [priceE8] });
      if (!r) return undefined;
      const [ev] = parseEventLogs({ abi: demoMarketFactoryAbi, logs: r.logs, eventName: "DemoMarketCreated" });
      return ev ? { ...dep.defaultMarket, oracle: ev.args.oracle } : undefined;
    },

    supplyLiquidity: async (amount: bigint, market?: MarketParams) => {
      const mp = market ?? selected;
      if (!dep || !mp || !me) return false;
      if (!(await ensureAllowance(dep.mockUSDC, "mUSDC", dep.morpho, "Morpho", amount, d.allowances.usdcToMorpho))) return false;
      return ok(await send("Supply liquidity to Morpho", { address: dep.morpho, abi: morphoAbi as Abi, functionName: "supply", args: [mp, amount, 0n, me, "0x"] }, { amount: fmtUsd(amount) }));
    },

    depositCollateral: async (amount: bigint, market?: MarketParams) => {
      const mp = market ?? selected;
      if (!dep || !mp || !me) return false;
      if (!(await ensureAllowance(dep.mockRWAToken, "mSPY", dep.morpho, "Morpho", amount, d.allowances.spyToMorpho))) return false;
      return ok(await send("Deposit mSPY collateral", { address: dep.morpho, abi: morphoAbi as Abi, functionName: "supplyCollateral", args: [mp, amount, me, "0x"] }, { amount: fmtToken(amount, 18, "mSPY") }));
    },

    borrow: async (amount: bigint, market?: MarketParams) => {
      const mp = market ?? selected;
      if (!dep || !mp || !me) return false;
      return ok(await send("Borrow mUSDC from Morpho", { address: dep.morpho, abi: morphoAbi as Abi, functionName: "borrow", args: [mp, amount, 0n, me, me] }, { amount: fmtUsd(amount) }));
    },

    depositReserve: async (amount: bigint, market?: MarketParams) => {
      const mp = market ?? selected;
      if (!dep || !mp) return false;
      if (!(await ensureAllowance(dep.mockUSDC, "mUSDC", dep.rwaSafetyGuard, "RWASafetyGuard", amount, d.allowances.usdcToGuard))) return false;
      return ok(await send("Deposit protection reserve", { address: dep.rwaSafetyGuard, abi: rwaSafetyGuardAbi as Abi, functionName: "depositReserve", args: [mp, amount] }, { amount: fmtUsd(amount) }));
    },

    withdrawReserve: async (amount: bigint | "max") => {
      const mp = selected;
      if (!dep || !mp) return false;
      const a = amount === "max" ? maxUint256 : amount;
      return ok(await send("Withdraw protection reserve", { address: dep.rwaSafetyGuard, abi: rwaSafetyGuardAbi as Abi, functionName: "withdrawReserve", args: [mp, a] }, { amount: amount === "max" ? "all" : fmtUsd(amount) }));
    },

    savePolicy: async (p: { triggerLtv: bigint; targetLtv: bigint; maxRepay: bigint; cooldown: bigint; enabled: boolean }, market?: MarketParams) => {
      const mp = market ?? selected;
      if (!dep || !mp) return false;
      return ok(
        await send("Save protection policy on-chain", {
          address: dep.rwaSafetyGuard,
          abi: rwaSafetyGuardAbi as Abi,
          functionName: "setProtectionPolicy",
          args: [mp, p.triggerLtv, p.targetLtv, p.maxRepay, p.cooldown, p.enabled],
        }),
      );
    },

    disableProtection: async (market?: MarketParams) => {
      const mp = market ?? selected;
      if (!dep || !mp) return false;
      return ok(await send("Disable protection", { address: dep.rwaSafetyGuard, abi: rwaSafetyGuardAbi as Abi, functionName: "disableProtection", args: [mp] }));
    },

    priceShock: async (dropBps: number, market?: MarketParams) => {
      const mp = market ?? selected;
      if (!mp) return false;
      return ok(await send(`TEST ORACLE: simulate −${dropBps / 100}% price drop`, { address: mp.oracle, abi: mockRwaOracleAbi as Abi, functionName: "applyTestPriceShock", args: [BigInt(dropBps)] }));
    },

    resetPrice: async (market?: MarketParams) => {
      const mp = market ?? selected;
      if (!mp) return false;
      return ok(await send("TEST ORACLE: reset price", { address: mp.oracle, abi: mockRwaOracleAbi as Abi, functionName: "resetTestPrice", args: [] }));
    },

    executeProtection: async (market?: MarketParams) => {
      const mp = market ?? selected;
      if (!dep || !mp || !me) return false;
      return ok(await send("Execute protection (repay via Morpho)", { address: dep.rwaSafetyGuard, abi: rwaSafetyGuardAbi as Abi, functionName: "executeProtection", args: [mp, me] }));
    },
  };
}
