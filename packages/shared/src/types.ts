import type { Address, Hex } from "viem";

/** Morpho Blue `MarketParams`. */
export type MarketParams = {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
};

/** Shape written by contracts/script/DeployBase.s.sol (numbers > 2^53 are strings). */
export type RawDeployment = {
  chainId: number;
  startBlock: number;
  morpho: Address;
  irm: Address;
  lltv: string;
  mockUSDC: Address;
  mockRWAToken: Address;
  rwaSafetyGuard: Address;
  demoMarketFactory: Address;
  defaultMarketId: Hex;
  defaultMarket: {
    loanToken: Address;
    collateralToken: Address;
    oracle: Address;
    irm: Address;
    lltv: string;
  };
};

export type Deployment = {
  chainId: number;
  startBlock: bigint;
  morpho: Address;
  irm: Address;
  lltv: bigint;
  mockUSDC: Address;
  mockRWAToken: Address;
  rwaSafetyGuard: Address;
  demoMarketFactory: Address;
  defaultMarketId: Hex;
  defaultMarket: MarketParams;
};

/** Mirrors `ProtectionPolicy` in IRWASafetyGuard.sol. LTVs are WAD (1e18 = 100%). */
export type ProtectionPolicy = {
  enabled: boolean;
  triggerLtv: bigint;
  targetLtv: bigint;
  cooldown: number;
  lastExecutedAt: bigint;
  maxRepayPerExecution: bigint;
};

/** Mirrors `PreviewStatus` in IRWASafetyGuard.sol. */
export enum PreviewStatus {
  Executable = 0,
  PolicyDisabled = 1,
  NoDebt = 2,
  BelowTrigger = 3,
  CooldownActive = 4,
  NoReserve = 5,
  InvalidPrice = 6,
}

export const previewStatusLabel: Record<PreviewStatus, string> = {
  [PreviewStatus.Executable]: "Protection executable",
  [PreviewStatus.PolicyDisabled]: "Protection disabled",
  [PreviewStatus.NoDebt]: "No outstanding debt",
  [PreviewStatus.BelowTrigger]: "Below trigger LTV",
  [PreviewStatus.CooldownActive]: "Cooldown active",
  [PreviewStatus.NoReserve]: "Reserve empty",
  [PreviewStatus.InvalidPrice]: "Invalid oracle price",
};
