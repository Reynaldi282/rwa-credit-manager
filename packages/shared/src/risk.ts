/**
 * Protection math mirrored from RWASafetyGuard.sol / Morpho Blue, in bigint.
 *
 * Used for *hypothetical* scenarios (the risk simulator). Live figures always come from the contract
 * (`getPositionRisk`, `previewProtection`, `previewProtectionAtPrice`), never from this file.
 */

export const WAD = 10n ** 18n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;
const MAX_UINT256 = 2n ** 256n - 1n;

export const mulDivDown = (x: bigint, y: bigint, d: bigint) => (x * y) / d;
export const mulDivUp = (x: bigint, y: bigint, d: bigint) => (x * y + (d - 1n)) / d;
export const wMulDown = (x: bigint, y: bigint) => mulDivDown(x, y, WAD);
export const wDivUp = (x: bigint, y: bigint) => mulDivUp(x, WAD, y);
export const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

export const toAssetsUp = (shares: bigint, totalAssets: bigint, totalShares: bigint) =>
  mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
export const toSharesDown = (assets: bigint, totalAssets: bigint, totalShares: bigint) =>
  mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);

/** LTV = debt / collateralValue (WAD), rounded up; max uint when collateral value is 0. */
export function ltvOf(debt: bigint, collateralValue: bigint): bigint {
  if (debt === 0n) return 0n;
  if (collateralValue === 0n) return MAX_UINT256;
  return wDivUp(debt, collateralValue);
}

export const isInfiniteLtv = (ltv: bigint) => ltv === MAX_UINT256;

export function collateralValueOf(collateral: bigint, oraclePrice: bigint): bigint {
  return mulDivDown(collateral, oraclePrice, ORACLE_PRICE_SCALE);
}

export type SimulationInput = {
  collateral: bigint; // collateral-token units
  debt: bigint; // loan-token units (interest-accrued)
  oraclePrice: bigint; // current Morpho oracle price (1e36-scaled)
  lltv: bigint; // WAD
  reserve: bigint; // loan-token units
  policy: {
    enabled: boolean;
    triggerLtv: bigint;
    targetLtv: bigint;
    maxRepayPerExecution: bigint;
  };
};

export type SimulationResult = {
  dropBps: number;
  hypotheticalPrice: bigint;
  collateralValue: bigint;
  ltv: bigint;
  liquidatable: boolean;
  triggered: boolean;
  requiredRepay: bigint;
  repayAmount: bigint;
  debtAfter: bigint;
  ltvAfter: bigint;
  liquidatableAfter: boolean;
  reserveAfter: bigint;
  targetReachable: boolean;
};

/**
 * Simulates a collateral price decline of `dropBps` (2000 = -20%) followed by one protection execution.
 * Share-rounding is approximated at the asset level (the contract's exact share math differs by <= 2 wei).
 */
export function simulatePriceDrop(input: SimulationInput, dropBps: number): SimulationResult {
  const hypotheticalPrice = (input.oraclePrice * BigInt(10_000 - dropBps)) / 10_000n;
  const collateralValue = collateralValueOf(input.collateral, hypotheticalPrice);
  const ltv = ltvOf(input.debt, collateralValue);
  const maxBorrow = wMulDown(collateralValue, input.lltv);
  const liquidatable = input.debt > maxBorrow;

  const triggered = input.policy.enabled && input.debt > 0n && ltv >= input.policy.triggerLtv;

  let requiredRepay = 0n;
  const targetDebt = wMulDown(collateralValue, input.policy.targetLtv);
  if (input.debt > targetDebt) requiredRepay = min(input.debt, input.debt - targetDebt + 2n);

  const repayAmount = triggered ? min(requiredRepay, input.reserve, input.policy.maxRepayPerExecution) : 0n;
  const debtAfter = input.debt - repayAmount;
  const ltvAfter = ltvOf(debtAfter, collateralValue);

  return {
    dropBps,
    hypotheticalPrice,
    collateralValue,
    ltv,
    liquidatable,
    triggered,
    requiredRepay: triggered ? requiredRepay : 0n,
    repayAmount,
    debtAfter,
    ltvAfter,
    liquidatableAfter: debtAfter > maxBorrow,
    reserveAfter: input.reserve - repayAmount,
    targetReachable: !triggered || repayAmount >= requiredRepay,
  };
}

/** Curve for charts: one simulation per `stepBps` from 0 to `maxDropBps`. */
export function simulationCurve(input: SimulationInput, maxDropBps = 5_000, stepBps = 100): SimulationResult[] {
  const out: SimulationResult[] = [];
  for (let d = 0; d <= maxDropBps; d += stepBps) out.push(simulatePriceDrop(input, d));
  return out;
}

/** Oracle price at which LTV reaches `ltv` (same scale as the oracle). */
export function priceAtLtv(debt: bigint, collateral: bigint, ltv: bigint): bigint {
  if (debt === 0n || collateral === 0n || ltv === 0n) return 0n;
  return mulDivUp(wDivUp(debt, ltv), ORACLE_PRICE_SCALE, collateral);
}

/** Converts a Morpho oracle price to a human price of one whole collateral token in loan tokens. */
export function oraclePriceToNumber(oraclePrice: bigint, collateralDecimals: number, loanDecimals: number): number {
  // price * 10^collDec / 1e36 = loan-token units per whole collateral token
  const unitsPerToken = (oraclePrice * 10n ** BigInt(collateralDecimals)) / ORACLE_PRICE_SCALE;
  const remainder = (oraclePrice * 10n ** BigInt(collateralDecimals)) % ORACLE_PRICE_SCALE;
  return (Number(unitsPerToken) + Number(remainder) / Number(ORACLE_PRICE_SCALE)) / 10 ** loanDecimals;
}
