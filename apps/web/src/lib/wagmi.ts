import { createConfig, http, injected, mock } from "wagmi";
import { anvilLocal, sepolia } from "@rwa/shared";
import { DEV_WALLET_ADDRESS, env } from "./env";

const anvil = { ...anvilLocal, rpcUrls: { default: { http: [env.anvilRpcUrl] } } };

// The first chain is the default for disconnected reads and for the dev wallet.
const chains = env.enableLocalChain && env.defaultChainId === anvil.id ? ([anvil, sepolia] as const) : ([sepolia, anvil] as const);

export const wagmiConfig = createConfig({
  chains,
  ssr: true,
  connectors: [
    // MetaMask and other browser wallets are also auto-discovered via EIP-6963.
    injected(),
    ...(env.enableLocalChain && env.enableDevWallet
      ? [mock({ accounts: [DEV_WALLET_ADDRESS], features: { reconnect: true } })]
      : []),
  ],
  // JSON-RPC batching keeps the dashboard's parallel reads to one HTTP request per tick (Anvil has no Multicall3).
  transports: {
    [sepolia.id]: http(env.sepoliaRpcUrl, { batch: true }),
    [anvil.id]: http(env.anvilRpcUrl, { batch: true }),
  },
});

export type AppChainId = (typeof wagmiConfig)["chains"][number]["id"];

export const visibleChains = env.enableLocalChain ? [sepolia, anvil] : [sepolia];

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
