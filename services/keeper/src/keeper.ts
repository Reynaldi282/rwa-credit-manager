import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  PreviewStatus,
  anvilLocal,
  morphoAbi,
  rwaSafetyGuardAbi,
  sepolia,
  type MarketParams,
} from "@rwa/shared";
import type { KeeperConfig } from "./config";
import { log } from "./logger";

export type PositionCheck = {
  user: Address;
  marketId: Hex;
  status: PreviewStatus;
  executable: boolean;
  ltv: string;
  debt: string;
  repayAmount: string;
  targetReachable: boolean;
  checkedAt: string;
};

export type ExecutionRecord = {
  at: string;
  user: Address;
  marketId: Hex;
  outcome: "executed" | "reverted" | "skipped" | "failed";
  txHash?: Hex;
  blockNumber?: string;
  assetsRepaid?: string;
  debtBefore?: string;
  debtAfter?: string;
  ltvBefore?: string;
  ltvAfter?: string;
  reserveAfter?: string;
  targetReached?: boolean;
  reason?: string;
};

export type TickResult = {
  startedAt: string;
  finishedAt: string;
  trigger: "poll" | "manual" | "once";
  positions: number;
  checks: PositionCheck[];
  executions: ExecutionRecord[];
  error?: string;
};

export type TickFilter = { user?: Address; marketId?: Hex };

/** Decodes a custom-error name / revert reason from a viem error. */
export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) return `${name}(${(reverted.data?.args ?? []).map(String).join(", ")})`;
      return reverted.reason ?? reverted.shortMessage;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export class Keeper {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  readonly history: ExecutionRecord[] = [];
  readonly lastChecks = new Map<string, PositionCheck>();
  readonly stats = {
    ticks: 0,
    executions: 0,
    failures: 0,
    consecutiveErrors: 0,
    lastTickAt: undefined as string | undefined,
    lastError: undefined as string | undefined,
    startedAt: new Date().toISOString(),
  };

  private readonly inFlight = new Set<string>();
  private readonly marketCache = new Map<Hex, MarketParams>();
  private mutex: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(readonly cfg: KeeperConfig) {
    const base = cfg.chainId === sepolia.id ? sepolia : anvilLocal;
    const chain: Chain = { ...base, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
    const transport = http(cfg.rpcUrl, { retryCount: 3, retryDelay: 500, timeout: 20_000 });
    this.publicClient = createPublicClient({ chain, transport });
    const account =
      cfg.account.kind === "privateKey" ? privateKeyToAccount(cfg.account.privateKey) : cfg.account.address;
    this.walletClient = createWalletClient({ chain, transport, account }) as WalletClient<Transport, Chain, Account>;
  }

  get address(): Address {
    return this.walletClient.account.address;
  }

  /** Serialises ticks: a manual trigger arriving during a poll waits for it instead of running concurrently. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.catch(() => undefined);
    return run;
  }

  async listPositions(): Promise<{ user: Address; id: Hex }[]> {
    const count = await this.publicClient.readContract({
      address: this.cfg.guard,
      abi: rwaSafetyGuardAbi,
      functionName: "protectedPositionsCount",
    });
    const out: { user: Address; id: Hex }[] = [];
    for (let offset = 0n; offset < count; offset += BigInt(this.cfg.pageSize)) {
      const page = await this.publicClient.readContract({
        address: this.cfg.guard,
        abi: rwaSafetyGuardAbi,
        functionName: "getProtectedPositions",
        args: [offset, BigInt(this.cfg.pageSize)],
      });
      for (const p of page) out.push({ user: p.user, id: p.id });
    }
    return out;
  }

  async marketParams(id: Hex): Promise<MarketParams> {
    const cached = this.marketCache.get(id);
    if (cached) return cached;
    const p = await this.publicClient.readContract({
      address: this.cfg.morpho,
      abi: morphoAbi,
      functionName: "idToMarketParams",
      args: [id],
    });
    const mp: MarketParams = {
      loanToken: p.loanToken,
      collateralToken: p.collateralToken,
      oracle: p.oracle,
      irm: p.irm,
      lltv: p.lltv,
    };
    this.marketCache.set(id, mp);
    return mp;
  }

  async check(user: Address, id: Hex, mp: MarketParams): Promise<PositionCheck> {
    const pv = await this.publicClient.readContract({
      address: this.cfg.guard,
      abi: rwaSafetyGuardAbi,
      functionName: "previewProtection",
      args: [mp, user],
    });
    const c: PositionCheck = {
      user,
      marketId: id,
      status: pv.status as PreviewStatus,
      executable: pv.executable,
      ltv: pv.currentLtv.toString(),
      debt: pv.debt.toString(),
      repayAmount: pv.repayAmount.toString(),
      targetReachable: pv.targetReachable,
      checkedAt: new Date().toISOString(),
    };
    this.lastChecks.set(`${user}:${id}`, c);
    return c;
  }

  /** Sends `executeProtection` for one position, waits for the receipt and decodes the event. */
  async execute(user: Address, id: Hex, mp: MarketParams): Promise<ExecutionRecord> {
    const key = `${user}:${id}`;
    const base = { at: new Date().toISOString(), user, marketId: id };
    if (this.inFlight.has(key)) return { ...base, outcome: "skipped", reason: "execution already in flight" };
    this.inFlight.add(key);
    try {
      // Simulate first: if another keeper already protected the position, this reverts without spending gas.
      const { request } = await this.publicClient.simulateContract({
        address: this.cfg.guard,
        abi: rwaSafetyGuardAbi,
        functionName: "executeProtection",
        args: [mp, user],
        account: this.walletClient.account,
      });
      const hash = await this.walletClient.writeContract(request);
      log.info("executeProtection sent", { user, marketId: id, txHash: hash });

      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") {
        this.stats.failures++;
        log.error("executeProtection reverted on-chain", { txHash: hash, block: receipt.blockNumber });
        return { ...base, outcome: "reverted", txHash: hash, blockNumber: receipt.blockNumber.toString() };
      }

      const [ev] = parseEventLogs({ abi: rwaSafetyGuardAbi, logs: receipt.logs, eventName: "ProtectionExecuted" });
      this.stats.executions++;
      const rec: ExecutionRecord = {
        ...base,
        outcome: "executed",
        txHash: hash,
        blockNumber: receipt.blockNumber.toString(),
        assetsRepaid: ev?.args.assetsRepaid.toString(),
        debtBefore: ev?.args.debtBefore.toString(),
        debtAfter: ev?.args.debtAfter.toString(),
        ltvBefore: ev?.args.ltvBefore.toString(),
        ltvAfter: ev?.args.ltvAfter.toString(),
        reserveAfter: ev?.args.reserveAfter.toString(),
        targetReached: ev?.args.targetReached,
      };
      log.info("ProtectionExecuted confirmed", {
        txHash: hash,
        block: receipt.blockNumber,
        repaid: rec.assetsRepaid,
        debtBefore: rec.debtBefore,
        debtAfter: rec.debtAfter,
        ltvAfter: rec.ltvAfter,
        targetReached: rec.targetReached,
      });
      return rec;
    } catch (e) {
      const reason = revertReason(e);
      const benign = /PositionHealthy|CooldownActive|ProtectionDisabled|NoDebt/.test(reason);
      if (!benign) this.stats.failures++;
      (benign ? log.warn : log.error)("executeProtection not sent", { user, marketId: id, reason });
      return { ...base, outcome: benign ? "skipped" : "failed", reason };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** One full pass: read every registered position, execute the executable ones sequentially. */
  tick(trigger: TickResult["trigger"], filter: TickFilter = {}): Promise<TickResult> {
    return this.exclusive(async () => {
      const startedAt = new Date().toISOString();
      const checks: PositionCheck[] = [];
      const executions: ExecutionRecord[] = [];
      let positions = 0;
      try {
        const all = await this.listPositions();
        const selected = all.filter(
          (p) =>
            (!filter.user || p.user.toLowerCase() === filter.user.toLowerCase()) &&
            (!filter.marketId || p.id.toLowerCase() === filter.marketId.toLowerCase()),
        );
        positions = selected.length;
        for (const p of selected) {
          try {
            const mp = await this.marketParams(p.id);
            const c = await this.check(p.user, p.id, mp);
            checks.push(c);
            if (c.executable) {
              const rec = await this.execute(p.user, p.id, mp);
              executions.push(rec);
              this.history.unshift(rec);
              this.history.length = Math.min(this.history.length, 200);
            }
          } catch (e) {
            // One broken market (e.g. a reverting oracle) must not block the others.
            log.warn("position check failed", { user: p.user, marketId: p.id, reason: revertReason(e) });
          }
        }
        this.stats.consecutiveErrors = 0;
        this.stats.lastError = undefined;
      } catch (e) {
        this.stats.consecutiveErrors++;
        this.stats.lastError = revertReason(e);
        log.error("tick failed (RPC?)", { reason: this.stats.lastError, consecutive: this.stats.consecutiveErrors });
        return { startedAt, finishedAt: new Date().toISOString(), trigger, positions, checks, executions, error: this.stats.lastError };
      } finally {
        this.stats.ticks++;
        this.stats.lastTickAt = new Date().toISOString();
      }
      log.info("tick done", { trigger, positions, executable: checks.filter((c) => c.executable).length, executed: executions.filter((e) => e.outcome === "executed").length });
      return { startedAt, finishedAt: new Date().toISOString(), trigger, positions, checks, executions };
    });
  }

  /** Background polling with exponential backoff on consecutive RPC errors (max 5 min). */
  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.tick("poll");
      const backoff = Math.min(this.cfg.pollIntervalMs * 2 ** this.stats.consecutiveErrors, 300_000);
      this.timer = setTimeout(loop, backoff);
    };
    void loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}
