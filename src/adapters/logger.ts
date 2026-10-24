import type { LogLevel } from '../config/settings';
const ranks: Record<LogLevel, number> = {debug: 10, info: 20, warn: 30, error: 40, fatal: 50};
export class JsonLogger {
  constructor(private readonly level: LogLevel = 'info') {}
  debug(event: string, fields?: Record<string, unknown>): void { this.log('debug', event, fields); }
  info(event: string, fields?: Record<string, unknown>): void { this.log('info', event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.log('warn', event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.log('error', event, fields); }
  log(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (ranks[level] < ranks[this.level]) return;
    // Call sites pass identifiers/codes only; never raw HTTP bodies or headers.
    const safe = Object.fromEntries(Object.entries(fields).filter(([key]) => !/secret|authorization|api.?key|payload|body/i.test(key)).map(([key, value]) => [key, typeof value === 'string' ? value.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 512) : value]));
    const line = JSON.stringify({...safe, timestamp: new Date().toISOString(), level, event, component: fields.component ?? 'service'});
    (ranks[level] >= 40 ? process.stderr : process.stdout).write(line + '\n');
  }
}
