import { defineChain, type Chain } from "viem";
import { sepolia } from "viem/chains";

/** Local Anvil node (chain id 31337). */
export const anvilLocal = defineChain({
  id: 31_337,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export { sepolia };

export const SUPPORTED_CHAIN_IDS = [sepolia.id, anvilLocal.id] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

export function chainById(chainId: number): Chain | undefined {
  if (chainId === sepolia.id) return sepolia;
  if (chainId === anvilLocal.id) return anvilLocal;
  return undefined;
}

/** Block explorer helpers (Anvil has none). */
export function explorerTxUrl(chainId: number, hash: string): string | undefined {
  if (chainId === sepolia.id) return `https://sepolia.etherscan.io/tx/${hash}`;
  return undefined;
}

export function explorerAddressUrl(chainId: number, address: string): string | undefined {
  if (chainId === sepolia.id) return `https://sepolia.etherscan.io/address/${address}`;
  return undefined;
}
