// Gen's MCP for editors that read fields (hawkesgen-unity): structuredContent, tasks that outlast a call (state
// "running" + get_task) and outputs as {url, filename, mime} objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genMcp } from '../src/mcp-tools.ts';
import { rpc } from '../src/mcp-core.ts';

/** A stand-in Gen client: job j1 finishes on the third look. */
function fakeGen() {
  let looks = 0;
  const queued = { id: 'j1', tool: 'image.cutout', project: 'u_x', status: 'running', detail: 'Cutting out' };
  const done = { ...queued, status: 'done', detail: 'Done', outputs: [{ asset: 'a_1', mime: 'image/png', title: 'cutout' }] };
  const gen: any = {
    submit: async () => queued,
    job: async (id: string) => { if (id !== 'j1') throw new Error('no such job'); looks++; return looks >= 3 ? done : queued; },
    wait: async (id: string, { timeoutMs }: any) => {
      const j = await gen.job(id);
      if (j.status === 'done') return j;
      const e: any = new Error('Timed out'); e.kind = 'timeout'; e.job = j;
      if (timeoutMs >= 0) throw e;
      return j;
    },
    asset: async (id: string) => ({ path: `/lib/${id}.png` }),
  };
  return gen;
}

const call = async (server: any, name: string, args: any) => (await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;

test('a long job comes back running with a task_id; get_task returns it done with file objects', async () => {
  const server = genMcp(fakeGen(), { remote: true, filesUrl: 'https://gen.test', account: 'u_x', fileLink: (a, n) => `https://gen.test/dl/t/${n}` });
  const first = await call(server, 'remove_background', { image: 'asset:a_0', wait_seconds: 0 });
  assert.equal(first.structuredContent.state, 'running');
  assert.equal(first.structuredContent.task_id, 'j1');
  assert.equal(first.structuredContent.progress.message, 'Cutting out');
  assert.match(first.content[0].text, /"state": "running"/, 'the text still carries it for chat clients');

  const second = await call(server, 'get_task', { task_id: 'j1', wait_seconds: 0 });
  assert.equal(second.structuredContent.state, 'done');
  assert.deepEqual(second.structuredContent.files, [{ url: 'https://gen.test/dl/t/image-cutout-cutout.png', filename: 'image-cutout-cutout.png', mime: 'image/png', title: 'cutout', asset: 'a_1' }]);
});

test('a failed job is an error, and get_task refuses a malformed id', async () => {
  const gen = fakeGen();
  gen.wait = async () => ({ id: 'j1', tool: 'image.cutout', status: 'failed', error: 'out of memory' });
  const server = genMcp(gen, { remote: true, account: 'u_x', fileLink: () => '' });
  const r = await call(server, 'remove_background', { image: 'asset:a_0' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /failed: out of memory/);
  assert.equal((await call(server, 'get_task', { task_id: '../../x' })).isError, true);
});

test('upload_file gives the link as upload.url too; a string result has no structuredContent', async () => {
  const server = genMcp(fakeGen(), { remote: true, account: 'u_x', uploadLink: (f) => `https://gen.test/up/t/${f}` });
  const r = await call(server, 'upload_file', { filename: 'hero.png' });
  assert.equal(r.structuredContent.upload.url, 'https://gen.test/up/t/hero.png');
  assert.equal(r.structuredContent.upload_url, 'https://gen.test/up/t/hero.png');
  const plain = await rpc({ name: 'x', version: '1', instructions: '', tools: [{ name: 's', description: '', inputSchema: {}, run: async () => 'hello' }] }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 's' } });
  assert.equal(plain.result.structuredContent, undefined);
});

test('transform_image runs image.transform with the steps as its ops', async () => {
  const gen = fakeGen();
  let sent: any = null;
  gen.submit = async (tool: string, body: any) => { sent = { tool, ...body }; return { id: 'j1', tool: 'image.transform', project: 'u_x', status: 'running' }; };
  const server = genMcp(gen, { remote: true, account: 'u_x', fileLink: () => '' });
  const steps = [{ op: 'trim' }, { op: 'pixelate', size: 64, colors: 16 }];
  await call(server, 'transform_image', { image: 'asset:a_0', steps, wait_seconds: 0 });
  assert.equal(sent.tool, 'image.transform');
  assert.deepEqual(sent.params.ops, steps);
  assert.equal(sent.inputs.image, 'asset:a_0');
});
