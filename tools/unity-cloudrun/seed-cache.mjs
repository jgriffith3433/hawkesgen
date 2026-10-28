#!/usr/bin/env node
// Uploads a Unity project's Library from this PC as the first cloud cache for it, so the first cloud build isn't a
// full import.
//
//   node tools/unity-cloudrun/seed-cache.mjs --folder C:\Projects\breakingthrough [--repo breakingthrough] [--key beta]
//        --project <gcp-project> --bucket <bucket> [--force] [--apply]
//
// It writes gs://<bucket>/unity-cache/<repo>/<key>.tar.zst (zstd, made here by Node's zlib) and <key>.json, the same
// pair a successful cloud build writes. Left out, as a cloud build leaves them out: BuildCache, Search, TempArtifacts,
// Logs; and from a Windows Library also Bee (the Windows toolchain's build graph, useless on Linux) and
// ScriptAssemblies (recompiled anyway). Unity may still reimport assets whose importer differs by editor platform;
// the first cloud build's log says how much. Close the project in Unity first (a Library being written isn't a cache).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { APPLY, config, flag, die, done } from './common.mjs';
import { gcloudBin } from '../gcloud-bin.mjs';
const [GCLOUD, GPRE] = gcloudBin();

const c = config();
if (!c.bucket) die('Which bucket? Pass --bucket <name>, or set settings.unityBuild.gcp.bucket.');
const folder = path.resolve(flag('folder') ?? die('Which project? Pass --folder C:\\Projects\\<project>.'));
const lib = path.join(folder, 'Library');
if (!fs.existsSync(lib)) die(`${folder} has no Library.`);
const repo = (flag('repo') ?? path.relative(path.resolve('C:\\Projects'), folder)).replace(/[\\/]+/g, '--').replace(/[^A-Za-z0-9._-]/g, '_');
const key = (flag('key', 'beta')).replace(/[^A-Za-z0-9._-]/g, '_');
const versionFile = path.join(folder, 'ProjectSettings', 'ProjectVersion.txt');
const unity = fs.existsSync(versionFile) ? /m_EditorVersion:\s*(\S+)/.exec(fs.readFileSync(versionFile, 'utf8'))?.[1] : null;
if (unity && unity !== c.unity) die(`${folder} is Unity ${unity}; the cloud image is ${c.unity}. A cache from another version would be thrown away.`);
if (fs.existsSync(path.join(folder, 'Temp', 'UnityLockfile')) && !process.argv.includes('--force')) {
  die('Unity seems to have this project open (Temp/UnityLockfile). Close it first, or pass --force if it is a stale lock.');
}

const EXCLUDE = ['BuildCache', 'Search', 'TempArtifacts', 'Logs', 'Bee', 'ScriptAssemblies', 'il2cpp_android_arm64-v8a', 'il2cpp_android_armeabi-v7a'];
let bytes = 0;
let files = 0;
const skipped = {};
for (const e of fs.readdirSync(lib, { withFileTypes: true })) {
  const full = path.join(lib, e.name);
  let size = 0;
  let n = 0;
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const x of fs.readdirSync(p)) walk(path.join(p, x));
    else { size += st.size; n++; }
  };
  walk(full);
  if (EXCLUDE.includes(e.name)) skipped[e.name] = size;
  else { bytes += size; files += n; }
}
const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;
const object = `gs://${c.bucket}/unity-cache/${repo}/${key}.tar.zst`;
console.log(`Library of ${folder}: ${gb(bytes)} in ${files} files go to ${object}`);
for (const [k, v] of Object.entries(skipped)) console.log(`  left out: Library/${k} (${gb(v)})`);
if (bytes > 16 * 1024 ** 3) console.log(`  Warning: over 16 GB unpacked; a Cloud Run build (32 GiB in memory, shared with the source, the build and Unity) skips caches over HAWKES_CACHE_MAX_GB (16). Use the VM fallback for this project (docs/unity-cloudrun.md).`);
if (!APPLY) {
  done();
  process.exit(0);
}

const commit = spawnSync('git', ['-C', folder, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? '';
const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const excludeArgs = EXCLUDE.flatMap((e) => ['--exclude', `Library/${e}`]);
const tar = spawn(tarExe, ['-cf', '-', ...excludeArgs, 'Library'], { cwd: folder, stdio: ['ignore', 'pipe', 'inherit'] });
const up = spawn(GCLOUD, [...GPRE, 'storage', 'cp', '-', object, `--project=${c.project}`], { stdio: ['pipe', 'inherit', 'inherit'] });
let packed = 0;
const zstd = zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
zstd.on('data', (d) => (packed += d.length));
const t0 = Date.now();
const timer = setInterval(() => console.log(`  ${gb(packed)} packed and sent, ${Math.round((Date.now() - t0) / 1000)} s`), 30_000);
const exited = (p, what) => new Promise((ok, bad) => p.on('close', (code) => (code === 0 ? ok() : bad(new Error(`${what} exited ${code}`)))));
try {
  await Promise.all([pipeline(tar.stdout, zstd, up.stdin), exited(tar, 'tar'), exited(up, 'gcloud storage cp')]);
} catch (e) {
  clearInterval(timer);
  die(`The upload failed: ${e.message}. Nothing usable was left (a cloud build only restores a cache whose .json exists).`);
}
clearInterval(timer);
const meta = { savedAt: new Date().toISOString(), libraryBytes: bytes, files, unity: unity ?? c.unity, commit, job: 'seed', seededFrom: `${os.hostname()} (${process.platform})`, compressedBytes: packed };
const metaFile = path.join(os.tmpdir(), `${repo}-${key}.json`);
fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
const r = spawnSync(GCLOUD, [...GPRE, 'storage', 'cp', metaFile, `gs://${c.bucket}/unity-cache/${repo}/${key}.json`, `--project=${c.project}`], { stdio: 'inherit' });
if (r.status !== 0) die('Uploading the cache\'s .json failed; the cache is there but a build will only use it once the .json is.');
console.log(`Seeded ${repo}/${key}: ${gb(bytes)} -> ${gb(packed)} packed in ${Math.round((Date.now() - t0) / 1000)} s.`);
done();
