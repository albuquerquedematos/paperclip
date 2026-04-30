/**
 * CF Workers-compatible pino shim.
 *
 * The real pino requires Node.js APIs (events, worker_threads, etc.) that are
 * not available in the Workers runtime. This shim provides the same interface
 * backed by console.log/warn/error so server code works without changes.
 */

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
type LogFn = (msg: string, context?: Record<string, unknown>) => void;

const LEVELS: Record<LogLevel, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
};

function makeLogger(bindings: Record<string, unknown> = {}, minLevel: LogLevel = "info"): PinoLogger {
  const minNum = LEVELS[minLevel] ?? 30;

  function logAt(level: LogLevel, ...args: unknown[]) {
    if ((LEVELS[level] ?? 0) < minNum) return;
    const [msgOrObj, ...rest] = args;
    const context = { ...bindings };
    let msg: string;
    if (typeof msgOrObj === "string") {
      msg = msgOrObj;
    } else if (msgOrObj && typeof msgOrObj === "object") {
      Object.assign(context, msgOrObj);
      msg = (rest[0] as string) ?? "";
    } else {
      msg = String(msgOrObj ?? "");
    }
    const entry = JSON.stringify({ level: LEVELS[level], msg, ...context });
    if (level === "error" || level === "fatal") console.error(entry);
    else if (level === "warn") console.warn(entry);
    else console.log(entry);
  }

  const logger: PinoLogger = {
    level: minLevel,
    trace: (...args: unknown[]) => logAt("trace", ...args),
    debug: (...args: unknown[]) => logAt("debug", ...args),
    info: (...args: unknown[]) => logAt("info", ...args),
    warn: (...args: unknown[]) => logAt("warn", ...args),
    error: (...args: unknown[]) => logAt("error", ...args),
    fatal: (...args: unknown[]) => logAt("fatal", ...args),
    child: (childBindings: Record<string, unknown>) =>
      makeLogger({ ...bindings, ...childBindings }, minLevel),
    isLevelEnabled: (level: string) => (LEVELS[level as LogLevel] ?? 0) >= minNum,
    // pino compat properties
    bindings: () => ({ ...bindings }),
    flush: () => {},
    setBindings: (_: Record<string, unknown>) => {},
    // pino v9 adds these
    silent: () => {},
  };
  return logger;
}

interface PinoLogger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child: (bindings: Record<string, unknown>) => PinoLogger;
  isLevelEnabled: (level: string) => boolean;
  bindings: () => Record<string, unknown>;
  flush: () => void;
  setBindings: (bindings: Record<string, unknown>) => void;
  silent: () => void;
}

// pino(opts?) or pino(opts?, stream?)
function pino(opts?: Record<string, unknown> | null): PinoLogger {
  const level = (opts?.level as LogLevel) ?? "info";
  return makeLogger({}, level);
}

// pino.destination() stub
pino.destination = () => ({ write: () => {} });
// pino.transport() stub
pino.transport = () => ({ write: () => {} });
// pino.levels compat
pino.levels = { values: LEVELS };
// pino.stdSerializers
pino.stdSerializers = {
  err: (e: Error) => ({ type: e.name, msg: e.message, stack: e.stack }),
  req: (r: unknown) => r,
  res: (r: unknown) => r,
};

export default pino;
export { pino };
