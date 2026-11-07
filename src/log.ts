type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(Bun.env.LOG_LEVEL as Level | undefined) ?? "info"] ?? order.info;

const paint = (level: Level, text: string) => {
  const code = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" }[level];
  return `${code}${text}\x1b[0m`;
};

const emit = (level: Level, scope: string, message: string, fields?: Record<string, unknown>) => {
  if (order[level] < min) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const tail = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  const line = `${stamp} ${paint(level, level.toUpperCase().padEnd(5))} ${scope} ${message}${tail}`;
  if (level === "error") console.error(line);
  else console.log(line);
};

export const log = (scope: string) => ({
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", scope, message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", scope, message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", scope, message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", scope, message, fields),
});
