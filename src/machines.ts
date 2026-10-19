// The machines Hawkes Gen runs (the dashboard's Machines tab, GET /v1/machines): the GPU fleet, the Windows build
// server and the playtester. EC2 Describe says what exists and its state; for each running machine one short SSH
// command reads CPU, memory, disk, network and (GPU boxes) nvidia-smi, plus the idle clock its own idle-stop script
// keeps. Nothing here starts a machine, and no CloudWatch: running machines are measured every minute (history, 7
// days in machine_samples) and more often while someone has the page open (live=1).

import { db } from './db.ts';
import { getJob, listJobs, queue } from './jobs.ts';
import * as fleet from './providers/comfy/fleet.ts';
import * as builder from './providers/builder/builder.ts';
import * as playtester from './providers/playtester/playtester.ts';
import { livePlaytester } from './tools/livePlay.ts';

export type Kind = 'gpu' | 'builder' | 'playtester';

/** One reading of a running machine. Bytes, percents, seconds; net is bytes/s over one second. */
export type Metrics = {
  at: number; uptime: number | null; cpu: number | null; memUsed: number | null; memTotal: number | null;
  gpu: number | null; vramUsed: number | null; vramTotal: number | null; temp: number | null;
  diskSize: number | null; diskUsed: number | null; diskFree: number | null; netIn: number | null; netOut: number | null;
  /** The machine's own idle clock: busy now, last activity (ms), and the idle minutes its script powers off after. */
  busy: boolean; lastActive: number | null; idleMinutes: number | null;
  /** GPU servers: install stage and whether ComfyUI answers; playtester: whether the browser server listens. */
  stage: string | null; service: 'up' | 'down' | null;
};

export type Machine = {
  id: string; kind: Kind; name: string; state: string; region: string | null; type: string | null; pricePerHour: number;
  launched: string | null; disposable: boolean; purpose: string | null;
  jobs: { id: string; tool: string; project: string; detail: string }[];
  /** Running only: minutes idle and when it stops (or, disposable, is terminated) by itself. */
  idle: { minutes: number; stopsAt: number | null; action: 'stops' | 'is terminated'; busy: boolean } | null;
  metrics: Metrics | null; error: string | null;
};

export type Alert = { level: 'bad' | 'warn'; machine: string; text: string };

const LIVE_MS = 15_000; // the page polls this often; a request within it reuses the last reading
const HISTORY_MS = 55_000; // at most one stored sample a minute per machine
const KEEP_MS = 7 * 86400_000;
const PROBE_MS = 30_000;

// ------------------------------------------------------------------ probes

/** Linux (GPU servers, playtester): one command, sections marked @name. Reads only; touches no idle clock. */
export const LINUX_PROBE = [
  'echo @now; date +%s',
  'echo @uptime; cat /proc/uptime',
  'echo @stat1; head -1 /proc/stat',
  'echo @net1; cat /proc/net/dev',
  'sleep 1',
  'echo @stat2; head -1 /proc/stat',
  'echo @net2; cat /proc/net/dev',
  "echo @mem; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  'echo @disk; df -B1 --output=size,used,avail / | tail -1',
  'echo @gpu; nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -1',
  'echo @last; stat -c %Y /var/lib/gen/last_busy /var/lib/dod/last_busy /var/log/nginx/gen-access.log /var/log/nginx/dod-access.log /var/lib/hawkes/last_busy 2>/dev/null',
  "echo @idlemin; sed -n 's/^IDLE_MINUTES=//p' /usr/local/bin/gen-idle.sh /usr/local/bin/dod-idle.sh 2>/dev/null; cat /var/lib/hawkes/idle-minutes 2>/dev/null",
  `echo @stage; sed -n 's/.*"stage":"\\([^"]*\\)".*/\\1/p' /var/lib/gen/status.json /var/lib/dod/status.json /var/lib/hawkes/status.json 2>/dev/null | head -1`,
  "echo @comfy; curl -s --max-time 3 http://127.0.0.1:8188/queue | head -c 200000 | tr -d '\\n'; echo",
  "echo @browser; ss -Htn state established '( sport = :3600 )' 2>/dev/null | wc -l; ss -Hltn '( sport = :3600 )' 2>/dev/null | wc -l",
  'true',
].join('; ');

/** Windows (build server), PowerShell over SSH: no double quotes (Windows quoting); answers one JSON line. */
export const WINDOWS_PROBE = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$n1 = @(Get-NetAdapterStatistics | Measure-Object ReceivedBytes,SentBytes -Sum)',
  '$c = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average',
  'Start-Sleep -Seconds 1',
  '$n2 = @(Get-NetAdapterStatistics | Measure-Object ReceivedBytes,SentBytes -Sum)',
  '$o = Get-CimInstance Win32_OperatingSystem',
  '$d = Get-PSDrive C',
  "$la = Get-Content 'C:\\hawkes\\last-activity' -Raw",
  "$im = Get-Content 'C:\\hawkes\\idle-minutes' -Raw",
  "$busy = (Test-Path 'C:\\hawkes\\busy') -or [bool](Get-Process Unity)",
  "@{ now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); boot = $o.LastBootUpTime.ToUniversalTime().ToString('o'); cpu = $c; memTotal = [double]$o.TotalVisibleMemorySize * 1024; memFree = [double]$o.FreePhysicalMemory * 1024; diskUsed = [double]$d.Used; diskFree = [double]$d.Free; rx = [double]$n2[0].Sum - [double]$n1[0].Sum; tx = [double]$n2[1].Sum - [double]$n1[1].Sum; last = $la; idleMinutes = $im; busy = $busy } | ConvertTo-Json -Compress",
].join('; ');

const num = (s: string | undefined) => {
  const n = Number(String(s ?? '').trim());
  return s != null && String(s).trim() !== '' && Number.isFinite(n) ? n : null;
};

function sections(text: string) {
  const out: Record<string, string[]> = {};
  let cur = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^@\w+$/.test(line)) { cur = line.slice(1); out[cur] = []; continue; }
    if (cur && line.trim()) out[cur].push(line);
  }
  return out;
}

const cpuTimes = (line?: string) => {
  const v = (line ?? '').trim().split(/\s+/).slice(1, 9).map(Number);
  if (v.length < 4 || v.some((x) => !Number.isFinite(x))) return null;
  return { total: v.reduce((a, b) => a + b, 0), idle: v[3] + (v[4] ?? 0) };
};

/** Received and sent bytes over every interface but loopback (/proc/net/dev). */
export function netTotals(lines: string[] = []) {
  let rx = 0;
  let tx = 0;
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    const name = l.slice(0, i).trim();
    if (!name || name === 'lo' || name.includes('|')) continue;
    const f = l.slice(i + 1).trim().split(/\s+/).map(Number);
    if (f.length >= 9) { rx += f[0] || 0; tx += f[8] || 0; }
  }
  return { rx, tx };
}

/** ComfyUI's /queue answer: jobs running or waiting, or null when it didn't answer. */
function comfyQueue(lines?: string[]) {
  try {
    const q = JSON.parse((lines ?? []).join(''));
    return (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0);
  } catch {
    return null;
  }
}

/** Reads LINUX_PROBE's answer (a GPU server's or the playtester's). */
export function parseLinux(text: string, kind: Kind = 'gpu', at = Date.now()): Metrics {
  const s = sections(text);
  const a = cpuTimes(s.stat1?.[0]);
  const b = cpuTimes(s.stat2?.[0]);
  const cpu = a && b && b.total > a.total ? Math.max(0, Math.min(100, 100 * (1 - (b.idle - a.idle) / (b.total - a.total)))) : null;
  const n1 = netTotals(s.net1);
  const n2 = netTotals(s.net2);
  const mem = Object.fromEntries((s.mem ?? []).map((l) => { const m = /^(\w+):\s+(\d+)/.exec(l); return m ? [m[1], Number(m[2]) * 1024] : ['', 0]; }));
  const [size, used, avail] = (s.disk?.[0] ?? '').trim().split(/\s+/).map((x) => num(x));
  const [g, vu, vt, t] = (s.gpu?.[0] ?? '').split(',').map((x) => num(x));
  const now = num(s.now?.[0]);
  const lasts = (s.last ?? []).map((x) => num(x)).filter((x): x is number => x != null && x > 0);
  const comfy = kind === 'gpu' ? comfyQueue(s.comfy) : null;
  const [conns, listening] = (s.browser ?? []).map((x) => num(x));
  const stage = s.stage?.[0]?.trim() || null;
  // Times on the machine's clock, moved onto ours.
  const skew = now != null ? at - now * 1000 : 0;
  return {
    at, uptime: num(s.uptime?.[0]?.split(/\s+/)[0]), cpu: cpu == null ? null : Math.round(cpu * 10) / 10,
    memTotal: mem.MemTotal ?? null, memUsed: mem.MemTotal != null && mem.MemAvailable != null ? mem.MemTotal - mem.MemAvailable : null,
    gpu: g ?? null, vramUsed: vu != null ? vu * 1048576 : null, vramTotal: vt != null ? vt * 1048576 : null, temp: t ?? null,
    diskSize: size ?? null, diskUsed: used ?? null, diskFree: avail ?? null,
    netIn: s.net1 && s.net2 ? Math.max(0, n2.rx - n1.rx) : null, netOut: s.net1 && s.net2 ? Math.max(0, n2.tx - n1.tx) : null,
    busy: kind === 'gpu' ? (comfy ?? 0) > 0 : (conns ?? 0) > 0,
    lastActive: lasts.length ? Math.max(...lasts) * 1000 + skew : null,
    idleMinutes: num(s.idlemin?.[0]),
    stage,
    service: stage !== 'ready' ? null : kind === 'gpu' ? (comfy == null ? 'down' : 'up') : listening == null ? null : listening > 0 ? 'up' : 'down',
  };
}

/** Reads WINDOWS_PROBE's answer (the build server keeps no GPU). */
export function parseWindows(text: string, at = Date.now()): Metrics {
  const j = JSON.parse(text.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}');
  const now = num(String(j.now ?? ''));
  const skew = now != null ? at - now * 1000 : 0;
  const boot = Date.parse(j.boot ?? '');
  const last = Date.parse(String(j.last ?? '').trim());
  const memTotal = num(String(j.memTotal ?? ''));
  const memFree = num(String(j.memFree ?? ''));
  const used = num(String(j.diskUsed ?? ''));
  const free = num(String(j.diskFree ?? ''));
  const lastActive = Math.max(Number.isFinite(boot) ? boot : 0, Number.isFinite(last) ? last : 0);
  return {
    at, uptime: Number.isFinite(boot) && now != null ? Math.max(0, now - boot / 1000) : null, cpu: num(String(j.cpu ?? '')),
    memTotal, memUsed: memTotal != null && memFree != null ? memTotal - memFree : null,
    gpu: null, vramUsed: null, vramTotal: null, temp: null,
    diskSize: used != null && free != null ? used + free : null, diskUsed: used, diskFree: free,
    netIn: num(String(j.rx ?? '')), netOut: num(String(j.tx ?? '')),
    busy: j.busy === true, lastActive: lastActive ? lastActive + skew : null, idleMinutes: num(String(j.idleMinutes ?? '')),
    stage: null, service: null,
  };
}

// --------------------------------------------------------------- the list

const latest = new Map<string, { metrics: Metrics | null; error: string | null; at: number }>();
let lastRound = 0;
let round: Promise<Machine[]> | null = null;
let lastPurge = 0;
const lastStored = new Map<string, number>();

// A playtest says which playtester it plays on (livePlay.ts), so each playtester lists its own.
const runningJobs = (tool: string) => listJobs({ status: 'running', tool, limit: 20 }).map((j) => ({ id: j.id, tool: j.tool, project: j.project, detail: j.detail, ...(tool === 'playtest.run' ? { machine: livePlaytester(j.id) } : {}) }));

type Found = { instance: any; region: string };
const base = (f: Found) => ({
  id: f.instance.InstanceId as string, state: (f.instance.State?.Name ?? 'unknown') as string, region: f.region, type: (f.instance.InstanceType ?? null) as string | null,
  launched: f.instance.LaunchTime ? new Date(f.instance.LaunchTime).toISOString() : null,
});
const tag = (i: any, key: string) => (i?.Tags ?? []).find((t: any) => t.Key === key)?.Value as string | undefined;

/** What exists (EC2 Describe only) with what each runs. No SSH. */
type Listed = Omit<Machine, 'idle' | 'metrics' | 'error'> & { found: Found | null; lookup?: string };
async function inventory(): Promise<Listed[]> {
  const out: Listed[] = [];
  const [gpus, b, p] = await Promise.all([
    fleet.listServers().catch(() => [] as Found[]),
    builder.findBuilder().catch((e) => e as Error),
    playtester.listPlaytesters({ fresh: true }).catch((e) => e as Error),
  ]);
  for (const f of gpus) {
    const m = base(f);
    const rec = fleet.serverRecord(m.id);
    const job = queue.busy.get(m.id);
    const j = job ? getJob(job) : null;
    out.push({
      ...m, kind: 'gpu', name: `GPU server ${m.id}`, pricePerHour: fleet.priceIn(m.type ?? '', f.region), found: f,
      disposable: tag(f.instance, 'Disposable') === 'yes' || rec.disposable === true, purpose: tag(f.instance, 'Purpose') ?? rec.purpose ?? null,
      jobs: j ? [{ id: j.id, tool: j.tool, project: j.project, detail: j.detail }] : [],
    });
  }
  const one = (f: Found | Error | null, kind: Kind, name: string, price: (t: string) => number, tool: string) => {
    if (f instanceof Error) return out.push({ id: kind, kind, name, state: 'unknown', region: null, type: null, launched: null, pricePerHour: 0, disposable: false, purpose: null, jobs: [], found: null, lookup: `AWS didn't answer: ${f.message}` });
    if (!f) return out.push({ id: kind, kind, name, state: 'none', region: null, type: null, launched: null, pricePerHour: 0, disposable: false, purpose: null, jobs: [], found: null });
    const m = base(f);
    out.push({ ...m, kind, name, pricePerHour: price(m.type ?? ''), disposable: false, purpose: null, jobs: m.state === 'running' ? runningJobs(tool) : [], found: f });
  };
  one(b, 'builder', 'Build server', (t) => builder.BUILDER_TYPES[t]?.price ?? builder.BUILDER_TYPES[builder.BUILDER_DEFAULT_TYPE].price, 'unity.build');
  // Every playtester (there can be several); none at all shows as one missing machine, as before.
  const ptPrice = (t: string) => playtester.PLAYTESTER_TYPES[t]?.price ?? playtester.PLAYTESTER_TYPES[playtester.PLAYTESTER_DEFAULT_TYPE].price;
  if (p instanceof Error || !p.length) one(p instanceof Error ? p : null, 'playtester', 'Playtester', ptPrice, 'playtest.run');
  else for (const [n, f] of p.entries()) {
    const before = out.length;
    one(f, 'playtester', p.length > 1 ? `Playtester ${n + 1} (${f.region})` : 'Playtester', ptPrice, 'playtest.run');
    // Jobs per machine: the playtests whose browser is on this one.
    if (p.length > 1 && out[before]) out[before].jobs = out[before].jobs.filter((j: any) => !j.machine || j.machine === f.instance.InstanceId);
  }
  return out;
}

async function probe(m: { id: string; kind: Kind; found: Found | null }): Promise<Metrics> {
  const at = Date.now();
  if (m.kind === 'builder') return parseWindows(await builder.ssh(WINDOWS_PROBE, { timeoutMs: PROBE_MS, found: m.found }), at);
  if (m.kind === 'playtester') return parseLinux(await playtester.ssh(LINUX_PROBE, { timeoutMs: PROBE_MS, found: m.found }), 'playtester', at);
  return parseLinux(await fleet.sshRun(LINUX_PROBE, m.id, { timeoutMs: PROBE_MS }), 'gpu', at);
}

/** Minutes idle and when the machine's own script powers it off (it checks every 1-5 minutes). */
export function idleOf(m: Metrics | null, disposable: boolean, hasJob = false, now = Date.now()): Machine['idle'] {
  if (!m || m.lastActive == null) return null;
  const busy = m.busy || hasJob;
  const since = busy ? now : m.lastActive;
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  return { minutes, busy, action: disposable ? 'is terminated' : 'stops', stopsAt: m.idleMinutes ? since + m.idleMinutes * 60_000 : null };
}

function store(id: string, kind: Kind, m: Metrics) {
  if ((lastStored.get(id) ?? 0) > m.at - HISTORY_MS) return;
  lastStored.set(id, m.at);
  db.prepare(`INSERT INTO machine_samples (id, kind, at, cpu, mem_used, mem_total, gpu, vram_used, vram_total, temp, disk_size, disk_used, net_in, net_out)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, kind, m.at, m.cpu, m.memUsed, m.memTotal, m.gpu, m.vramUsed, m.vramTotal, m.temp, m.diskSize, m.diskUsed, m.netIn, m.netOut);
  if (m.at - lastPurge > 3600_000) {
    lastPurge = m.at;
    db.prepare('DELETE FROM machine_samples WHERE at < ?').run(m.at - KEEP_MS);
  }
}

/** Every machine; measures the running ones when the last reading is older than maxAge (in one round, shared). */
async function collect(maxAge: number): Promise<Machine[]> {
  if (round) return round;
  const fresh = Date.now() - lastRound < maxAge;
  round = (async () => {
    const list = await inventory();
    await Promise.all(list.filter((m) => m.state === 'running' && !fresh).map(async (m) => {
      try {
        const metrics = await probe(m);
        latest.set(m.id, { metrics, error: null, at: metrics.at });
        store(m.id, m.kind, metrics);
      } catch (e: any) {
        latest.set(m.id, { metrics: null, error: String(e?.message ?? e).slice(0, 300), at: Date.now() });
      }
    }));
    if (!fresh) lastRound = Date.now();
    return list.map(({ found, lookup, ...m }) => {
      const r = m.state === 'running' ? latest.get(m.id) : undefined;
      return { ...m, metrics: r?.metrics ?? null, error: lookup ?? r?.error ?? null, idle: m.state === 'running' ? idleOf(r?.metrics ?? null, m.disposable, m.jobs.length > 0) : null };
    });
  })().finally(() => { round = null; });
  return round;
}

/** What needs action, worst first: unreachable or down, disks filling, idle machines costing money, heat, memory. */
export function alertsFor(list: Machine[], now = Date.now()): Alert[] {
  const out: Alert[] = [];
  const pct = (a: number | null, b: number | null) => (a != null && b ? (100 * a) / b : null);
  const gb = (b: number | null) => (b == null ? '?' : `${Math.round(b / 1e9)} GB`);
  for (const m of list) {
    if (m.state !== 'running') continue;
    const x = m.metrics;
    const up = x?.uptime ?? (m.launched ? (now - Date.parse(m.launched)) / 1000 : 0);
    // A machine that just started has no SSH yet (Windows takes minutes): only past 10 minutes is silence a problem.
    if (!x && m.error) { if (up > 10 * 60) out.push({ level: 'bad', machine: m.id, text: `${m.name} not answering: ${m.error}` }); continue; }
    if (!x) continue;
    if (x.service === 'down' && up > 15 * 60) out.push({ level: 'bad', machine: m.id, text: m.kind === 'playtester' ? `${m.name} down: its browser server isn't listening` : `${m.name}: ComfyUI isn't answering` });
    const disk = pct(x.diskUsed, x.diskSize);
    if (disk != null && disk >= 90) out.push({ level: disk >= 95 ? 'bad' : 'warn', machine: m.id, text: `${m.name} disk ${Math.round(disk)}% (${gb(x.diskFree)} free)` });
    if (m.idle && !m.idle.busy && m.idle.minutes >= 30) {
      const left = m.idle.stopsAt ? Math.round((m.idle.stopsAt - now) / 60_000) : null;
      out.push({ level: 'warn', machine: m.id, text: `${m.name} idle ${m.idle.minutes} min, $${m.pricePerHour.toFixed(2)}/hr${left != null ? (left > 0 ? ` (${m.idle.action === 'stops' ? 'stops' : 'terminated'} in about ${left} min)` : ` (past its ${x.idleMinutes} min idle stop)`) : ''}` });
    }
    if (x.temp != null && x.temp >= 85) out.push({ level: 'warn', machine: m.id, text: `${m.name} GPU at ${x.temp}°C` });
    const mem = pct(x.memUsed, x.memTotal);
    if (mem != null && mem >= 95) out.push({ level: 'warn', machine: m.id, text: `${m.name} memory ${Math.round(mem)}% used` });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}

/** GET /v1/machines: live re-measures if the last reading is over 15 s old, else the last minute's reading. */
export async function machines({ live = false } = {}) {
  const list = await collect(live ? LIVE_MS : Infinity);
  return { at: Date.now(), alerts: alertsFor(list), machines: list };
}

/** The last reading's disk use for each running GPU server (the fleet tab's warning). No new SSH. */
export function lastDisks() {
  const out: Record<string, { pct: number; free: number | null }> = {};
  for (const [id, r] of latest) if (r.metrics?.diskSize && r.metrics.diskUsed != null) out[id] = { pct: Math.round((100 * r.metrics.diskUsed) / r.metrics.diskSize), free: r.metrics.diskFree };
  return out;
}

// ---------------------------------------------------------------- history

db.exec(`CREATE TABLE IF NOT EXISTS machine_samples (
  id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
  cpu REAL, mem_used REAL, mem_total REAL, gpu REAL, vram_used REAL, vram_total REAL, temp REAL,
  disk_size REAL, disk_used REAL, net_in REAL, net_out REAL
);
CREATE INDEX IF NOT EXISTS machine_samples_at ON machine_samples (id, at);`);

export type Point = { at: number; cpu: number | null; mem: number | null; gpu: number | null; vram: number | null; temp: number | null; disk: number | null; netIn: number | null; netOut: number | null };

/** The last `hours` (up to 7 days) per machine, averaged into at most `points` buckets. */
export function history({ id, hours = 1, points = 120, now = Date.now() }: { id?: string; hours?: number; points?: number; now?: number } = {}) {
  const h = Math.max(0.1, Math.min(168, Number(hours) || 1));
  const n = Math.max(10, Math.min(500, Math.round(Number(points) || 120)));
  const bucket = Math.max(60_000, Math.ceil((h * 3600_000) / n));
  const rows = db.prepare(`SELECT id, (at / ${bucket}) * ${bucket} AS t, avg(cpu) AS cpu, avg(100.0 * mem_used / mem_total) AS mem, avg(gpu) AS gpu,
      avg(100.0 * vram_used / vram_total) AS vram, avg(temp) AS temp, avg(100.0 * disk_used / disk_size) AS disk, avg(net_in) AS net_in, avg(net_out) AS net_out
    FROM machine_samples WHERE at >= ? ${id ? 'AND id = ?' : ''} GROUP BY id, t ORDER BY id, t`).all(...(id ? [now - h * 3600_000, id] : [now - h * 3600_000])) as any[];
  const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  const out: Record<string, Point[]> = {};
  for (const r of rows) (out[r.id] ??= []).push({ at: r.t + bucket / 2, cpu: r1(r.cpu), mem: r1(r.mem), gpu: r1(r.gpu), vram: r1(r.vram), temp: r1(r.temp), disk: r1(r.disk), netIn: r1(r.net_in), netOut: r1(r.net_out) });
  return { hours: h, bucketSeconds: bucket / 1000, machines: out };
}

/** For tests: a sample as if measured. */
export function recordSample(id: string, kind: Kind, m: Metrics) {
  lastStored.delete(id);
  store(id, kind, m);
}

// ------------------------------------------------------------- background

let timer: NodeJS.Timeout | null = null;

/** Every 60 s, measures the machines that are running (history and the fleet tab's disk warning). Needs AWS. */
export function startMonitor() {
  if (timer || process.env.HAWKESGEN_MACHINES === 'off') return;
  try { fleet.awsConfig(); } catch { return; }
  const tick = () => void collect(50_000).catch((e) => console.warn(`[machines] ${e.message}`));
  timer = setInterval(tick, 60_000);
  timer.unref();
  setTimeout(tick, 20_000).unref();
}
