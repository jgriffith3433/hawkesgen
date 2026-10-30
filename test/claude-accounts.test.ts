// Claude accounts (src/claude-accounts.ts, a port of Studio's): signing in through a stand-in `claude setup-token`,
// saving, switching, checking, and the token Gen's Claude calls run with (src/providers/claudecode.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-claude-acc-'));
process.env.HAWKESGEN_DATA_DIR = path.join(tmp, 'data');
delete process.env.HAWKESGEN_CLAUDE_ENV;
const ENV_TOKEN = `sk-ant-oat01-${'e'.repeat(40)}`;
const NEW_TOKEN = `sk-ant-oat01-${'n'.repeat(38)}Ab`;
process.env.CLAUDE_CODE_OAUTH_TOKEN = ENV_TOKEN;
process.env.ANTHROPIC_API_KEY = 'sk-ant-api-test';

// The stand-in for `claude setup-token`: a banner, the link as a terminal hyperlink, then the code on stdin.
const setup = path.join(tmp, 'setup.mjs');
fs.writeFileSync(setup, `
const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&scope=user%3Ainference&code_challenge=abc&state=St4te_-x';
process.stdout.write('\\x1b[2J Welcome\\n Browser didn\\'t open? Use the url below\\n\\x1b]8;id=1;' + url + '\\x07' + url + '\\x1b]8;;\\x07\\n Paste code here if prompted > ');
let got = '';
process.stdin.on('data', (d) => {
  got += d;
  if (!got.includes('\\r')) return;
  const code = got.replace('\\r', '');
  if (code === 'good#code-1234') process.stdout.write('\\n\\x1b[32m Long-lived authentication token created successfully!\\x1b[0m\\n\\n ${NEW_TOKEN}\\n\\n Store this token securely.\\n');
  else process.stdout.write('\\n OAuth error: Invalid code\\n');
  process.exit(0);
});
`);
process.env.HAWKESGEN_CLAUDE_SETUP_ARGS = JSON.stringify([process.execPath, setup]);

// The stand-in for `claude -p` (the account check): the new token answers, any other is out of usage.
const fake = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fake, `
const ok = process.env.CLAUDE_CODE_OAUTH_TOKEN === '${NEW_TOKEN}' && !process.env.ANTHROPIC_API_KEY;
console.log(JSON.stringify(ok ? { is_error: false, result: 'ok' } : { is_error: true, result: "You've hit your weekly limit · resets Oct 23" }));
`);
process.env.HAWKESGEN_CLAUDE = process.execPath;
process.env.HAWKESGEN_CLAUDE_ARGS = JSON.stringify([fake]);

const ca = await import('../src/claude-accounts.ts');
const { subscriptionToken } = await import('../src/providers/claudecode.ts');
const activeEnv = () => fs.readFileSync(path.join(process.env.HAWKESGEN_DATA_DIR!, 'claude', 'active.env'), 'utf8');

test('the environment token becomes the first account, in use', () => {
  const l = ca.listAccounts();
  assert.equal(l.accounts.length, 1);
  assert.equal(l.accounts[0].active, true);
  assert.equal(l.accounts[0].tail, 'eeee');
  assert.equal(JSON.stringify(l).includes(ENV_TOKEN), false, 'the list never has a token');
  assert.equal(ca.activeToken(), ENV_TOKEN);
  assert.match(activeEnv(), /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-e+\n$/);
});

test('the sign-in link comes out of terminal output', () => {
  const out = '\x1b]8;id=7l;https://claude.com/cai/oauth/authorize?code=true&state=R2f_N-3\x07https://claude.com/cai/oauth/authorize?code=true&state=R2f_N-3\x1b]8;;\x07\n\nPaste code';
  assert.equal(ca.signinUrl(out), 'https://claude.com/cai/oauth/authorize?code=true&state=R2f_N-3');
  assert.equal(ca.signinUrl('no link yet'), null);
});

test('a wrong code fails and says why; nothing is saved', async () => {
  const s = await ca.startSignin('Work account');
  assert.equal(s.state, 'waiting');
  await assert.rejects(ca.finishSignin('bad#code-xxxxx', { timeoutMs: 5000 }), /Invalid code/);
  assert.equal(ca.listAccounts().accounts.length, 1);
  assert.equal(ca.listAccounts().signin?.state, 'failed');
});

test('signing in saves the account and Gen\'s Claude calls use it at once, over the environment token', async () => {
  const s = await ca.startSignin('Work account');
  assert.match(s.url!, /oauth\/authorize\?.*state=St4te_-x$/);
  const r = await ca.finishSignin('  good#code-1234 \n');
  assert.equal(r.account.label, 'Work account');
  assert.equal(r.account.active, true);
  assert.ok(r.account.expires! > Date.now() + 360 * 86_400_000);
  assert.equal(ca.activeToken(), NEW_TOKEN);
  assert.equal(activeEnv(), `CLAUDE_CODE_OAUTH_TOKEN=${NEW_TOKEN}\n`);
  assert.equal(subscriptionToken(), NEW_TOKEN, 'the picked account wins over CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(JSON.stringify(r).includes(NEW_TOKEN), false);
});

test('a check says whether an account answers or is out of usage', async () => {
  const [old, work] = ca.listAccounts().accounts;
  assert.equal((await ca.checkAccount(work.id)).ok, true);
  const c = await ca.checkAccount(old.id);
  assert.equal(c.ok, false);
  assert.match(c.note, /Out of usage/);
  assert.match(ca.listAccounts().accounts[0].check!.note, /weekly limit/);
});

test('switching back, renaming, and removing (never the one in use)', () => {
  const [old, work] = ca.listAccounts().accounts;
  assert.throws(() => ca.removeAccount(work.id), /in use/);
  ca.useAccount(old.id);
  assert.equal(ca.activeToken(), ENV_TOKEN);
  assert.equal(subscriptionToken(), ENV_TOKEN);
  assert.equal(ca.renameAccount(old.id, '  jgriffith  personal ').accounts[0].label, 'jgriffith personal');
  assert.equal(ca.removeAccount(work.id).accounts.length, 1);
  assert.throws(() => ca.useAccount('ca_000000000000'), /No Claude account/);
});

after(() => ca.cancelSignin());

test('a pasted token (claude setup-token run elsewhere, e.g. on Windows) is saved and used at once; anything else is refused', () => {
  const pasted = `sk-ant-oat01-${'p'.repeat(40)}`;
  assert.throws(() => ca.addToken('not a token', 'x'), /setup-token/);
  assert.throws(() => ca.addToken(`${pasted} trailing words`, 'x'), /setup-token/);
  const r = ca.addToken(`  ${pasted}\n`, 'My PC');
  assert.equal(r.account.label, 'My PC');
  assert.equal(r.account.active, true);
  assert.equal(r.account.source, 'pasted');
  assert.equal(ca.activeToken(), pasted);
  assert.equal(JSON.stringify(r).includes(pasted), false, 'the token never comes back');
});
