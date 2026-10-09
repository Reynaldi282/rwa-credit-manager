# Security notes (hackathon MVP — not audited)

## Properties enforced by `RWASafetyGuard`

| Property | Mechanism | Tested by |
|---|---|---|
| No admin access to reserves | No owner, no upgradeability, no rescue/sweep function | code review; invariant suite |
| A reserve can only go to its depositor or to Morpho for that depositor's debt | `withdrawReserve` pays `msg.sender` only; `executeProtection` has no recipient parameter and calls `Morpho.repay(onBehalf = user)` | `test_ReservesAreIndependentPerUser`, `test_DemoScenario_EndToEnd` (keeper balance unchanged), invariant `ExecutionsOnlyUseOwnReserveAndReduceDebt` |
| Reserves isolated per (user, market) | `_reserves[user][marketId]`; the market id commits to the loan token | `test_ReservesAreIndependentPerMarket`, invariants |
| Accounting matches balances | effects-before-interactions, balance-delta crediting on deposit | invariants: balance == totalReserves == Σ reserves, conservation |
| Execution only when the policy says so | enabled + cooldown + `LTV ≥ trigger` from fresh, interest-accrued Morpho state | `test_RevertWhen_PositionHealthy`, `test_Cooldown`, `test_DisableAndReenableProtection` |
| Trigger strictly below the market's real LLTV, target below trigger | validated on `setProtectionPolicy` using the market params' LLTV | `test_RevertWhen_TriggerNotBelowLltv`, `test_RevertWhen_TargetNotBelowTrigger` |
| Bounded execution | one position per call; amount ≤ min(required, reserve, maxRepayPerExecution); no loops over users | `test_MaxRepayPerExecutionCap` |
| Debt actually decreases | re-reads Morpho, reverts `DebtNotReduced` otherwise; asserts repaid == planned | all execution tests, fuzz |
| No standing allowance | exact `forceApprove` before `repay`, reset to 0 if anything is left | `NoStandingAllowanceToMorpho` invariant |
| Reentrancy | `nonReentrant` on every state-changing entry point | three malicious-token tests (execute / withdraw / deposit re-entry) |
| Invalid oracle data | execution reverts on price 0 (and bubbles oracle reverts); views degrade to `InvalidPrice` | `test_RevertWhen_OraclePriceZero`, `test_RevertWhen_OracleReverts` |
| Honest reporting | `targetReached` requires the cap/reserve to allow it **and** the re-read LTV ≤ target | `test_InsufficientReserve_PartialProtection`, `test_RescuesLiquidatablePosition_PartialReserve` |
| Repeated keeper calls are harmless | position is at target after execution ⇒ next call reverts `PositionHealthy` | `test_RepeatedKeeperCalls_AreIdempotent` |

## Design decisions and residual risks

- **Permissionless `executeProtection`.** Anyone can call it once conditions hold. The effect is value-neutral for the
  user (stablecoin reserve becomes an equal debt reduction) and is exactly what the user configured. With a
  manipulable oracle, an attacker could trigger protection early — this costs the user only the opportunity cost of
  the reserve, not principal. A production version needs a manipulation-resistant oracle anyway.
- **Malicious markets.** Anyone can create a Morpho market with arbitrary tokens/oracles. Such a market can only
  affect reserves deposited *into that market id* by the user who chose it.
- **Registry growth.** `ProtectedPosition` entries are append-only; keepers paginate (`getProtectedPositions`) and
  should filter (e.g. by known markets). Spam costs the spammer gas and cannot block execution of other positions.
- **Stuck tokens.** Tokens transferred directly to the guard (not via `depositReserve`) cannot be recovered — the
  deliberate price of having no admin.
- **Keeper liveness.** Off-chain and single-instance; a fast price gap through the LLTV between polls can still be
  liquidated by Morpho liquidators. The UI and docs state this.
- **Fee-on-transfer / rebasing loan tokens** are not supported by Morpho Blue; the guard credits balance deltas
  defensively but does not otherwise support them.
- **Mocks are testnet-only:** open (rate-limited) faucets, manual oracle with `PRICE_UPDATER_ROLE`. Never deploy them
  to mainnet; the deploy scripts refuse non-test chains.

## Front-end / keeper

- The dashboard never handles private keys. Transactions are signed by the user's wallet; the optional "Anvil dev
  wallet" uses Anvil's unlocked test account and is only enabled with `NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=true` and
  `NEXT_PUBLIC_ENABLE_DEV_WALLET=true`.
- Approvals are exact-amount, never unlimited. Every write is simulated before the wallet prompt.
- The keeper key should be a dedicated low-value wallet (it only pays gas). Its HTTP API is CORS-restricted and
  rate-limited; `POST /run` can only make it check/execute registered positions, which are condition-gated on-chain.
- Dependencies: direct dependencies are pinned to exact versions and the initial install was resolved with
  `npm install --before=2026-09-25` (releases at least two weeks old). Deliberate exceptions are newer: Next.js /
  eslint-config-next 16.4.0 (fixes advisories in 16.3.x) with their transitive dependencies, and the patch updates
  applied by `npm audit fix`. Remaining `npm audit` findings are dev-only ESLint dependencies. The lockfile pins all of it.
