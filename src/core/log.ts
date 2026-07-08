/**
 * Leveled logger with an in-memory ring buffer.
 *
 * The buffer feeds the in-game developer console (F12 overlay) so the whole
 * generation/simulation trace is inspectable at runtime without devtools.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  tag: string;
  message: string;
  time: number; // wall-clock ms
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const BUFFER_MAX = 2000;

class LoggerImpl {
  minLevel: LogLevel = "info";
  readonly buffer: LogEntry[] = [];
  private listeners = new Set<(e: LogEntry) => void>();

  private push(level: LogLevel, tag: string, message: string): void {
    const entry: LogEntry = { level, tag, message, time: Date.now() };
    this.buffer.push(entry);
    if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
    for (const l of this.listeners) l(entry);
    if (LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel]) {
      const line = `[${tag}] ${message}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
  }

  debug(tag: string, msg: string): void { this.push("debug", tag, msg); }
  info(tag: string, msg: string): void { this.push("info", tag, msg); }
  warn(tag: string, msg: string): void { this.push("warn", tag, msg); }
  error(tag: string, msg: string): void { this.push("error", tag, msg); }

  onEntry(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const log = new LoggerImpl();
