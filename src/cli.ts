// hawkesgen: the command line, for J and for agents. Talks to the running
// service (start it with auto-start.bat or npm start).
//
//   hawkesgen status
//   hawkesgen tools [id]
//   hawkesgen run <tool|-> --project P [--preset name] [--param k=v ...] [--input name=path ...] [--label k=v] [--out dir] [--no-wait]
//                                     ("-" for the tool: the preset's)
//   hawkesgen jobs [--project P] [--status running]    hawkesgen job <id>    hawkesgen cancel <id>
//   hawkesgen library [--project P] [--kind image] [--q melee] [--tool motion.library]     hawkesgen get <asset id> <file>
//   hawkesgen fleet [status|start [id]|stop [id]|stop-all|launch|sync [id]|access|adopt <dir>|set k=v] [--yes]
//   hawkesgen fleet image [status|build [--from <id> [--as-is]] [region=r]|prune [--dry-run]|cancel] [--yes]
//   hawkesgen playtester [status|launch [type=..] [region=..]|start|ensure|stop|terminate|access|idle <min>|ssh "<bash>"] [id=i-...] [--yes]
//   hawkesgen builder [status|launch|start|stop|terminate|access|rdp|github [owner/repo ...]|idle <min>|ssh "<powershell>"] [--yes]
//   hawkesgen storage [status|backfill|restore]      the library's files in S3
//   hawkesgen lod [status|backfill [--project P] [--kind image|mesh] [--limit N] [--dry-run]]   levels of detail (src/lod.ts)
//   hawkesgen usage [--days 30] [--by project]
//   hawkesgen key <name> [--role user|admin|owner] [--projects a,b]
//
// Params are parsed as JSON when they look like it (numbers, true/false,
// objects), else kept as text. --param prompt=@file.txt reads a file.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
// @ts-ignore: plain JS client
import { HawkesGen } from '../clients/js/hawkesgen.mjs';

const argv = process.argv.slice(2);
const flags: Record<string, string[]> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split(/=(.*)/s);
    const BOOL = new Set(['no-wait', 'yes', 'json', 'dry-run']);
    const val = v ?? (!BOOL.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    (flags[k] ??= []).push(val);
  } else pos.push(a);
}
const flag = (k: string) => flags[k]?.at(-1);
const gen = new HawkesGen({ project: flag('project') });

const kv = (list: string[] = []) => Object.fromEntries(list.map((s) => {
  const [k, v = ''] = s.split(/=(.*)/s);
  if (v.startsWith('@')) return [k, fs.readFileSync(v.slice(1), 'utf8')];
  try {
    return [k, /^[\[{"\d-]|^(true|false|null)$/.test(v) ? JSON.parse(v) : v];
  } catch {
    return [k, v];
  }
}));

const money = (n: number) => `$${(n ?? 0).toFixed(n && n < 0.01 ? 4 : 2)}`;

async function confirm(q: string) {
  if (flag('yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${q} [y/N] `);
  rl.close();
  return /^y/i.test(a.trim());
}

function printJob(j: any) {
  console.log(`${j.id}  ${j.status.toUpperCase()}  ${j.tool}  [${j.project}]  ${j.detail}`);
  for (const o of j.outputs ?? []) console.log(`  ${o.kind}  ${o.asset}${o.seed ? `  seed ${o.seed}` : ''}${o.title ? `  ${o.title}` : ''}`);
  if (j.result) console.log(JSON.stringify(j.result, null, 2));
  if (j.error) console.log(`  error: ${j.error}`);
  if (j.cost) console.log(`  cost ${money(j.cost)}${j.gpu_seconds ? `, ${Math.round(j.gpu_seconds)}s GPU` : ''}`);
}

async function main() {
  const [cmd = 'status', ...rest] = pos;
  switch (cmd) {
    case 'status': {
      const h = await gen.health();
      console.log(`Hawkes Gen ${h.version} at ${gen.url}`);
      console.log(`providers: ${Object.entries(h.providers).map(([k, v]) => `${k} ${v ? 'ok' : 'NOT SET UP'}`).join(', ')}`);
      console.log(`queue: ${h.queue.running ?? 0} running, ${h.queue.queued ?? 0} waiting`);
      try {
        const f = await gen.fleet();
        for (const s of f.servers) console.log(`  ${s.id}  ${s.state}${s.state === 'running' ? `/${s.stuck ? `STUCK ${s.stuck.minutes} min` : s.boot?.stage}` : s.unfinished ? ' (install unfinished)' : ''}  ${s.type}  ${s.zone ?? s.region}  ${money(s.pricePerHour)}/hr${f.busy[s.id] ? `  busy: ${f.busy[s.id]}` : ''}`);
        if (!f.servers.length) console.log('  no GPU servers');
        if (f.error) console.log(`  fleet: ${f.error}`);
      } catch (e: any) {
        console.log(`fleet: ${e.message}`);
      }
      return;
    }
    case 'tools': {
      if (rest[0]) return console.log(JSON.stringify(await gen.tool(rest[0]), null, 2));
      for (const t of await gen.tools()) console.log(`${t.id.padEnd(16)} ${t.provider.padEnd(11)} ${t.title}`);
      return;
    }
    case 'run': {
      const tool = rest[0];
      if (!tool) throw new Error('hawkesgen run <tool> --project P --param k=v --input name=path');
      const inputs: Record<string, any> = {};
      for (const s of flags.input ?? []) {
        const [k, v] = s.split(/=(.*)/s);
        const val = /^(asset|blob|motion):/.test(v) ? v : path.resolve(v);
        inputs[k] = inputs[k] ? [...[inputs[k]].flat(), val] : val;
      }
      const job = await gen.submit(tool === '-' ? null : tool, { params: kv(flags.param), inputs, labels: kv(flags.label), key: flag('key'), preset: flag('preset') });
      console.log(`queued ${job.id}`);
      if (flag('no-wait')) return;
      const done = await gen.wait(job.id, { onUpdate: (j: any) => console.log(`  ${j.status}: ${j.detail}`), throwOnFail: false });
      printJob(done);
      const out = flag('out');
      if (out && done.outputs?.length) {
        for (const o of done.outputs) {
          const a = await gen.asset(o.asset);
          const dest = path.join(out, `${tool}-${o.seed ?? o.asset}${o.title ? `-${o.title}` : ''}${path.extname(a.path)}`);
          await gen.download(o.asset, dest);
          console.log(`  saved ${dest}`);
        }
      }
      if (done.status !== 'done') process.exitCode = 1;
      return;
    }
    case 'jobs': {
      for (const j of await gen.jobs({ ...(flag('project') ? { project: flag('project') } : {}), ...(flag('status') ? { status: flag('status') } : {}), limit: flag('limit') ?? '30' })) {
        console.log(`${j.id}  ${j.status.padEnd(9)} ${j.tool.padEnd(15)} ${j.project.padEnd(18)} ${j.detail}`);
      }
      return;
    }
    case 'job':
      return printJob(await gen.job(rest[0]));
    case 'cancel':
      return printJob(await gen.cancel(rest[0]));
    case 'library': {
      const r = await gen.assets({ ...(flag('project') ? { project: flag('project') } : {}), ...(flag('kind') ? { kind: flag('kind') } : {}), ...(flag('tool') ? { tool: flag('tool') } : {}), ...(flag('q') ? { q: flag('q') } : {}), limit: flag('limit') ?? '30' });
      for (const a of r.items) console.log(`${a.id}  ${a.kind.padEnd(5)} ${a.project.padEnd(18)} ${a.tool.padEnd(15)} ${a.title ?? Object.values(a.labels ?? {}).join(' ')}`);
      console.log(`${r.items.length} of ${r.total}`);
      return;
    }
    case 'get':
      return console.log(await gen.download(rest[0], rest[1]));
    case 'builder': {
      const action = rest[0] ?? 'status';
      if (action === 'status') {
        const b = await gen.request('/builder');
        if (!b.exists) return console.log(`No build server yet. "hawkesgen builder launch" makes one (${b.types?.['m7i.2xlarge'] ? 'm7i.2xlarge, about $0.77/hr while running' : ''}, plus ~$${Math.round(b.diskPerMonth)}/month for its ${b.diskGb} GB disk).`);
        console.log(`${b.id}  ${b.state}  ${b.type}  ${b.region}  ${b.ip ?? ''}  $${b.pricePerHour}/hr`);
        if (b.stage) console.log(`  ${b.stage.stage}: ${b.stage.detail ?? ''}`);
        if (b.rdpFile) console.log(`  Remote Desktop: ${b.rdpFile} (password in ${b.passwordFile})`);
        return;
      }
      const costly = ['launch', 'start', 'terminate', 'ssh'].includes(action);
      if (costly && !(await confirm(action === 'launch' ? 'Launch the Unity build server? It costs about $0.77/hr while running (it stops itself when idle) plus ~$24/month for its disk.' : action === 'terminate' ? 'Delete the build server and its disk (every project Library)?' : `${action} the build server?`))) return;
      const body: any = { confirm: true };
      if (action === 'idle') body.minutes = Number(rest[1]);
      if (action === 'ssh') body.command = rest.slice(1).join(' ');
      if (action === 'github' && rest.length > 1) body.repos = rest.slice(1);
      if (action === 'launch') Object.assign(body, kv(rest.slice(1)));
      const r = await gen.request(`/builder/${action}`, { method: 'POST', body });
      if (action === 'ssh') return console.log(r.output);
      return console.log(JSON.stringify(r, null, 2));
    }
    case 'playtester': {
      const action = rest[0] ?? 'status';
      if (action === 'status') {
        const b = await gen.request('/playtester');
        if (!b.exists) return console.log(`No playtester yet. "hawkesgen playtester launch" makes one (g4dn.xlarge with a T4 GPU, about $${b.pricePerHour}/hr while running, plus ~$${Math.round(b.diskPerMonth)}/month for its ${b.diskGb} GB disk).`);
        for (const m of b.machines ?? [b]) {
          console.log(`${m.id}  ${m.state}  ${m.type}  ${m.region}  ${m.ip ?? ''}  $${m.pricePerHour}/hr  lanes ${m.inUse ?? 0}/${m.lanes ?? '?'}`);
          if (m.stage) console.log(`  ${m.stage.stage}: ${m.stage.detail ?? ''}`);
        }
        if (b.machines) console.log(`${b.machines.length} of at most ${b.max} playtesters; ${b.inUse}/${b.lanes} browser tabs in use`);
        return;
      }
      const costly = ['launch', 'start', 'ensure', 'terminate', 'ssh'].includes(action);
      if (costly && !(await confirm(action === 'launch' ? 'Launch the playtester (T4 GPU)? About $0.53/hr while running (it stops itself when idle) plus ~$6/month for its disk.' : action === 'terminate' ? 'Delete the playtester and its disk?' : `${action} the playtester?`))) return;
      const body: any = { confirm: true };
      if (action === 'idle') body.minutes = Number(rest[1]);
      if (action === 'ssh') body.command = rest.slice(1).join(' ');
      const args = kv(rest.slice(1).filter((a: string) => a.includes('=')));
      if (args.id) body.id = args.id;
      if (action === 'launch') Object.assign(body, args);
      const r = await gen.request(`/playtester/${action}`, { method: 'POST', body });
      if (action === 'ssh') return console.log(r.output);
      return console.log(JSON.stringify(r, null, 2));
    }
    case 'fleet': {
      const [action = 'status', arg] = rest;
      if (action === 'image') {
        const sub = arg ?? 'status';
        if (sub === 'status') {
          const s = await gen.request('/fleet/image');
          console.log(JSON.stringify({
            key: s.key, comfy: s.comfy, ready: s.ready, stale: s.stale, disposable: s.disposable, costPerMonth: s.costPerMonth,
            regions: s.regions.map((r: any) => ({ region: r.region, current: r.current ? `${r.current.id} (${r.current.created.slice(0, 10)}, ${r.current.usedGb ?? '?'} GB)` : null, others: r.others.map((o: any) => `${o.id} ${o.state} key ${o.key}`), error: r.error ?? undefined })),
            build: s.build ? { id: s.build.id, phase: s.build.phase, active: s.build.active, from: s.build.from, image: s.build.image, error: s.build.error, last: s.build.log.slice(-5).map((l: any) => `${l.at.slice(11, 19)} ${l.msg}`) } : null,
          }, null, 2));
          return;
        }
        if (sub === 'cancel') return console.log(JSON.stringify(await gen.request('/fleet/image/cancel', { method: 'POST', body: {} }), null, 2));
        if (sub === 'prune') {
          const dry = await gen.request('/fleet/image/prune', { method: 'POST', body: { dryRun: true } });
          if (!dry.removed.length) return console.log('Nothing to prune: every image left is the one its region launches from.');
          console.log(dry.removed.map((i: any) => `  ${i.region} ${i.id} ${i.name} (${i.snapshots.length} snapshot${i.snapshots.length === 1 ? '' : 's'})`).join('\n'));
          if (rest.includes('--dry-run')) return;
          if (!(await confirm(`Delete these ${dry.removed.length} image(s) and their snapshots?`))) return console.log('cancelled');
          return console.log(JSON.stringify(await gen.request('/fleet/image/prune', { method: 'POST', body: { confirm: true } }), null, 2));
        }
        if (sub === 'build') {
          const i = rest.indexOf('--from');
          const from = i >= 0 ? rest[i + 1] : undefined;
          const asIs = rest.includes('--as-is');
          const ask = from && asIs
            ? `Image ${from} as it is, without starting it (it is stopped first if running; no cleanup: servers launched from it clean up at first boot), then copy it to every fleet region (~$8-9/month per region for the snapshot, ~$3-4 once per copy)? ${from} stays a normal server.`
            : from
            ? `Image ${from}? It is started if stopped (a few minutes at ~$1.86/hr), cleaned (non-core models removed, its password and keys stripped: it can't take jobs afterwards), stopped and imaged, then copied to every fleet region (~$8-9/month per region for the snapshot, ~$3-4 once per copy).`
            : 'Build a new image from a fresh install? A new GPU server installs itself (30-45 min at ~$1.86/hr), is cleaned, stopped and imaged, copied to every fleet region (~$8-9/month per region), then terminated; older images are deleted.';
          if (!(await confirm(ask))) return console.log('cancelled');
          return console.log(JSON.stringify(await gen.request('/fleet/image/build', { method: 'POST', body: { confirm: true, from, asIs, ...kv(rest.slice(2).filter((x, k, a) => x !== '--from' && x !== '--as-is' && a[k - 1] !== '--from')) } }), null, 2));
        }
        throw new Error('fleet image status|build [--from <id>]|prune [--dry-run]|cancel');
      }
      if (action === 'status') {
        const f = await gen.fleet();
        console.log(JSON.stringify({ settings: f.settings, servers: f.servers.map((s: any) => ({ id: s.id, state: s.state, boot: s.boot?.stage, type: s.type, zone: s.zone, flavor: s.flavor, pricePerHour: s.pricePerHour, loaded: f.families[s.id], busy: f.busy[s.id] })), retry: f.retry?.active ? f.retry : undefined, lastFailure: f.lastFailure }, null, 2));
        return;
      }
      if (action === 'set') {
        return console.log(await gen.fleetSettings(kv(rest.slice(1))));
      }
      const costly: Record<string, string> = {
        start: 'Start a GPU server? It costs about $1.86-$4 an hour while it runs.',
        launch: 'Launch a NEW GPU server? From the fleet image it is ready in minutes and is terminated when idle; without one it installs itself (30-45 min) and keeps a disk (~$20/month) until terminated. About $1.86/hr while it runs.',
        sync: 'Download missing models and nodes onto the server? Can take a while (server time costs money).',
        adopt: 'Copy that folder\'s server tokens and SSH keys into Hawkes Gen?',
        terminate: 'TERMINATE the server and delete its disk (models included)?',
      };
      if (costly[action] && !(await confirm(costly[action]))) return console.log('cancelled');
      const body: any = { confirm: true };
      if (action === 'adopt') body.from = path.resolve(arg ?? '');
      else if (arg) body.id = arg;
      if (action === 'launch') Object.assign(body, kv(rest.slice(1)));
      console.log(JSON.stringify(await gen.fleetAction(action, body), null, 2));
      return;
    }
    case 'storage': {
      const sub = rest[0] ?? 'status';
      const r = sub === 'status' ? await gen.request('/storage') : await gen.request(`/storage/${sub}`, { method: 'POST', body: {} });
      const gb = (b: number) => `${(b / 1073741824).toFixed(2)} GB`;
      if (sub === 'restore') return console.log(`checked ${r.checked}, restored ${r.restored}, missing ${r.missing}`);
      console.log(`bucket: ${r.bucket ?? 'none (settings.storage.bucket)'}`);
      console.log(`${r.backedUp} of ${r.files} files backed up (${gb(r.backedUpBytes)} of ${gb(r.bytes)}), ${r.queued} uploading${r.failures ? `, ${r.failures} failed (${r.lastError})` : ''}`);
      if (sub === 'backfill') console.log(`queued ${r.added} more`);
      return;
    }
    case 'lod': {
      // The LOD system: every image's and model's smaller copies (src/lod.ts). backfill queues what has none yet; prune
      // clears levels made for in-between work (here and in S3).
      const sub = rest[0] ?? 'status';
      const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
      const body = { project: flag('project'), kind: flag('kind'), limit: Number(flag('limit')) || undefined, dryRun: flag('dry-run') === 'true' };
      const r = sub === 'backfill' ? await gen.request('/lods/backfill', { method: 'POST', body })
        : sub === 'prune' ? await gen.request('/lods/prune', { method: 'POST', body })
        : await gen.request('/lods/status');
      if (sub === 'backfill') console.log(flag('dry-run') ? `would queue ${r.found} assets (${r.skipped ?? 0} in-between skipped; ${r.linked} jobs with low copies to link)` : `queued ${r.queued} of ${r.found} found (${r.skipped ?? 0} in-between skipped); linked ${r.linked} low copies`);
      if (sub === 'prune') console.log(`${flag('dry-run') ? 'would clear' : 'cleared'} ${r.levels} levels of ${r.assets} in-between assets (${mb(r.bytes)})${flag('dry-run') ? '' : `; ${r.s3} copies deleted from S3`}`);
      console.log(`LOD v${r.version}: ${Object.entries(r.assets).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing yet'}; ${r.levels} levels (${mb(r.bytes)}), ${r.links} linked lows`);
      console.log(`asset.lod jobs: ${Object.entries(r.jobs).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`);
      return;
    }
    case 'usage': {
      const days = Number(flag('days') ?? 30);
      const u = await gen.usage({ since: String(Date.now() - days * 86400000), by: flag('by') ?? 'project' });
      for (const r of u.rows) console.log(`${String(r.grp).padEnd(20)} ${r.provider.padEnd(11)} ${Math.round(r.amount).toLocaleString().padStart(10)} ${r.unit.padEnd(12)} ${money(r.cost).padStart(9)}`);
      console.log(`total ${money(u.total)} in ${days} days`);
      return;
    }
    case 'key': {
      const r = await gen.request('/clients', { method: 'POST', body: { name: rest[0], role: flag('role') ?? 'user', projects: (flag('projects') ?? '*').split(',') } });
      console.log(`key for ${r.client.name} (${r.client.role}): ${r.key}\nCopy it now; it isn't shown again.`);
      return;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
