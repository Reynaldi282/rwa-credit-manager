import { isAddress, isHex, type Address, type Hex } from "viem";
import { anvilLocal, getDeployment, sepolia } from "@rwa/shared";

export type KeeperAccount = { kind: "privateKey"; privateKey: Hex } | { kind: "unlocked"; address: Address };

export type KeeperConfig = {
  chainId: number;
  rpcUrl: string;
  guard: Address;
  morpho: Address;
  startBlock: bigint;
  account: KeeperAccount;
  pollIntervalMs: number;
  port: number;
  host: string;
  pageSize: number;
  corsOrigins: string[];
};

const SUPPORTED = new Set<number>([anvilLocal.id, sepolia.id]);

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export function loadConfig(): KeeperConfig {
  const chainId = Number(env("KEEPER_CHAIN_ID") ?? anvilLocal.id);
  if (!SUPPORTED.has(chainId)) {
    throw new Error(`KEEPER_CHAIN_ID=${chainId} is not supported (Anvil 31337 or Sepolia 11155111 only; never mainnet).`);
  }

  const deployment = getDeployment(chainId);
  const guard = (env("KEEPER_GUARD_ADDRESS") ?? deployment?.rwaSafetyGuard) as Address | undefined;
  const morpho = (env("KEEPER_MORPHO_ADDRESS") ?? deployment?.morpho) as Address | undefined;
  if (!guard || !isAddress(guard)) throw new Error(`No RWASafetyGuard address for chain ${chainId}. Deploy, then run \`npm run sync\`.`);
  if (!morpho || !isAddress(morpho)) throw new Error(`No Morpho address for chain ${chainId}.`);

  const defaultRpc = chainId === anvilLocal.id ? "http://127.0.0.1:8545" : undefined;
  const rpcUrl = env("KEEPER_RPC_URL") ?? defaultRpc;
  if (!rpcUrl) throw new Error("KEEPER_RPC_URL is required for Sepolia.");

  let account: KeeperAccount;
  const pk = env("KEEPER_PRIVATE_KEY");
  const unlocked = env("KEEPER_UNLOCKED_ADDRESS");
  if (pk) {
    if (!isHex(pk) || pk.length !== 66) throw new Error("KEEPER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.");
    account = { kind: "privateKey", privateKey: pk };
  } else if (unlocked) {
    if (chainId !== anvilLocal.id) throw new Error("KEEPER_UNLOCKED_ADDRESS is only allowed on local Anvil.");
    if (!isAddress(unlocked)) throw new Error("KEEPER_UNLOCKED_ADDRESS is not an address.");
    account = { kind: "unlocked", address: unlocked };
  } else if (chainId === anvilLocal.id) {
    // Anvil default account #3 (unlocked by Anvil; no key involved).
    account = { kind: "unlocked", address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" };
  } else {
    throw new Error("Set KEEPER_PRIVATE_KEY (a dedicated, low-value Sepolia keeper wallet).");
  }

  return {
    chainId,
    rpcUrl,
    guard,
    morpho,
    startBlock: deployment?.startBlock ?? 0n,
    account,
    pollIntervalMs: Number(env("KEEPER_POLL_INTERVAL_MS") ?? 15_000),
    port: Number(env("PORT") ?? env("KEEPER_PORT") ?? 8787),
    host: env("KEEPER_HOST") ?? "0.0.0.0",
    pageSize: Number(env("KEEPER_PAGE_SIZE") ?? 100),
    corsOrigins: (env("KEEPER_CORS_ORIGINS") ?? "http://localhost:3000,http://127.0.0.1:3000")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
