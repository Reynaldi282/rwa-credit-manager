# Deployment (Ethereum Sepolia only)

> Never deploy this to mainnet: the mock tokens have open faucets and the oracle is manual. The scripts refuse any
> chain other than Sepolia (11155111) or Anvil (31337). Never commit private keys.

**Status:** not yet deployed to Sepolia from this repository (no funded deployer key was available when it was
built). Everything below has been validated except the final broadcast:

- `test/SepoliaFork.t.sol` runs the full scenario on a Sepolia fork against the **real** Morpho Blue and
  AdaptiveCurveIrm (passing).
- `forge script script/DeploySepolia.s.sol --rpc-url <sepolia>` (dry run, no `--broadcast`) completes against live
  Sepolia state: governance checks pass, **≈ 9.7M gas** in total.

## Verified Sepolia parameters

| Item | Value | How it was checked |
|---|---|---|
| Morpho Blue | `0xd011EE229E7459ba1ddd22631eF7bF528d424A14` | code present, `owner()` readable |
| AdaptiveCurveIrm | `0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c` | `Morpho.isIrmEnabled == true`, `IRM.MORPHO() == Morpho` |
| LLTV 77% | `770000000000000000` | `Morpho.isLltvEnabled == true` (also enabled: 0, 38.5, 62.5, 86, 91.5, 94.5 %) |

The deploy script and `DemoMarketFactory`'s constructor re-check `isIrmEnabled` / `isLltvEnabled` before any market is
created.

## 1. Prepare a deployer wallet

```bash
git clone --recurse-submodules <repo> && cd rwa-credit-manager && npm install
cast wallet new                       # creates a fresh testnet-only key; store it safely
cast wallet import deployer --interactive   # encrypted keystore at ~/.foundry/keystores/deployer
```

Fund it with Sepolia ETH (≈ 0.05 ETH is plenty; at the time of testing gas was far below 1 gwei) from a public faucet
such as the Google Cloud Web3 faucet or the Alchemy Sepolia faucet.

## 2. Deploy

```bash
cp .env.example .env            # set SEPOLIA_RPC_URL and ETHERSCAN_API_KEY
cd contracts
source ../.env                  # or export the two variables
forge script script/DeploySepolia.s.sol --rpc-url sepolia --broadcast --account deployer --verify
```

This deploys `MockUSDC`, `MockRWAToken`, `RWASafetyGuard(Morpho)`, `DemoMarketFactory`, creates a default demo market
(oracle owned by the deployer) and supplies 100,000 mUSDC of liquidity to it. It writes
`contracts/deployments/11155111.json` (only on a real broadcast) and the tx hashes to
`contracts/broadcast/DeploySepolia.s.sol/11155111/run-latest.json` (kept in git as evidence).

```bash
cd .. && npm run sync           # regenerates packages/shared/src/generated/deployments.ts
git add contracts/deployments/11155111.json packages/shared/src/generated contracts/broadcast
```

Optionally run the scenario on-chain to produce public evidence:

```bash
cd contracts && forge script script/DemoScenario.s.sol --rpc-url sepolia --broadcast --account deployer
```

## 3. Verify contracts (if `--verify` was skipped or failed)

```bash
cd contracts
CHAIN=sepolia
forge verify-contract <MOCK_USDC> src/mocks/MockUSDC.sol:MockUSDC --chain $CHAIN \
  --constructor-args $(cast abi-encode "constructor(address)" <DEPLOYER>)
forge verify-contract <MOCK_SPY> src/mocks/MockRWAToken.sol:MockRWAToken --chain $CHAIN \
  --constructor-args $(cast abi-encode "constructor(address)" <DEPLOYER>)
forge verify-contract <GUARD> src/RWASafetyGuard.sol:RWASafetyGuard --chain $CHAIN \
  --constructor-args $(cast abi-encode "constructor(address)" 0xd011EE229E7459ba1ddd22631eF7bF528d424A14)
forge verify-contract <FACTORY> src/demo/DemoMarketFactory.sol:DemoMarketFactory --chain $CHAIN \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address,uint256,uint256)" \
    0xd011EE229E7459ba1ddd22631eF7bF528d424A14 <MOCK_USDC> <MOCK_SPY> 0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c 770000000000000000 50000000000)
# Oracles created by the factory (one per demo market):
forge verify-contract <ORACLE> src/mocks/MockRWAOracle.sol:MockRWAOracle --chain $CHAIN \
  --constructor-args $(cast abi-encode "constructor(address,uint8,uint8,uint256)" <ORACLE_OWNER> 18 6 50000000000)
```

The compiler version and settings come from `foundry.toml` (solc auto-detected for `^0.8.24`, optimizer 200 runs,
`evm_version = cancun`). Check the exact solc in `contracts/out/RWASafetyGuard.sol/RWASafetyGuard.json → metadata`.

## 4. Wallet network configuration

- **MetaMask → Sepolia:** built-in network (enable "Show test networks"). Chain id `11155111`, currency SepoliaETH,
  explorer `https://sepolia.etherscan.io`.
- **Local Anvil (optional):** Add network → RPC `http://127.0.0.1:8545`, chain id `31337`, symbol ETH. Anvil's
  default accounts are public test keys — never use them on any real network.
- Add tokens in MetaMask with the addresses from `contracts/deployments/11155111.json` (mUSDC 6 decimals, mSPY 18).

## 5. Demo wallet funding

- Gas: Sepolia ETH from a public faucet.
- Test assets: the dashboard's **Mint Test RWA / Mint Test USDC** buttons (faucet limits: 10 mSPY / 10,000 mUSDC per
  call, 50 / 50,000 per address per 24 h).
- More assets for a presenter (deployer has `MINTER_ROLE`):

```bash
cast send <MOCK_USDC> "mint(address,uint256)" <WALLET> 100000000000 --rpc-url sepolia --account deployer   # 100,000 mUSDC
cast send <MOCK_SPY>  "mint(address,uint256)" <WALLET> 100000000000000000000 --rpc-url sepolia --account deployer # 100 mSPY
```

## 6. Dashboard

Environment (all `NEXT_PUBLIC_*`, inlined at build time — rebuild after changing):

```
NEXT_PUBLIC_DEFAULT_CHAIN_ID=11155111
NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=false
NEXT_PUBLIC_ENABLE_DEV_WALLET=false
NEXT_PUBLIC_SEPOLIA_RPC_URL=<a Sepolia RPC for reads>
NEXT_PUBLIC_KEEPER_URL=<https URL of the keeper, optional>
```

**Vercel:** import the repo → *Root Directory* `apps/web` (framework: Next.js). Because the app depends on the
`@rwa/shared` workspace, set *Install Command* `cd ../.. && npm ci` and keep *Build Command* `npm run build`.
Keep "Include source files outside of the Root Directory" enabled (default).

**Render:** `render.yaml` defines the dashboard (`rwa-credit-manager-web`) and the keeper
(`rwa-credit-manager-keeper`). New Blueprint → select the repo → fill the `sync: false` values → after the keeper is
live, set `NEXT_PUBLIC_KEEPER_URL` on the web service and redeploy it.

## 7. Keeper

```bash
KEEPER_CHAIN_ID=11155111 \
KEEPER_RPC_URL=<sepolia rpc> \
KEEPER_PRIVATE_KEY=<dedicated keeper key> \
KEEPER_CORS_ORIGINS=https://<your-dashboard-host> \
npm run keeper
```

- Use a **dedicated** wallet with only a little Sepolia ETH: the keeper only pays gas; it never holds user funds
  (`executeProtection` pays from the user's reserve inside the guard).
- `npm run keeper:once` runs a single pass and exits (usable from a cron job).
- Hosting: any always-on Node host. On Render use a paid instance type — free web services spin down when idle,
  which would silently stop polling.
- Health: `GET /health`; status and recent executions: `GET /status`; manual trigger: `POST /run`.
- Automation is best-effort: if the keeper is down or its transaction is not included in time, protection does not
  happen automatically (the user or anyone can still call `executeProtection`).
