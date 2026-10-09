type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.KEEPER_LOG_LEVEL as Level) ?? "info"] ?? order.info;

function emit(level: Level, msg: string, data?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] ${msg}`;
  const extra = data ? ` ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` : "";
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line + extra);
}

export const log = {
  debug: (m: string, d?: Record<string, unknown>) => emit("debug", m, d),
  info: (m: string, d?: Record<string, unknown>) => emit("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => emit("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => emit("error", m, d),
};
