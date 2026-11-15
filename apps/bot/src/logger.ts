/**
 * Minimal structured logger.
 *
 * Deliberately dependency-free: a single line per record, machine-parseable,
 * with the fields bag last so the message is always readable first. Tests pass a
 * sink that captures lines; production writes to stdout.
 */
import type { LogLevelName } from './config.js';

export type LogLevel = LogLevelName;

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LogSink {
  (line: string): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Collapse newlines so one record stays one line. */
function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ');
}

function format(level: LogLevel, message: string, fields?: LogFields): string {
  const stamp = new Date().toISOString();
  let suffix = '';
  if (fields && Object.keys(fields).length > 0) {
    try {
      suffix = ` ${JSON.stringify(fields)}`;
    } catch {
      suffix = ' {"fields":"<unserializable>"}';
    }
  }
  return `${stamp} ${level.toUpperCase().padEnd(5)} ${oneLine(message)}${suffix}`;
}

export function createLogger(level: LogLevel = 'info', sink?: LogSink): Logger {
  const write: LogSink =
    sink ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const emit = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (ORDER[recordLevel] < ORDER[level]) return;
    write(format(recordLevel, message, fields));
  };
  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

/** Logger that discards everything; convenient as a default in tests. */
export function silentLogger(): Logger {
  return createLogger('error', () => {});
}