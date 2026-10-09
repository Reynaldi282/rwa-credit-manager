/**
 * End-to-end demo validation on a local Anvil chain (real transactions, real Morpho Blue bytecode).
 *
 *   npm run anvil            # terminal 1
 *   npm run deploy:local     # terminal 2 (deploys + syncs addresses)
 *   npm run e2e:local
 *
 * Uses Anvil's unlocked default accounts (no private keys anywhere): #2 is the borrower, #3 the keeper.
 */
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, http, parseEventLogs, parseUnits, type Abi, type Address, type Hex } from "viem";
import {
  anvilLocal,
  demoMarketFactoryAbi,
  fmtPct,
  fmtUsd,
  getDeployment,
  marketId,
  mockRwaOracleAbi,
  mockRwaTokenAbi,
  mockUsdcAbi,
  morphoAbi,
  rwaSafetyGuardAbi,
  WAD,
  type MarketParams,
} from "@rwa/shared";
import { Keeper } from "../src/keeper";
import type { KeeperConfig } from "../src/config";

const RPC = process.env.E2E_RPC_URL ?? "http://127.0.0.1:8545";
const BORROWER: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // Anvil #2
const KEEPER: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Anvil #3

const d =
  getDeployment(anvilLocal.id) ??
  (() => {
    throw new Error("No local deployment. Run `npm run deploy:local` first.");
  })();

const pub = createPublicClient({ chain: anvilLocal, transport: http(RPC) });
const wallet = createWalletClient({ chain: anvilLocal, transport: http(RPC), account: BORROWER });

type Step = { step: string; hash: Hex; block: bigint; gas: bigint };
const steps: Step[] = [];

async function send(step: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: BORROWER } as never);
  const hash = await wallet.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `${step} reverted`);
  steps.push({ step, hash, block: r.blockNumber, gas: r.gasUsed });
  return r;
}

const risk = (mp: MarketParams) =>
  pub.readContract({ address: d.rwaSafetyGuard, abi: rwaSafetyGuardAbi, functionName: "getPositionRisk", args: [mp, BORROWER] });

async function main() {
  console.log(`\n== RWA Credit Manager — local end-to-end demo (chain ${await pub.getChainId()}) ==\n`);

  // Step 2: mint test assets via the rate-limited faucets.
  await send("Mint Test RWA (4 mSPY)", d.mockRWAToken, mockRwaTokenAbi, "faucet", [parseUnits("4", 18)]);
  await send("Mint Test USDC (5,200 mUSDC)", d.mockUSDC, mockUsdcAbi, "faucet", [parseUnits("5200", 6)]);

  // Step 3: fresh Morpho Blue market whose TEST oracle is owned by the borrower.
  const created = await send("Create lending market", d.demoMarketFactory, demoMarketFactoryAbi, "createDemoMarket", [500n * 10n ** 8n]);
  const [ev] = parseEventLogs({ abi: demoMarketFactoryAbi, logs: created.logs, eventName: "DemoMarketCreated" });
  assert.ok(ev, "DemoMarketCreated emitted");
  const mp: MarketParams = { ...d.defaultMarket, oracle: ev.args.oracle };
  const id = marketId(mp);
  assert.equal(id, ev.args.id, "market id derivation matches Morpho");

  await send("Approve mUSDC → Morpho", d.mockUSDC, mockUsdcAbi, "approve", [d.morpho, parseUnits("5000", 6)]);
  await send("Supply liquidity (5,000 mUSDC)", d.morpho, morphoAbi, "supply", [mp, parseUnits("5000", 6), 0n, BORROWER, "0x"]);
  await send("Approve mSPY → Morpho", d.mockRWAToken, mockRwaTokenAbi, "approve", [d.morpho, parseUnits("4", 18)]);
  await send("Deposit collateral (4 mSPY = $2,000)", d.morpho, morphoAbi, "supplyCollateral", [mp, parseUnits("4", 18), BORROWER, "0x"]);
  await send("Borrow 1,200 mUSDC", d.morpho, morphoAbi, "borrow", [mp, parseUnits("1200", 6), 0n, BORROWER, BORROWER]);

  // Steps 4-5: reserve + policy.
  await send("Approve mUSDC → Guard", d.mockUSDC, mockUsdcAbi, "approve", [d.rwaSafetyGuard, parseUnits("200", 6)]);
  await send("Deposit protection reserve (200)", d.rwaSafetyGuard, rwaSafetyGuardAbi, "depositReserve", [mp, parseUnits("200", 6)]);
  await send("Save policy 70% → 65%", d.rwaSafetyGuard, rwaSafetyGuardAbi, "setProtectionPolicy", [
    mp, (70n * WAD) / 100n, (65n * WAD) / 100n, parseUnits("500", 6), 0n, true,
  ]);

  let r = await risk(mp);
  console.log(`Initial:  collateral ${fmtUsd(r.collateralValue)}  debt ${fmtUsd(r.debt)}  LTV ${fmtPct(r.ltv)}  reserve ${fmtUsd(r.reserve)}`);
  assert.equal(r.collateralValue, parseUnits("2000", 6));
  assert.ok(r.ltv >= (60n * WAD) / 100n && r.ltv < (6001n * WAD) / 10_000n, "LTV ~60%");

  // The real keeper code, pointed at this market.
  const cfg: KeeperConfig = {
    chainId: anvilLocal.id,
    rpcUrl: RPC,
    guard: d.rwaSafetyGuard,
    morpho: d.morpho,
    startBlock: d.startBlock,
    account: { kind: "unlocked", address: KEEPER },
    pollIntervalMs: 1_000,
    port: 0,
    host: "127.0.0.1",
    pageSize: 50,
    corsOrigins: [],
  };
  const keeper = new Keeper(cfg);

  const healthyTick = await keeper.tick("manual", { user: BORROWER, marketId: id });
  assert.equal(healthyTick.executions.length, 0, "keeper must not act on a healthy position");
  console.log(`Keeper tick (healthy): ${healthyTick.checks[0]?.executable ? "EXECUTABLE?!" : "no action (below trigger)"}`);

  // Steps 6-7: TEST-ONLY oracle shock.
  await send("Simulate price drop (-20%)", mp.oracle, mockRwaOracleAbi, "applyTestPriceShock", [2_000n]);
  r = await risk(mp);
  console.log(`After -20%: collateral ${fmtUsd(r.collateralValue)}  debt ${fmtUsd(r.debt)}  LTV ${fmtPct(r.ltv)}`);
  assert.equal(r.collateralValue, parseUnits("1600", 6));
  assert.ok(r.ltv >= (75n * WAD) / 100n && r.ltv < (7501n * WAD) / 10_000n, "LTV ~75%");

  // Step 8: keeper executes protection on-chain.
  const tick = await keeper.tick("manual", { user: BORROWER, marketId: id });
  const exec = tick.executions[0];
  assert.ok(exec && exec.outcome === "executed", `keeper should execute (got ${exec?.outcome} ${exec?.reason ?? ""})`);
  const receipt = await pub.getTransactionReceipt({ hash: exec.txHash! });
  const [pe] = parseEventLogs({ abi: rwaSafetyGuardAbi, logs: receipt.logs, eventName: "ProtectionExecuted" });
  assert.ok(pe, "ProtectionExecuted emitted");
  steps.push({ step: "Execute protection (keeper)", hash: exec.txHash!, block: receipt.blockNumber, gas: receipt.gasUsed });

  // Steps 9-10: verify against Morpho state.
  r = await risk(mp);
  const pos = await pub.readContract({ address: d.morpho, abi: morphoAbi, functionName: "position", args: [id, BORROWER] });
  console.log(`After protection: debt ${fmtUsd(r.debt)}  LTV ${fmtPct(r.ltv)}  reserve ${fmtUsd(r.reserve)}  borrowShares ${pos.borrowShares}`);
  assert.ok(pe.args.debtBefore >= parseUnits("1200", 6));
  assert.ok(r.debt < pe.args.debtBefore, "debt reduced on Morpho");
  assert.ok(Math.abs(Number(r.debt) - 1_040e6) < 100, `debt ~ $1,040 (got ${r.debt})`);
  assert.ok(r.ltv <= (65n * WAD) / 100n + 10n ** 12n, "LTV <= ~65%");
  assert.ok(r.ltv >= (6499n * WAD) / 10_000n, "LTV ~65%");
  assert.equal(pe.args.targetReached, true);
  assert.equal(pe.args.user, BORROWER);
  assert.equal(pe.args.executor, KEEPER);

  // Repeated keeper call: idempotent.
  const again = await keeper.tick("manual", { user: BORROWER, marketId: id });
  assert.equal(again.executions.length, 0, "second tick must not execute");

  console.log("\nProtectionExecuted event (decoded from the on-chain receipt):");
  console.log({
    txHash: exec.txHash,
    block: receipt.blockNumber,
    user: pe.args.user,
    marketId: pe.args.id,
    executor: pe.args.executor,
    assetsRepaid: fmtUsd(pe.args.assetsRepaid),
    debtBefore: fmtUsd(pe.args.debtBefore),
    debtAfter: fmtUsd(pe.args.debtAfter),
    ltvBefore: fmtPct(pe.args.ltvBefore),
    ltvAfter: fmtPct(pe.args.ltvAfter, 4),
    reserveAfter: fmtUsd(pe.args.reserveAfter),
    targetReached: pe.args.targetReached,
  });

  console.log("\nTransactions (local Anvil — not on a public network):");
  for (const s of steps) console.log(`  ${s.step.padEnd(38)} block ${String(s.block).padStart(4)}  gas ${String(s.gas).padStart(7)}  ${s.hash}`);
  console.log("\nE2E PASSED ✔\n");
}

main().catch((e) => {
  console.error("\nE2E FAILED ✘\n", e);
  process.exit(1);
});
