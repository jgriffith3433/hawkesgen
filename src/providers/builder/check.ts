// The compile-only check of a customer Unity build (docs/unity-cloudrun.md, "Compile-only check"): the same container,
// licence, Unity version and Library cache as a customer build, but Unity only imports and compiles the scripts and
// exits: no player build, no build method, no output, and the cache is restored and never saved. This file is the part
// that needs no cloud: the compiler errors read out of Unity's log, and what a check costs in credits.

/** One compiler error, as Studio shows it: `Assets/Scripts/Foo.cs(12,34): error CS1503: ...`. */
export type CompileError = { file: string; line: number; col: number; code: string; message: string };

/** At most this many errors come back; Unity prints each twice and a broken assembly can print thousands. */
export const MAX_COMPILE_ERRORS = 100;

// Unity's line, sometimes after a "[timestamp]" or a log prefix: path.cs(line,col): error CSnnnn: message.
const ERROR_RE = /^((?:[^\s(][^(\r\n]*?)\.cs)\((\d+),(\d+)\):\s*error\s+(CS\d{4}):\s*(.*?)\s*$/;

/** The compiler errors in a Unity log: unique (file, line, column, code, message), in log order, capped at 100. */
export function parseCompileErrors(log: string, max = MAX_COMPILE_ERRORS): CompileError[] {
  const out: CompileError[] = [];
  const seen = new Set<string>();
  for (const raw of log.split(/\r?\n/)) {
    if (!raw.includes('error CS')) continue;
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^(?:\s*\[[^\]]*\]\s*)+/, '');
    const m = ERROR_RE.exec(line);
    if (!m) continue;
    const e: CompileError = { file: m[1].trim().replace(/\\/g, '/'), line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5].slice(0, 500) };
    const key = `${e.file}|${e.line}|${e.col}|${e.code}|${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

/** The flat credits a check reserves (1 credit = $0.01); it is then settled by the machine-minutes it used. */
export function checkCreditsReserved(env: Record<string, string | undefined> = process.env): number {
  const n = Math.round(Number(env.UNITY_CHECK_CREDITS));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : 15;
}

/** The one-line summary of a failed check: how many errors and the first. */
export function compileSummary(errors: CompileError[]): string {
  if (!errors.length) return 'the project did not compile';
  const e = errors[0];
  return `${errors.length} compiler error${errors.length === 1 ? '' : 's'}; first: ${e.file}(${e.line},${e.col}): ${e.code}: ${e.message}`.slice(0, 600);
}
