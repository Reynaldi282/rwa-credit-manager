# Reproducible demo

Three ways to run the hackathon scenario, from fastest to most realistic. All of them send **real transactions** to the
real Morpho Blue contract (local copy of the official bytecode, or the official Sepolia deployment).

| Step | Action | Expected |
|---|---|---|
| 1 | Connect wallet | address + network shown |
| 2 | Mint test RWA | 4 mSPY (faucet) |
| 3 | Create market, supply liquidity, deposit 4 mSPY, borrow 1,200 mUSDC | collateral $2,000, debt $1,200, **LTV 60%** |
| 4 | Deposit 200 mUSDC reserve | reserve $200 |
| 5 | Policy trigger 70%, target 65%, max 500 | "Armed — below trigger" |
| 6 | Test oracle −20% ($500 → $400) | collateral $1,600 |
| 7 | — | **LTV 75%** (still below LLTV 77%), "Trigger reached — executable" |
| 8 | Execute protection (keeper or button) | one tx: `RWASafetyGuard.executeProtection → Morpho.repay` |
| 9 | — | debt **≈ $1,040** (exact value includes a few micro-dollars of interest) |
| 10 | — | **LTV ≈ 65%** (≤ 65% by construction), reserve ≈ $40 |
| 11 | History | `ProtectionExecuted` row with tx hash (+ Etherscan event-log link on Sepolia) |

Exact numbers from a local run: repaid `160.000038` mUSDC, debt `1,200.000036 → 1,039.999998`, LTV `75.00% → 64.9999%`.

---

## A. Headless, one command (local)

```bash
npm install
npm run anvil                 # terminal 1 — fresh chain
npm run deploy:local          # terminal 2 — official Morpho bytecode + our contracts, writes deployments/31337.json
npm run e2e:local             # runs steps 2–11 as Anvil account #2, executes with the real keeper code as account #3
```

It prints every transaction hash and the decoded `ProtectionExecuted` event, asserts the numbers, and also checks that a
second keeper tick does nothing. Alternatively, the same flow as a broadcast Foundry script:

```bash
npm run demo:forge:local      # contracts/script/DemoScenario.s.sol, txs in contracts/broadcast/DemoScenario.s.sol/31337/
```

## B. Dashboard (local, no browser extension needed)

```bash
npm run anvil
npm run deploy:local
npm run keeper                                       # optional: automatic protection (polls every 15 s, KEEPER_POLL_INTERVAL_MS)
cp apps/web/.env.local.example apps/web/.env.local
npm run dev                                          # http://localhost:3000
```

1. **Connect wallet → "Anvil dev wallet (local only)"**. This connector uses Anvil's unlocked account #5; the app
   never holds a key. (MetaMask also works: add network RPC `http://127.0.0.1:8545`, chain id `31337`, and import an
   Anvil test account — never reuse those keys anywhere else.)
2. **Hackathon demo mode → Run guided setup (steps 1–7)**. It mints, creates *your* market, supplies liquidity,
   deposits collateral, borrows 1,200 and configures protection — each step is a transaction (approvals included).
3. Check the overview: LTV 60%, liquidation price $389.61, trigger price $428.57, reserve $200.
4. Move the **Risk simulator** slider to −20%: simulated LTV 75%, repayment $160, post-LTV 65%, reserve $40 — labeled
   "Simulated", with a read-only contract cross-check underneath.
5. **Step 8 → Drop price 20%** (test oracle).
6. Either wait for the keeper (it logs `executeProtection sent … txHash`), click **Run keeper now**, or click
   **Execute protection** yourself.
7. LTV shows 65.00%, debt $1,040.00; **Transaction history** shows "Protection executed — repaid $160.00 · debt
   $1,200.00 → $1,040.00 · LTV 75.00% → 65.00%" and "Morpho repay (by guard)".
8. **Reset price** restores $500; **Create another** (step 3) starts a completely fresh market.

Automated version of this exact flow (Playwright):

```bash
PW_CHANNEL=msedge npm run test:ui     # or: npx playwright install chromium && npm run test:ui
```

## C. Sepolia with MetaMask

Prerequisite: contracts deployed to Sepolia ([DEPLOYMENT.md](DEPLOYMENT.md)) and the dashboard built with
`NEXT_PUBLIC_DEFAULT_CHAIN_ID=11155111`.

1. MetaMask → network **Sepolia** (chain id 11155111). Fund the wallet with a little Sepolia ETH from a public faucet
   (e.g. Google Cloud Web3 faucet, Alchemy Sepolia faucet). Use a fresh wallet with no real funds.
2. Same steps as B. Each click opens a MetaMask confirmation (≈ 12 confirmations for the guided setup).
3. After execution, open the **Event log** link in the history row: Etherscan shows the `ProtectionExecuted` event
   emitted by `RWASafetyGuard` and the `Repay` event emitted by Morpho Blue in the same transaction.
4. To demo automation, run the keeper against Sepolia (`KEEPER_CHAIN_ID=11155111`, `KEEPER_RPC_URL`,
   `KEEPER_PRIVATE_KEY` of a dedicated keeper wallet) and set `NEXT_PUBLIC_KEEPER_URL`.

Broadcast version (writes tx hashes to `contracts/broadcast/DemoScenario.s.sol/11155111/run-latest.json`):

```bash
cd contracts && forge script script/DemoScenario.s.sol --rpc-url sepolia --broadcast --account <keystore>
```

## Troubleshooting

- **"Contracts not deployed on …"** — run the deploy script for that chain, then `npm run sync` and restart/rebuild.
- **Anvil restarted** — redeploy (`npm run deploy:local`); in MetaMask, *Settings → Advanced → Clear activity tab data*
  to reset the nonce.
- **Old rows in the history after an Anvil reset** — wallet-side entries (approvals) are kept in browser storage;
  clear the site data for `localhost:3000`. On-chain rows are always re-read from the chain.
- **Faucet limit** — 10 mSPY / 10,000 mUSDC per call, 50 / 50,000 per address per 24 h.
- **"not executable yet"** — LTV is below the trigger; drop the price further or lower the trigger.
- **Partial protection** — if the reserve or the per-execution cap can't restore the target, the UI warns before
  execution and the event reports `targetReached = false`.
