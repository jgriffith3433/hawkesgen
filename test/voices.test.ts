// audio.voice-list / audio.voice-delete: what Gen knows about a voice, the refusal for a voice a product uses, and the note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-voices-'));
const { db } = await import('../src/db.ts');
const { voiceKnowledge, voiceListTool, voiceDeleteTool } = await import('../src/tools/voices.ts');
const { getTool } = await import('../src/tools/index.ts');

const USED = 'AbCdEf123456';
const FREE = 'ZyXwVu987654';
let n = 0;
function job(project: string, tool: string, params: object, result: object | null = null) {
  db.prepare(`INSERT INTO jobs (id, client, project, tool, params, inputs, status, result, created) VALUES (?, 'c1', ?, ?, ?, '{}', 'done', ?, ?)`)
    .run(`j_v${n++}`, project, tool, JSON.stringify(params), result ? JSON.stringify(result) : null, Date.now());
}
job('yoobaland', 'audio.voice-save', { name: 'Mara' }, { voiceId: USED });
job('yoobaland', 'audio.voice', { text: 'hi', voice: USED });

test('the tools are registered', () => {
  assert.ok(getTool('audio.voice-list'));
  assert.ok(getTool('audio.voice-delete'));
});

test('Gen knows who saved a voice and who uses it', () => {
  const k = voiceKnowledge(USED);
  assert.equal(k.origin?.project, 'yoobaland');
  assert.deepEqual(k.uses.map((u) => u.tool), ['audio.voice']);
  const free = voiceKnowledge(FREE);
  assert.equal(free.origin, null);
  assert.deepEqual(free.uses, []);
  assert.throws(() => voiceKnowledge('bad id!'), /voice id/);
});

function ctx(params: Record<string, any>) {
  const out: any = { result: null, logs: [] as string[] };
  return {
    out,
    c: { job: { id: 'j_del', client: 'agent', project: 'yoobaland', tool: 'audio.voice-delete', labels: {} }, params, inputs: {}, done: 0, outputs: [], signal: new AbortController().signal,
      step() {}, log: (l: string) => out.logs.push(l), tmp: (x: string) => x, emit: async () => {}, result: (v: unknown) => (out.result = v), seed: () => 0, usage() {}, python: async () => '' } as any,
  };
}

test('delete refuses a voice a product uses unless confirmed, before calling ElevenLabs', async () => {
  const { c } = ctx({ voiceId: USED });
  await assert.rejects(() => voiceDeleteTool.run(c), /used by yoobaland.*confirm: true/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage WHERE unit = 'voice-deleted'").get() as any).n, 0);
});

test('delete needs a well-formed id at submit', () => {
  assert.throws(() => voiceDeleteTool.guard!({ params: { voiceId: 'x' }, inputs: {} }), /voice id/);
  voiceDeleteTool.guard!({ params: { voiceId: FREE }, inputs: {} });
});

test('list and delete against a stubbed ElevenLabs account', async () => {
  const realRequest = (await import('node:https')).default.request;
  const https = (await import('node:https')).default as any;
  process.env.ELEVENLABS_API_KEY = 'test';
  const calls: string[] = [];
  https.request = (url: string, opts: any, cb: any) => {
    calls.push(`${opts.method} ${url}`);
    const req: any = new EventEmitter();
    req.write = () => {}; req.destroy = () => {};
    req.end = () => {
      const res: any = new EventEmitter();
      cb(res);
      const body = opts.method === 'DELETE' ? '{}' : JSON.stringify({ voices: [
        { voice_id: USED, name: 'Mara', category: 'generated', created_at_unix: 1760000000 },
        { voice_id: FREE, name: 'Old test', category: 'generated', created_at_unix: 1750000000 },
        { voice_id: 'Premade12345', name: 'Rachel', category: 'premade' },
      ] });
      res.statusCode = 200; res.headers = {};
      res.emit('data', Buffer.from(body)); res.emit('end');
    };
    return req;
  };
  try {
    const l = ctx({});
    await voiceListTool.run(l.c);
    assert.equal(l.out.result.count, 2);
    const mara = l.out.result.voices.find((v: any) => v.id === USED);
    assert.equal(mara.name, 'Mara');
    assert.equal(mara.madeBy.job, 'j_v0');
    assert.deepEqual(mara.usedByProducts, ['yoobaland']);

    const d = ctx({ voiceId: FREE });
    await voiceDeleteTool.run(d.c);
    assert.equal(d.out.result.deleted, true);
    assert.ok(calls.some((x) => x.startsWith('DELETE') && x.endsWith(`/v1/voices/${FREE}`)));
    const note = db.prepare("SELECT * FROM usage WHERE unit = 'voice-deleted'").get() as any;
    assert.match(note.detail, new RegExp(FREE));
    assert.match(note.detail, /Old test/);
    assert.match(note.detail, /agent\/yoobaland/);

    const forced = ctx({ voiceId: USED, confirm: true });
    await voiceDeleteTool.run(forced.c);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage WHERE unit = 'voice-deleted'").get() as any).n, 2);
  } finally {
    https.request = realRequest;
  }
});
