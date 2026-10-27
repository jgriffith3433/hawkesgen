// The Hawkes Net box deploys itself (hawkes-net-pull.timer, every 2 minutes): when hawkesgen's main moved and the change
// touches Hawkes Net (net/, the SDK in clients/js), it runs Hawkes Net's tests (net/test: no packages needed) on a clean
// copy of the new commit, fast-forwards, restarts (the relay drains first) and checks
// health; a commit whose tests or health fail is skipped. Other changes are fast-forwarded with no restart.
// Runs as root. No dependencies.   node net/deploy/pull.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = '/srv/hawkes/hawkesgen';
const STATE = '/srv/hawkes/net-data/pull.json';
const DRY = process.argv.includes('--dry-run');
const say = (...a) => console.log('[net-pull]', ...a);
const git = (...a) => execFileSync('sudo', ['-u', 'hawkes', '-H', 'git', '-C', DIR, ...a], { encoding: 'utf8' }).trim();
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } })();
const save = () => { if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 2)); };
const NET = /^(net\/|clients\/js\/hawkes-net)/;

const healthy = async () => {
  for (let i = 0; i < 20; i++) {
    const ok = await fetch('http://127.0.0.1:8800/healthz', { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

/** Hawkes Net's tests on a clean copy of `sha` (they need no packages), niced, with no secrets in the environment. */
function testedHere(sha) {
  if (state.tested?.sha === sha) return state.tested.ok;
  const wt = '/srv/hawkes/.net-test';
  const cleanup = () => { try { git('worktree', 'remove', '--force', wt); } catch { /* not there */ } fs.rmSync(wt, { recursive: true, force: true }); try { git('worktree', 'prune'); } catch { /* fine */ } };
  const t0 = Date.now();
  try {
    cleanup();
    git('worktree', 'add', '--detach', '--quiet', wt, sha);
    const tests = fs.readdirSync(path.join(wt, 'net', 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => `net/test/${f}`);
    try {
      execFileSync('sudo', ['-u', 'hawkes', '-H', 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/hawkes', 'LANG=C.UTF-8', 'CI=1', 'nice', '-n', '19', 'node', '--disable-warning=ExperimentalWarning', '--test', '--test-timeout=120000', ...tests], { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
      state.tested = { sha, ok: true, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) };
    } catch (e) {
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.split('\n').filter((l) => /^(✖|not ok)/.test(l.trim())).slice(0, 6).join(' | ');
      state.tested = { sha, ok: false, at: new Date().toISOString(), detail: (out || String(e.message).split('\n')[0]).slice(0, 500) };
    }
  } catch (e) {
    say(`${sha.slice(0, 7)}: couldn't set up the test copy: ${String(e.message).split('\n')[0]}`);
    return null;
  } finally { cleanup(); }
  save();
  return state.tested.ok;
}

// ---------------------------------------------------------------- the move to the hawkesnet repo (J, 2026-10-26)
// Hawkes Net is its own repo now (jgriffith3433/hawkesnet). Once, the box moves itself there: clone it beside this
// checkout, run its tests, put its units in place (the service and this timer's job run from /srv/hawkes/hawkesnet),
// restart and check health. On any failure the old units go back and the service runs from here as before; the move is
// tried again an hour later. After it, this file is never run again (the timer runs hawkesnet's deploy/pull.mjs).
const NEW = '/srv/hawkes/hawkesnet';
const UNITS = ['hawkes-net.service', 'hawkes-net-pull.service', 'hawkes-net-pull.timer'];
async function moveToHawkesnet() {
  if (state.moved) return false;
  if (state.moveFailedAt && Date.now() - Date.parse(state.moveFailedAt) < 3600_000) return false;
  const as = (...a) => execFileSync('sudo', ['-u', 'hawkes', '-H', ...a], { encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 }).trim();
  const backup = '/srv/hawkes/net-data/units-before-move';
  const fail = (why) => {
    say(`move to hawkesnet failed: ${why}`);
    state.moveFailedAt = new Date().toISOString();
    state.moveDetail = String(why).slice(0, 500);
    save();
  };
  try {
    if (DRY) { say(`would move to ${NEW}`); return true; }
    say('moving to the hawkesnet repo');
    if (!fs.existsSync(path.join(NEW, '.git'))) as('git', 'clone', '--quiet', '--branch', 'main', 'https://github.com/jgriffith3433/hawkesnet.git', NEW);
    else as('git', '-C', NEW, 'pull', '--quiet', '--ff-only');
    const tests = fs.readdirSync(path.join(NEW, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
    try {
      execFileSync('sudo', ['-u', 'hawkes', '-H', 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/hawkes', 'LANG=C.UTF-8', 'CI=1', 'nice', '-n', '19', 'node', '--disable-warning=ExperimentalWarning', '--test', '--test-timeout=120000', ...tests], { cwd: NEW, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.split('\n').filter((l) => /^(✖|not ok)/.test(l.trim())).slice(0, 6).join(' | ');
      fail(`hawkesnet's tests failed: ${out || String(e.message).split('\n')[0]}`);
      return true;
    }
    fs.mkdirSync(backup, { recursive: true });
    for (const u of UNITS) fs.copyFileSync(`/etc/systemd/system/${u}`, path.join(backup, u));
    for (const u of UNITS) fs.writeFileSync(`/etc/systemd/system/${u}`, fs.readFileSync(path.join(NEW, 'deploy', u), 'utf8').replace(/\r\n/g, '\n'));
    execFileSync('systemctl', ['daemon-reload']);
    execFileSync('systemctl', ['restart', 'hawkes-net']);
    if (await healthy()) {
      state.moved = { at: new Date().toISOString(), commit: as('git', '-C', NEW, 'rev-parse', '--short', 'HEAD') };
      delete state.moveFailedAt;
      save();
      say(`moved: hawkes-net runs from ${NEW} (${state.moved.commit})`);
      return true;
    }
    for (const u of UNITS) fs.copyFileSync(path.join(backup, u), `/etc/systemd/system/${u}`);
    execFileSync('systemctl', ['daemon-reload']);
    execFileSync('systemctl', ['restart', 'hawkes-net']);
    fail(`unhealthy from ${NEW}; back on ${DIR} (healthy again: ${await healthy()})`);
    return true;
  } catch (e) {
    try {
      if (fs.existsSync(path.join(backup, UNITS[0]))) {
        for (const u of UNITS) fs.copyFileSync(path.join(backup, u), `/etc/systemd/system/${u}`);
        execFileSync('systemctl', ['daemon-reload']);
        execFileSync('systemctl', ['restart', 'hawkes-net']);
      }
    } catch { /* the old units could not be put back: the next run tries the move again */ }
    fail(String(e.message).split('\n')[0]);
    return true;
  }
}
if (await moveToHawkesnet()) process.exit(0);

git('fetch', '--quiet', 'origin', 'main');
const head = git('rev-parse', 'HEAD');
const tip = git('rev-parse', 'origin/main');
if (head === tip || state.bad === tip) process.exit(0);
// Already in what's running (the box was set up from a branch ahead of main): nothing to do until main passes it.
try { git('merge-base', '--is-ancestor', tip, head); process.exit(0); } catch { /* main has something new */ }
const changed = git('diff', '--name-only', head, tip).split('\n').filter(Boolean);
const touchesNet = changed.some((f) => NET.test(f));
if (DRY) { say(`would ${touchesNet ? 'test and deploy' : 'fast-forward'} ${head.slice(0, 7)} -> ${tip.slice(0, 7)}`); process.exit(0); }
if (!touchesNet) { git('merge', '--ff-only', '--quiet', tip); say(`${tip.slice(0, 7)}: nothing for Hawkes Net, fast-forwarded`); process.exit(0); }

say(`${tip.slice(0, 7)}: Hawkes Net changed; testing here`);
const ok = testedHere(tip);
if (ok === null) process.exit(0);
if (!ok) { say(`${tip.slice(0, 7)}: tests failed, not deploying: ${state.tested?.detail ?? ''}`); state.bad = tip; save(); process.exit(0); }
git('merge', '--ff-only', '--quiet', tip);
execFileSync('systemctl', ['restart', 'hawkes-net']);
if (await healthy()) {
  say(`deployed ${head.slice(0, 7)} -> ${tip.slice(0, 7)}`);
  state.deployed = { sha: tip, at: new Date().toISOString() };
  save();
} else {
  say(`${tip.slice(0, 7)}: unhealthy after restart, going back to ${head.slice(0, 7)}`);
  git('reset', '--hard', '--quiet', head);
  execFileSync('systemctl', ['restart', 'hawkes-net']);
  state.bad = tip;
  save();
}
