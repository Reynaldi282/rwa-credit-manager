"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import { useBalance, useConnection, useReadContract } from "wagmi";
import {
  anvilLocal,
  chainById,
  demoMarketFactoryAbi,
  getDeployment,
  marketId,
  mockRwaOracleAbi,
  mockUsdcAbi,
  morphoAbi,
  rwaSafetyGuardAbi,
  type Deployment,
  type MarketParams,
} from "@rwa/shared";
import { env } from "@/lib/env";
import type { AppChainId } from "@/lib/wagmi";

const PRICE_UPDATER_ROLE = keccak256(toBytes("PRICE_UPDATER_ROLE"));

export type MarketOption = { params: MarketParams; id: Hex; label: string; owned: boolean };

type DashboardState = {
  chainId: AppChainId;
  chainName: string;
  deployment?: Deployment;
  address?: Address;
  isConnected: boolean;
  isWrongNetwork: boolean;
  connectedChainId?: number;
  markets: MarketOption[];
  market?: MarketOption;
  selectMarket: (id: Hex) => void;
  risk?: RiskData;
  policy?: PolicyData;
  preview?: PreviewData;
  marketState?: { totalSupplyAssets: bigint; totalBorrowAssets: bigint; lastUpdate: bigint };
  balances: { usdc: bigint; spy: bigint; eth: bigint };
  allowances: { usdcToMorpho: bigint; usdcToGuard: bigint; spyToMorpho: bigint };
  faucetRemaining: { usdc: bigint; spy: bigint };
  oracle: { priceE8?: bigint; initialPriceE8?: bigint; canUpdate: boolean; isTestOracle: boolean };
  isLoading: boolean;
  error?: string;
  refresh: () => Promise<void>;
};

type GuardDashboard = NonNullable<ReturnType<typeof useGuardDashboard>["data"]>;
export type RiskData = GuardDashboard[0];
export type PolicyData = GuardDashboard[1];
export type PreviewData = GuardDashboard[2];

function useGuardDashboard(guard: Address | undefined, mp: MarketParams | undefined, user: Address, chainId: AppChainId, interval: number) {
  return useReadContract({
    address: guard,
    abi: rwaSafetyGuardAbi,
    functionName: "getDashboard",
    args: mp ? [mp, user] : undefined,
    chainId,
    query: { enabled: !!guard && !!mp, refetchInterval: interval },
  });
}

const Ctx = createContext<DashboardState | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { address, isConnected, chainId: connectedChainId } = useConnection();

  const supported = connectedChainId !== undefined && !!chainById(connectedChainId) && (env.enableLocalChain || connectedChainId !== anvilLocal.id);
  const chainId = (isConnected && supported ? connectedChainId! : env.defaultChainId) as AppChainId;
  const isWrongNetwork = isConnected && !supported;
  const deployment = getDeployment(chainId);
  const interval = chainId === anvilLocal.id ? 3_000 : 10_000;
  const user = address ?? zeroAddress;

  // Markets: the shared default market + every demo market this wallet created.
  const userMarkets = useReadContract({
    address: deployment?.demoMarketFactory,
    abi: demoMarketFactoryAbi,
    functionName: "getMarkets",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: !!deployment && !!address, refetchInterval: interval * 2 },
  });

  const markets = useMemo<MarketOption[]>(() => {
    if (!deployment) return [];
    const list: MarketOption[] = (userMarkets.data ?? []).map((p, i) => {
      const params: MarketParams = { loanToken: p.loanToken, collateralToken: p.collateralToken, oracle: p.oracle, irm: p.irm, lltv: p.lltv };
      return { params, id: marketId(params), label: `My demo market #${i + 1}`, owned: true };
    });
    list.reverse(); // newest first
    list.push({ params: deployment.defaultMarket, id: deployment.defaultMarketId, label: "Shared default market", owned: false });
    return list;
  }, [deployment, userMarkets.data]);

  // Selection is derived: an explicit choice wins until the wallet creates a newer market, which is then shown.
  const ownedCount = markets.filter((m) => m.owned).length;
  const scope = `${chainId}:${address ?? "anon"}`;
  const [choice, setChoice] = useState<{ id: Hex; ownedCount: number; scope: string } | null>(null);
  const chosenId =
    choice && choice.scope === scope && choice.ownedCount >= ownedCount && markets.some((m) => m.id === choice.id) ? choice.id : undefined;
  const selectMarket = (id: Hex) => setChoice({ id, ownedCount, scope });

  const market = markets.find((m) => m.id === chosenId) ?? markets[0];
  const mp = market?.params;

  const dash = useGuardDashboard(deployment?.rwaSafetyGuard, mp, user, chainId, interval);

  const morphoMarket = useReadContract({
    address: deployment?.morpho,
    abi: morphoAbi,
    functionName: "market",
    args: market ? [market.id] : undefined,
    chainId,
    query: { enabled: !!deployment && !!market, refetchInterval: interval },
  });

  const userRead = { chainId, query: { enabled: !!deployment && !!address, refetchInterval: interval } } as const;
  const usdcBal = useReadContract({ address: deployment?.mockUSDC, abi: mockUsdcAbi, functionName: "balanceOf", args: [user], ...userRead });
  const spyBal = useReadContract({ address: deployment?.mockRWAToken, abi: mockUsdcAbi, functionName: "balanceOf", args: [user], ...userRead });
  const usdcFaucet = useReadContract({ address: deployment?.mockUSDC, abi: mockUsdcAbi, functionName: "faucetRemaining", args: [user], ...userRead });
  const spyFaucet = useReadContract({ address: deployment?.mockRWAToken, abi: mockUsdcAbi, functionName: "faucetRemaining", args: [user], ...userRead });
  const eth = useBalance({ address, chainId, query: { enabled: !!address, refetchInterval: interval * 2 } });

  const aUsdcMorpho = useReadContract({ address: deployment?.mockUSDC, abi: mockUsdcAbi, functionName: "allowance", args: [user, deployment?.morpho ?? zeroAddress], ...userRead });
  const aUsdcGuard = useReadContract({ address: deployment?.mockUSDC, abi: mockUsdcAbi, functionName: "allowance", args: [user, deployment?.rwaSafetyGuard ?? zeroAddress], ...userRead });
  const aSpyMorpho = useReadContract({ address: deployment?.mockRWAToken, abi: mockUsdcAbi, functionName: "allowance", args: [user, deployment?.morpho ?? zeroAddress], ...userRead });

  const oracleOpts = { chainId, query: { enabled: !!mp, refetchInterval: interval, retry: 0 } } as const;
  const priceE8 = useReadContract({ address: mp?.oracle, abi: mockRwaOracleAbi, functionName: "priceE8", ...oracleOpts });
  const initialPriceE8 = useReadContract({ address: mp?.oracle, abi: mockRwaOracleAbi, functionName: "INITIAL_PRICE_E8", ...oracleOpts });
  const isTestOracle = useReadContract({ address: mp?.oracle, abi: mockRwaOracleAbi, functionName: "IS_TEST_ORACLE", ...oracleOpts });
  const canUpdate = useReadContract({
    address: mp?.oracle,
    abi: mockRwaOracleAbi,
    functionName: "hasRole",
    args: [PRICE_UPDATER_ROLE, user],
    chainId,
    query: { enabled: !!mp && !!address, refetchInterval: interval * 2, retry: 0 },
  });

  const value: DashboardState = {
    chainId,
    chainName: chainById(chainId)?.name ?? `Chain ${chainId}`,
    deployment,
    address,
    isConnected,
    isWrongNetwork,
    connectedChainId,
    markets,
    market,
    selectMarket,
    risk: dash.data?.[0],
    policy: dash.data?.[1],
    preview: dash.data?.[2],
    marketState: morphoMarket.data
      ? {
          totalSupplyAssets: morphoMarket.data.totalSupplyAssets,
          totalBorrowAssets: morphoMarket.data.totalBorrowAssets,
          lastUpdate: morphoMarket.data.lastUpdate,
        }
      : undefined,
    balances: { usdc: usdcBal.data ?? 0n, spy: spyBal.data ?? 0n, eth: eth.data?.value ?? 0n },
    allowances: { usdcToMorpho: aUsdcMorpho.data ?? 0n, usdcToGuard: aUsdcGuard.data ?? 0n, spyToMorpho: aSpyMorpho.data ?? 0n },
    faucetRemaining: { usdc: usdcFaucet.data ?? 0n, spy: spyFaucet.data ?? 0n },
    oracle: {
      priceE8: priceE8.data,
      initialPriceE8: initialPriceE8.data,
      canUpdate: canUpdate.data ?? false,
      isTestOracle: isTestOracle.data ?? false,
    },
    isLoading: dash.isLoading,
    error: dash.error ? dash.error.message.split("\n")[0] : undefined,
    refresh: () => qc.invalidateQueries(),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDashboard(): DashboardState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDashboard must be used inside <DashboardProvider>");
  return v;
}
