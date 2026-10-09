# RWA Credit Manager — Automated Collateral Protection

**Protect Your Onchain Collateral.** A hackathon MVP that watches a Morpho Blue loan backed by a tokenized
real-world asset and, when the collateral price falls and the loan-to-value (LTV) crosses the user's trigger,
**repays part of the debt on-chain through Morpho Blue** using a reserve the user pre-funded — before the
position reaches Morpho's liquidation threshold.

```
$2,000 tokenized-ETF collateral, 1,200 mUSDC borrowed on Morpho Blue        → LTV 60%
200 mUSDC protection reserve, policy: trigger 70% → target 65%
collateral price −20%  → collateral $1,600                                   → LTV 75%  (LLTV is 77%)
keeper / anyone calls RWASafetyGuard.executeProtection()
  → Morpho.repay(160 mUSDC on behalf of the user)                            → debt $1,040, LTV 65%
```

The repayment is a real smart-contract transaction (`RWASafetyGuard → Morpho.repay`), not a front-end simulation.

> **Testnet only.** mSPY is an educational mock token — not an ETF share, not an Ondo token, no real-world value.
> Demo oracle prices are set manually. Nothing here is financial advice. Not audited.

---

## What is real, mocked, and not implemented

| Component | Status | Notes |
|---|---|---|
| Morpho Blue lending (supply, collateral, borrow, interest, repay) | **Real** | Official Sepolia deployment `0xd011EE229E7459ba1ddd22631eF7bF528d424A14`; locally the official v1.0.0 bytecode compiled from the pinned upstream source |
| Interest rate model | **Real** | AdaptiveCurveIrm `0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c` (verified enabled on Sepolia Morpho); same v1.0.0 source locally |
| LLTV 77% | **Real** | Verified `isLltvEnabled(0.77e18) == true` on Sepolia before choosing it |
| `RWASafetyGuard` (risk engine, reserves, policies, triggered repayment, events) | **Real, custom** | `contracts/src/RWASafetyGuard.sol` |
| Risk metrics (debt from borrow shares, LTV, liquidation price, distance to liquidation) | **Real, on-chain** | Computed by the contract from Morpho state + the market oracle |
| Keeper automation | **Real, off-chain** | `services/keeper` polls the guard and sends `executeProtection`; also triggerable from the dashboard |
| Dashboard + MetaMask | **Real** | Next.js 16 / wagmi 3 / viem; every button sends a real transaction |
| Tokenized RWA collateral (`mSPY`) | **Mock** | `MockRWAToken`, rate-limited testnet faucet |
| Stablecoin (`mUSDC`, 6 decimals) | **Mock** | `MockUSDC`, rate-limited testnet faucet |
| Collateral price | **Mock (TEST-ONLY)** | `MockRWAOracle`: Morpho-compatible, manually set to simulate crashes; each demo user gets their own market + oracle |
| Risk simulator | Simulation | Client-side bigint mirror of the contract math, labeled "simulated", cross-checked with the contract's `previewProtectionAtPrice` (read-only) |
| **Sepolia deployment** | **Not executed** | No funded deployer key was available in this environment. Scripts are ready and the full scenario passes on a **Sepolia fork against the real Morpho deployment**. No Sepolia addresses or tx hashes are claimed. |
| Real RWA tokens / Chainlink or Ondo price feeds | Not implemented | Mock oracle only |
| Collateral-selling deleverage (flash loans / swaps) | Not implemented | Protection repays from a pre-funded stablecoin reserve |
| Decentralized automation (Chainlink Automation / Gelato) | Not implemented | Single keeper process; anyone can also call `executeProtection` |
| WalletConnect / mobile wallets | Not implemented | Injected wallets (MetaMask via EIP-6963) + a local-only Anvil dev wallet |
| Indexer / subgraph, notifications | Not implemented | History is read with chunked `eth_getLogs` over a lookback window |
| Security audit | Not done | See [docs/SECURITY.md](docs/SECURITY.md) |

---

## Repository layout

```
├── contracts/                 Foundry project
│   ├── src/RWASafetyGuard.sol         custom protection contract (main)
│   ├── src/interfaces/IRWASafetyGuard.sol   structs, events, errors
│   ├── src/mocks/                     MockRWAToken (mSPY), MockUSDC (mUSDC), MockRWAOracle, TestnetFaucetToken
│   ├── src/demo/DemoMarketFactory.sol per-user test markets on the real Morpho
│   ├── src/external/MorphoBlueArtifacts.sol  compiles official Morpho + AdaptiveCurveIrm (solc 0.8.19) for local use
│   ├── test/                          unit, integration (real Morpho bytecode), fuzz, invariant, Sepolia-fork tests
│   ├── script/                        DeployLocal, DeploySepolia, DemoScenario
│   └── deployments/<chainId>.json     addresses written by the deploy scripts
├── services/keeper/           TypeScript keeper (polling + HTTP trigger) and the local e2e script
├── packages/shared/           ABIs (generated), deployments, chain config, bigint protection math, formatting
├── apps/web/                  Next.js dashboard (App Router, Tailwind v4, shadcn/ui, wagmi, Recharts, Playwright)
├── scripts/sync-shared.mjs    regenerates packages/shared/src/generated from Foundry artifacts + deployments
├── docs/                      architecture, demo, deployment, security, presentation script (Bahasa Indonesia)
├── render.yaml                Render Blueprint (dashboard + keeper)
└── .env.example
```

---

## Quick start (local, reproducible, no keys)

Prerequisites: Node ≥ 20.9 (tested on 24), npm, [Foundry](https://getfoundry.sh) (tested 1.8.5), git.

```bash
git clone --recurse-submodules <repo> && cd rwa-credit-manager
npm install
```

```bash
npm run contracts:build && npm run contracts:test
```

Then, in three terminals:

```bash
npm run anvil
```

```bash
npm run deploy:local && npm run keeper
```

```bash
cp apps/web/.env.local.example apps/web/.env.local
npm run dev                                     # http://localhost:3000
```

Connect with **"Anvil dev wallet (local only)"** (or MetaMask pointed at `http://127.0.0.1:8545`, chain 31337),
click **Run guided setup**, then **Drop price 20%** — the keeper protects the position within one poll interval.
Full walkthrough: [docs/DEMO.md](docs/DEMO.md).

Headless end-to-end check of the whole scenario (real txs on Anvil, real keeper code):

```bash
npm run e2e:local
```

---

## How protection works

1. The user borrows on a Morpho Blue market (collateral mSPY, loan mUSDC, LLTV 77%).
2. The user deposits mUSDC into `RWASafetyGuard.depositReserve(market, amount)` — tracked per **(user, market id)**.
3. `setProtectionPolicy(market, triggerLtv, targetLtv, maxRepayPerExecution, cooldown, enabled)` — validated on-chain:
   `0 < target < trigger < market LLTV`, `maxRepay > 0`, `cooldown ≤ 30 days`.
4. `executeProtection(market, user)` (permissionless, `nonReentrant`):
   - `Morpho.accrueInterest(market)`; reads `position` and `market` state and the market oracle price (reverts on 0).
   - `debt = borrowShares.toAssetsUp(totalBorrowAssets, totalBorrowShares)` (same rounding as Morpho's health check),
     `collateralValue = collateral × price / 1e36`, `LTV = debt / collateralValue` (rounded up).
   - Requires `LTV ≥ trigger` and the cooldown to have elapsed.
   - `required = debt − collateralValue × target + margin` (margin = one share's worth of assets + 1 wei, so the
     post-LTV never ends above the target despite `toSharesDown` rounding in `Morpho.repay`).
   - `repay = min(required, reserve, maxRepayPerExecution)`; full debt is repaid **by shares** (no dust).
   - Effects first (reserve, totals, `lastExecutedAt`), then an **exact, single-use allowance** and `Morpho.repay(..., onBehalf = user)`.
   - Re-reads the position, **reverts if the debt did not go down**, emits `ProtectionExecuted(user, id, executor,
     assetsRepaid, sharesRepaid, debtBefore, debtAfter, ltvBefore, ltvAfter, reserveAfter, targetReached)`.
   - `targetReached` is only `true` if the reserve/cap allowed it **and** the re-read state confirms LTV ≤ target.
5. Views for UIs/keepers: `getPositionRisk`, `previewProtection`, `previewProtectionAtPrice`, `getDashboard`,
   and a paginated registry `getProtectedPositions(offset, limit)`.

There is **no owner/admin**: reserves can only leave the contract to the depositing user (`withdrawReserve`, always
to `msg.sender`) or to Morpho as repayment of that same user's debt in that same market. Details:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/SECURITY.md](docs/SECURITY.md).

---

## Test results (all actually run on 2026-10-09)

| Suite | Command | Result |
|---|---|---|
| Foundry unit/integration/fuzz/invariant (real Morpho bytecode) | `cd contracts && forge test` | **53 passed**, 0 failed, 2 skipped (fork tests without RPC) |
| Sepolia fork (real deployed Morpho + AdaptiveCurveIrm) | `SEPOLIA_RPC_URL=… forge test --match-contract SepoliaFork` | **2 passed** — scenario repays ≈160, debt ≈1,040, LTV ≤ 65% |
| Coverage | `forge coverage` | RWASafetyGuard: 99.0% lines, 96.2% statements, 84.6% branches |
| Shared protection math | `npm run test:shared` | **7 passed** (matches on-chain result to the wei: repay 160,000,002, debt 1,039,999,998) |
| Local end-to-end (real txs + real keeper code) | `npm run e2e:local` | **Passed** — debt 1,200.000013 → 1,039.999998 mUSDC, LTV 75% → 64.9999%, second keeper tick idempotent |
| Dashboard typecheck / lint / production build | `npm run typecheck`, `npm run lint`, `npm run build` | **Passed** |
| Playwright UI e2e (Edge, local Anvil, dev wallet) | `PW_CHANNEL=msedge npm run test:ui` | **2 passed** — guided setup → −20% → Execute → LTV 65%, history shows `ProtectionExecuted` |

Foundry tests cover: reserve deposits/withdrawals, per-user and per-market reserve isolation, invalid thresholds,
healthy-position rejection, the exact hackathon scenario, interest-accrued debt, insufficient reserves (partial,
honestly flagged), the per-execution cap, full repayment by shares, cooldowns, repeated keeper calls, zero/reverting
oracles, oracle scaling across decimals (incl. Morpho's own borrow limit as the check), reentrancy (three malicious
token attacks), unauthorized operations, faucet limits, the demo factory, and Morpho state after repayment.
Invariant suite (4,096 random calls): guard balance == total reserves == Σ user reserves, reserve conservation,
no standing allowance, executions only touch the caller's own reserve and always burn borrow shares.

Gas (local): `executeProtection` ≈ 127k–155k gas.

---

## Deployment

- Contracts → Sepolia: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (`script/DeploySepolia.s.sol`, verification, funding).
- Dashboard → Vercel (root directory `apps/web`) or Render (`render.yaml`).
- Keeper → Render web service (always-on plan) or any Node host.

No contracts have been deployed to Sepolia from this environment, so no public addresses or transaction hashes
are listed. After you deploy, `contracts/deployments/11155111.json` and the dashboard pick them up automatically
(`npm run sync`).

## Known limitations

- Protection is only as fast as the keeper and block inclusion; it is **not** a guarantee against liquidation
  (a gap move through the LLTV between two keeper polls can still be liquidated).
- Protection needs a pre-funded reserve; when the reserve/cap can't restore the target, execution is partial and
  reported as such (`targetReached = false`).
- The mock oracle is manual; a real deployment needs a robust oracle (and then manipulation-resistance matters, see
  SECURITY.md).
- `executeProtection` is permissionless by design (value-neutral for the user: reserve becomes debt repayment).
- The keeper is a single process; the registry is append-only (paginated) and can grow with spam policies.
- Event history is read via `eth_getLogs` with a default 50k-block lookback (public RPC range limits).
- Solidity is compiled with solc 0.8.37 (auto-detected, `^0.8.24`); Morpho artifacts with 0.8.19.
- Remaining `npm audit` findings are in dev-only ESLint dependencies (`braces`/`micromatch` via `eslint-config-next`).

## Presentation

Three-minute pitch script in Bahasa Indonesia: [docs/PRESENTATION_ID.md](docs/PRESENTATION_ID.md).

## License

MIT for this project's code. Morpho Blue / AdaptiveCurveIrm sources in `contracts/lib` keep their own licenses
(they are only compiled for local testing; Sepolia uses the official deployment).
