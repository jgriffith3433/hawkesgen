// The build server's git fetch, one repo checkout at a time, retried when a ref is locked.
//
// "cannot lock ref 'refs/remotes/origin/beta': is at <sha> but expected <sha>" happens when two fetches touch the same
// checkout at once (a fetch from an earlier, interrupted seed still running on the server while beta moves during a
// burst of merges). It isn't the repo's fault: drop the stale remote-tracking ref, fetch again with --prune, and the
// build goes on instead of going back to an agent.

const GIT = `& 'C:\\Program Files\\Git\\cmd\\git.exe'`;

/** What a locked or stale ref looks like in git's answer. */
export const LOCK_RE = /cannot lock ref|unable to update local ref|some local refs could not be updated/i;

/** The remote-tracking refs a lock error names (only refs/remotes/origin/..., so they're safe to put in a command). */
export function lockedRefs(msg: string): string[] {
  const out = new Set<string>();
  for (const m of msg.matchAll(/cannot lock ref '([^']+)'/gi)) {
    if (/^refs\/remotes\/origin\/[\w./-]+$/.test(m[1]) && !m[1].includes('..')) out.add(m[1]);
  }
  return [...out];
}

/**
 * The PowerShell for one fetch (no double quotes: they don't survive SSH into Windows). It never throws: it prints "fetched", or "FETCH-FAILED <git's answer on one line>"
 * (a thrown PowerShell error ends in position lines, and only the last lines of stderr reach the job's error).
 */
export function fetchCommand(dir: string, authArg: string, retry?: { refs: string[] }) {
  return [
    `$ErrorActionPreference = 'Continue'`,
    ...(retry?.refs ?? []).map((r) => `${GIT} -C '${dir}' update-ref -d '${r}' 2>&1 | Out-Null`),
    `$o = (${GIT} -C '${dir}'${authArg} fetch -q${retry ? ' --prune' : ''} origin 2>&1 | ForEach-Object { [string]$_ }) -join ' '`,
    `if ($LASTEXITCODE) { 'FETCH-FAILED ' + $o } else { 'fetched' }`,
  ].join('; ');
}

const locks = new Map<string, Promise<unknown>>();

/** Runs fn with the checkout `key` to itself: callers for the same checkout wait their turn, others don't. */
export function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = key.toLowerCase();
  const prev = locks.get(k) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  locks.set(k, tail);
  tail.then(() => { if (locks.get(k) === tail) locks.delete(k); });
  return next;
}

export type FetchOptions = {
  /** Runs PowerShell on the build server, resolving to its output. */
  run: (command: string) => Promise<string>;
  dir: string;
  authArg?: string;
  slug: string;
  log?: (s: string) => void;
  /** Fetches in all (the first and the retries). */
  tries?: number;
  /** Waits between tries (lets a racing fetch finish). */
  wait?: (ms: number) => Promise<void>;
};

/** Fetches origin in the server's checkout; on a locked ref, drops it and fetches again with --prune. Returns the tries used. */
export async function fetchOrigin({ run, dir, authArg = '', slug, log = () => {}, tries = 3, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }: FetchOptions) {
  let retry: { refs: string[] } | undefined;
  for (let attempt = 1; ; attempt++) {
    const out = (await run(fetchCommand(dir, authArg, retry))).trim();
    const failed = out.match(/FETCH-FAILED ?(.*)$/s);
    if (!failed && /(^|\n)fetched\s*$/.test(out)) return attempt;
    const msg = (failed?.[1] ?? out).replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!LOCK_RE.test(msg)) throw new Error(`git fetch failed for ${slug}: ${msg}`);
    if (attempt >= tries) throw new Error(`git couldn't update ${slug}'s refs on the build server after ${tries} tries (another fetch kept them locked): ${msg}`);
    retry = { refs: lockedRefs(msg) };
    log(`${slug}: a ref was locked by another fetch (${retry.refs.join(', ') || 'unnamed'}); pruning and fetching again (${attempt + 1}/${tries})`);
    await wait(attempt * 5_000);
  }
}
