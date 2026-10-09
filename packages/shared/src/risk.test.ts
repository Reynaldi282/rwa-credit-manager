import { test } from "node:test";
import assert from "node:assert/strict";
import { simulatePriceDrop, simulationCurve, priceAtLtv, oraclePriceToNumber, WAD, type SimulationInput } from "./risk";
import { marketId } from "./market";
import { fmtPct, fmtUsd, pctToWad } from "./format";

// Hackathon scenario: 4 mSPY @ $500 (oracle 5e26), 1,200 mUSDC debt, LLTV 77%, policy 70% -> 65%, reserve 200.
const scenario: SimulationInput = {
  collateral: 4n * 10n ** 18n,
  debt: 1_200n * 10n ** 6n,
  oraclePrice: 5n * 10n ** 26n,
  lltv: (77n * WAD) / 100n,
  reserve: 200n * 10n ** 6n,
  policy: {
    enabled: true,
    triggerLtv: (70n * WAD) / 100n,
    targetLtv: (65n * WAD) / 100n,
    maxRepayPerExecution: 500n * 10n ** 6n,
  },
};

test("no drop: 60% LTV, not triggered", () => {
  const r = simulatePriceDrop(scenario, 0);
  assert.equal(r.collateralValue, 2_000n * 10n ** 6n);
  assert.equal(r.ltv, (60n * WAD) / 100n);
  assert.equal(r.triggered, false);
  assert.equal(r.repayAmount, 0n);
});

test("-20%: 75% LTV, repays 160 (+2 wei margin), back to 65%", () => {
  const r = simulatePriceDrop(scenario, 2_000);
  assert.equal(r.collateralValue, 1_600n * 10n ** 6n);
  assert.equal(r.ltv, (75n * WAD) / 100n);
  assert.equal(r.triggered, true);
  assert.equal(r.liquidatable, false);
  assert.equal(r.repayAmount, 160_000_002n); // matches the on-chain execution exactly
  assert.equal(r.debtAfter, 1_039_999_998n);
  assert.ok(r.ltvAfter <= scenario.policy.targetLtv);
  assert.equal(r.reserveAfter, 39_999_998n);
  assert.equal(r.targetReachable, true);
});

test("-25%: liquidatable, reserve insufficient for target but restores health", () => {
  const r = simulatePriceDrop(scenario, 2_500);
  assert.equal(r.liquidatable, true);
  assert.equal(r.repayAmount, 200n * 10n ** 6n);
  assert.equal(r.targetReachable, false);
  assert.equal(r.liquidatableAfter, false);
});

test("curve has 51 points from 0 to 50%", () => {
  const c = simulationCurve(scenario);
  assert.equal(c.length, 51);
  assert.equal(c[50]!.dropBps, 5_000);
});

test("liquidation price ~ $389.61", () => {
  const p = priceAtLtv(scenario.debt, scenario.collateral, scenario.lltv);
  assert.ok(Math.abs(oraclePriceToNumber(p, 18, 6) - 389.6103896) < 1e-6);
  assert.equal(oraclePriceToNumber(scenario.oraclePrice, 18, 6), 500);
});

test("market id matches Morpho's keccak256(abi.encode(params))", () => {
  // Cross-checked against MarketParamsLib.id() for the local default market (see contracts/deployments/31337.json).
  const id = marketId({
    loanToken: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
    collateralToken: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
    oracle: "0x8aCd85898458400f7Db866d53FCFF6f0D49741FF",
    irm: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    lltv: 770000000000000000n,
  });
  assert.equal(id, "0x617e4a80a75ee7dbdbd55d81c529ff1bd8109ff2c43d0713c85bdb363c28b70f");
});

test("formatting", () => {
  assert.equal(fmtPct((75n * WAD) / 100n), "75.00%");
  assert.equal(fmtUsd(1_039_999_998n), "$1,040.00");
  assert.equal(pctToWad(65), (65n * WAD) / 100n);
});
