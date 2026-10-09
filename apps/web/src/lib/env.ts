// NEXT_PUBLIC_* values are inlined at build time, so each must be referenced literally.
const bool = (v: string | undefined, fallback: boolean) => (v === undefined || v === "" ? fallback : v === "true");

export const env = {
  defaultChainId: Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || 11155111),
  enableLocalChain: bool(process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN, false),
  /** Local-only wallet backed by an unlocked Anvil account (no private key in the app). */
  enableDevWallet: bool(process.env.NEXT_PUBLIC_ENABLE_DEV_WALLET, false),
  sepoliaRpcUrl: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  anvilRpcUrl: process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545",
  keeperUrl: process.env.NEXT_PUBLIC_KEEPER_URL || "",
  historyLookbackBlocks: BigInt(process.env.NEXT_PUBLIC_HISTORY_LOOKBACK_BLOCKS || 50_000),
  logChunkBlocks: BigInt(process.env.NEXT_PUBLIC_LOG_CHUNK_BLOCKS || 9_000),
};

/** Anvil default account #5 — a public, well-known test address that Anvil unlocks. */
export const DEV_WALLET_ADDRESS = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" as const;
