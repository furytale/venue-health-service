export interface ErrorDiagnostic {
  name: string;
  code?: string;
  frames: string[];
  cause?: ErrorDiagnostic;
  internalCause?: ErrorDiagnostic;
  truncated?: boolean;
}

// ASCII-only fields, <=4 nodes, <=4 locations/node and <=120 chars/location
// keep the complete JSON representation below 4096 bytes, including structure.
const MAX_NODES = 4;
const MAX_DEPTH = 3;
const MAX_FRAMES = 4;

function read(value: object, key: string): unknown {
  try { return Reflect.get(value, key); } catch { return undefined; }
}
function isError(value: unknown): value is Error {
  try { return value instanceof Error; } catch { return false; }
}

/** Fixed classification for public audit fields; never persist mutable error.name. */
export function errorClassName(value: unknown): string {
  try {
    if (value instanceof TypeError) return 'TypeError';
    if (value instanceof RangeError) return 'RangeError';
    if (value instanceof SyntaxError) return 'SyntaxError';
    if (value instanceof ReferenceError) return 'ReferenceError';
    return value instanceof Error ? 'Error' : 'NonErrorThrown';
  } catch { return 'NonErrorThrown'; }
}

function frames(error: Error, name: unknown): string[] {
  const message = read(error, 'message');
  const stack = read(error, 'stack');
  if (typeof name !== 'string' || typeof message !== 'string' || typeof stack !== 'string') return [];
  // Drop the WHOLE native header, including multiline messages that imitate frames.
  // Nonstandard/custom stack formats are omitted instead of guessing their boundary.
  const header = name ? (message ? `${name}: ${message}` : name) : message;
  if (!stack.startsWith(header) || stack[header.length] !== '\n') return [];
  const result: string[] = [];
  const tail = stack.slice(header.length + 1, header.length + 1 + 8192);
  for (const line of tail.split('\n').slice(0, 24)) {
    if (line.length > 1024 || !/^\s+at /.test(line)) continue;
    // Keep only file:line:column, never function labels, directories, URL data or eval text.
    const match = /(?:\(|at )((?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^()?#\r\n]*|node:[a-z_/-]+):(\d{1,9}):(\d{1,9})\)?$/.exec(line);
    if (!match) continue;
    const path = match[1];
    const file = path?.startsWith('node:') ? path : path?.split(/[\\/]/).at(-1);
    if (!file || !/^(?:[A-Za-z0-9_.-]{1,80}\.(?:[cm]?[jt]s|[jt]sx)|node:[a-z_/-]{1,96})$/.test(file)) continue;
    const location = `${file}:${match[2]}:${match[3]}`;
    if (location.length <= 120) result.push(location);
    if (result.length === MAX_FRAMES) break;
  }
  return result;
}

/** Diagnostic logs only. No messages, arbitrary properties, toJSON or public audit data. */
export function errorDiagnostic(error: unknown): ErrorDiagnostic {
  const seen = new Set<Error>();
  let remaining = MAX_NODES;
  const visit = (value: unknown, depth: number): ErrorDiagnostic => {
    remaining -= 1;
    if (!isError(value)) return { name: 'NonErrorThrown', frames: [] };
    if (seen.has(value)) return { name: 'CircularCause', frames: [] };
    seen.add(value);
    const name = read(value, 'name');
    const code = read(value, 'code');
    const result: ErrorDiagnostic = {
      name: typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : errorClassName(value),
      frames: frames(value, name),
    };
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) result.code = code;
    for (const key of ['cause', 'internalCause'] as const) {
      const cause = read(value, key);
      if (cause === undefined) continue;
      if (depth === MAX_DEPTH || remaining === 0) result.truncated = true;
      else result[key] = visit(cause, depth + 1);
    }
    return result;
  };
  return visit(error, 1);
}
