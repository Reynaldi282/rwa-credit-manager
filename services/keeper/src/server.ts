import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAddress, isHex, type Address, type Hex } from "viem";
import type { Keeper, TickFilter } from "./keeper";
import { log } from "./logger";

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const MIN_MANUAL_INTERVAL_MS = 2_000;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 10_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

/**
 * Minimal HTTP API so the dashboard can trigger the keeper manually:
 *   GET  /health  liveness + config
 *   GET  /status  stats, last checks, recent executions
 *   POST /run     { user?, marketId? } -> runs one (filtered) tick and returns its result
 */
export function startServer(keeper: Keeper) {
  let lastManual = 0;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    const allowAll = keeper.cfg.corsOrigins.includes("*");
    if (origin && (allowAll || keeper.cfg.corsOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", allowAll ? "*" : origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(json(body));
    };
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return send(200, {
          ok: true,
          chainId: keeper.cfg.chainId,
          guard: keeper.cfg.guard,
          keeper: keeper.address,
          pollIntervalMs: keeper.cfg.pollIntervalMs,
          lastTickAt: keeper.stats.lastTickAt,
        });
      }
      if (req.method === "GET" && url.pathname === "/status") {
        return send(200, {
          stats: keeper.stats,
          keeper: keeper.address,
          chainId: keeper.cfg.chainId,
          checks: [...keeper.lastChecks.values()],
          history: keeper.history.slice(0, 50),
        });
      }
      if (req.method === "POST" && url.pathname === "/run") {
        const now = Date.now();
        if (now - lastManual < MIN_MANUAL_INTERVAL_MS) return send(429, { error: "slow down" });
        lastManual = now;
        const body = (await readBody(req)) as { user?: string; marketId?: string };
        const filter: TickFilter = {};
        if (body.user !== undefined) {
          if (!isAddress(body.user)) return send(400, { error: "invalid user" });
          filter.user = body.user as Address;
        }
        if (body.marketId !== undefined) {
          if (!isHex(body.marketId) || body.marketId.length !== 66) return send(400, { error: "invalid marketId" });
          filter.marketId = body.marketId as Hex;
        }
        log.info("manual trigger", { filter });
        return send(200, await keeper.tick("manual", filter));
      }
      return send(404, { error: "not found" });
    } catch (e) {
      log.error("http error", { reason: e instanceof Error ? e.message : String(e) });
      return send(500, { error: "internal error" });
    }
  });

  server.listen(keeper.cfg.port, keeper.cfg.host, () =>
    log.info(`keeper HTTP API on http://${keeper.cfg.host}:${keeper.cfg.port}`),
  );
  return server;
}
