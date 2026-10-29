// The pure parts of hawkes-play-native (server/play-native): node --test tools/play-native/unit.test.mjs
// They run anywhere (no display, no GPU); the image itself is tried with tools/play-native/test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveKind, findExe, parseMangoHud, startProblem, runLimits } from '../../server/play-native/session.mjs';
import { JpegSplitter, encoderArgs } from '../../server/play-native/capture.mjs';
import { frameStats, frameDiff, isBlack, classifyRenderer } from '../../server/play-native/display.mjs';
import { xorgBusId } from '../../server/play-native/driver.mjs';

test('archiveKind reads the magic bytes', () => {
  assert.equal(archiveKind(Buffer.from('PK\x03\x04rest', 'latin1')), 'zip');
  assert.equal(archiveKind(Buffer.from([0x1f, 0x8b, 8, 0])), 'gzip');
  assert.equal(archiveKind(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])), 'xz');
  assert.equal(archiveKind(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])), 'zstd');
  const tar = Buffer.alloc(512);
  tar.write('ustar', 257, 'latin1');
  assert.equal(archiveKind(tar), 'tar');
  assert.equal(archiveKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), null); // a bare ELF
  assert.equal(archiveKind(Buffer.from('MZ')), null); // a bare .exe
});

test('findExe picks the game, not its helpers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-exe-'));
  const put = (rel, data = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
  put('UnityCrashHandler64.exe');
  put('MyGame.exe');
  put('MyGame_Data/Plugins/x86_64/helper.exe');
  put('redist/vc_redist.x64.exe');
  assert.equal(findExe(root, 'proton'), path.join(root, 'MyGame.exe'));
  assert.equal(findExe(root, 'proton', 'MyGame_Data/Plugins/x86_64/helper.exe'), path.join(root, 'MyGame_Data/Plugins/x86_64/helper.exe'));
  assert.equal(findExe(root, 'proton', 'nope.exe'), null);
  put('Game.x86_64');
  assert.equal(findExe(root, 'linux'), path.join(root, 'Game.x86_64'));
  const elf = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-elf-'));
  fs.writeFileSync(path.join(elf, 'libfoo.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  fs.writeFileSync(path.join(elf, 'game'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]));
  fs.writeFileSync(path.join(elf, 'readme.txt'), 'hi');
  assert.equal(findExe(elf, 'linux'), path.join(elf, 'game'));
});

test('startProblem refuses what it must', () => {
  const ok = { target: 'proton', build: { url: 'https://x/b.zip' }, exe: 'Game/Game.exe', args: ['-a'], env: { A: 'b' } };
  assert.equal(startProblem(ok), null);
  assert.match(startProblem({ ...ok, target: 'windows' }), /target/);
  assert.match(startProblem({ ...ok, build: { url: 'http://x/b.zip' } }), /https/);
  assert.equal(startProblem({ ...ok, build: { url: 'http://x/b.zip' } }, { allowHttp: true }), null);
  assert.match(startProblem({ ...ok, build: { url: 'file:///etc/passwd' } }, { allowHttp: true }), /https/);
  assert.match(startProblem({ ...ok, exe: '../../etc/x' }), /inside the build/);
  assert.match(startProblem({ ...ok, exe: '/bin/sh' }), /inside the build/);
  assert.match(startProblem({ ...ok, args: 'x' }), /args/);
  assert.match(startProblem({ ...ok, env: { A: 1 } }), /env/);
  assert.match(startProblem({ ...ok, build: { url: 'https://x', sha256: 'abc' } }), /sha256/);
});

test('runLimits clamps to the worker cap and gives Proton longer to boot', () => {
  const l = runLimits({ seconds: 99999 }, 'linux', 900);
  assert.equal(l.seconds, 900);
  assert.ok(runLimits({}, 'proton').bootSeconds > runLimits({}, 'linux').bootSeconds);
  assert.equal(runLimits({ seconds: 'x' }).seconds, 600);
});

test('parseMangoHud reads the CSV after its header block', () => {
  const csv = ['os,cpu,gpu,ram,kernel,driver,cpuscheduler', 'Ubuntu,x,y,16,6,550,', 'fps,frametime,cpu_load,gpu_load,cpu_temp,gpu_temp,gpu_core_clock,gpu_mem_clock,gpu_vram_used,gpu_power,ram_used,swap_used,process_rss,elapsed',
    ...Array.from({ length: 200 }, (_, i) => `${i === 0 ? 10 : 60},${i === 0 ? 100 : 16.6},10,50,40,50,1500,5000,1,50,4,0,1,${i}`)].join('\n');
  const p = parseMangoHud(csv);
  assert.equal(p.samples, 200);
  assert.ok(p.fpsAvg > 59 && p.fpsAvg < 60);
  assert.ok(p.fps1Low < 40);
  assert.equal(p.frameTimeMaxMs, 100);
  assert.equal(parseMangoHud('nothing'), null);
});

test('JpegSplitter finds whole images across chunks', () => {
  const img = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 7), Buffer.from([0xff, 0xd9])]);
  const got = [];
  const s = new JpegSplitter((j) => got.push(j.length));
  const stream = Buffer.concat([img(10), img(1000), img(3)]);
  for (let i = 0; i < stream.length; i += 7) s.push(stream.subarray(i, i + 7));
  assert.deepEqual(got, [14, 1004, 7]);
});

test('frame checks: black, flat, moving', () => {
  const black = Buffer.alloc(64 * 36, 1);
  const gray = Buffer.alloc(64 * 36, 128);
  assert.ok(isBlack(frameStats(black)));
  assert.ok(!isBlack(frameStats(gray)));
  assert.equal(frameDiff(gray, gray), 0);
  assert.ok(frameDiff(black, gray) > 100);
});

test('helpers: renderers, bus ids, encoders', () => {
  assert.equal(classifyRenderer('NVIDIA RTX A4000'), 'gpu');
  assert.equal(classifyRenderer('llvmpipe (LLVM 19.1.1, 256 bits)'), 'software');
  assert.equal(classifyRenderer('llvmpipe (LLVM 19.1.1, 256 bits)'), 'software');
  assert.equal(classifyRenderer(''), 'unknown');
  assert.equal(xorgBusId('00000000:3B:00.0'), 'PCI:59:0:0');
  assert.equal(xorgBusId('nonsense'), null);
  assert.equal(encoderArgs(true)[0], 'h264_nvenc');
  assert.equal(encoderArgs(false)[0], 'libx264');
});
