import { encodeAbiParameters, keccak256, type Hex } from "viem";
import type { Deployment, MarketParams, RawDeployment } from "./types";
import { rawDeployments } from "./generated/deployments";

/** Morpho Blue market id: keccak256(abi.encode(marketParams)). */
export function marketId(p: MarketParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv],
    ),
  );
}

function parseDeployment(d: RawDeployment): Deployment {
  return {
    chainId: d.chainId,
    startBlock: BigInt(d.startBlock),
    morpho: d.morpho,
    irm: d.irm,
    lltv: BigInt(d.lltv),
    mockUSDC: d.mockUSDC,
    mockRWAToken: d.mockRWAToken,
    rwaSafetyGuard: d.rwaSafetyGuard,
    demoMarketFactory: d.demoMarketFactory,
    defaultMarketId: d.defaultMarketId,
    defaultMarket: { ...d.defaultMarket, lltv: BigInt(d.defaultMarket.lltv) },
  };
}

/** Deployment for a chain, from contracts/deployments/<chainId>.json (synced by scripts/sync-shared.mjs). */
export function getDeployment(chainId: number): Deployment | undefined {
  const raw = rawDeployments[chainId];
  return raw ? parseDeployment(raw) : undefined;
}

export function deployedChainIds(): number[] {
  return Object.keys(rawDeployments).map(Number);
}
