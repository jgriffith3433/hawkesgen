// Keyless AWS from a Google VM (src/providers/gceaws.ts): the metadata server's identity token, traded with STS for the
// control role's temporary credentials. Offline: fetch is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gceIdentityToken, assumeRoleWithWebIdentity, sessionName, federationOn, DEFAULT_AUDIENCE } from '../src/providers/gceaws.ts';

const reply = (status: number, text: string) => new Response(text, { status });

test('the identity token is asked for with the audience and the metadata header', async () => {
  let seen: { url: string; headers: any } | null = null;
  const f = (async (url: any, init: any) => { seen = { url: String(url), headers: init.headers }; return reply(200, 'aaa.bbb.ccc\n'); }) as typeof fetch;
  assert.equal(await gceIdentityToken(DEFAULT_AUDIENCE, f), 'aaa.bbb.ccc');
  assert.match(seen!.url, /^http:\/\/169\.254\.169\.254\/computeMetadata\/v1\/instance\/service-accounts\/default\/identity\?audience=hawkes-control-aws&format=standard$/);
  assert.equal(seen!.headers['Metadata-Flavor'], 'Google');
});

test('no token off GCE is a clear error', async () => {
  const f = (async () => reply(404, 'Not Found')) as typeof fetch;
  await assert.rejects(gceIdentityToken('x', f), /no identity token/);
});

test('STS credentials are parsed, and the token travels in the body', async () => {
  let body = '';
  const f = (async (_url: any, init: any) => {
    body = String(init.body);
    return reply(200, `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
      <AccessKeyId>ASIAX</AccessKeyId><SecretAccessKey>sek</SecretAccessKey><SessionToken>tok</SessionToken>
      <Expiration>2026-10-28T20:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
  }) as typeof fetch;
  const c = await assumeRoleWithWebIdentity({ roleArn: 'arn:aws:iam::1:role/hawkes/x', token: 'aaa.bbb.ccc', sessionName: 'gce-test' }, f);
  assert.deepEqual(c, { accessKeyId: 'ASIAX', secretAccessKey: 'sek', sessionToken: 'tok', expiration: new Date('2026-10-28T20:00:00Z') });
  const p = new URLSearchParams(body);
  assert.equal(p.get('Action'), 'AssumeRoleWithWebIdentity');
  assert.equal(p.get('WebIdentityToken'), 'aaa.bbb.ccc');
  assert.equal(p.get('RoleArn'), 'arn:aws:iam::1:role/hawkes/x');
});

test('an STS refusal names its code', async () => {
  const f = (async () => reply(403, '<ErrorResponse><Error><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error></ErrorResponse>')) as typeof fetch;
  await assert.rejects(assumeRoleWithWebIdentity({ roleArn: 'a', token: 't', sessionName: 's' }, f), (e: any) => e.name === 'AccessDenied' && /Not authorized/.test(e.message));
});

test('session names stay inside what AWS accepts', () => {
  assert.equal(sessionName('hawkes-control.us-east4-c.c.hawkes-prod.internal'), 'gce-hawkes-control.us-east4-c.c.hawkes-prod.internal');
  assert.equal(sessionName('a b/c'), 'gce-a-b-c');
  assert.ok(sessionName('x'.repeat(100)).length <= 64);
});

test('secret names on Google, and env-file secrets', async () => {
  // @ts-ignore: a plain .mjs script
  const { gcpName, parseSecret } = await import('../bin/fetch-secrets.mjs');
  assert.equal(gcpName('hawkes/gen'), 'hawkes-control-gen');
  assert.equal(gcpName('hawkes/keys.env'), 'hawkes-control-keys-env');
  assert.deepEqual(parseSecret('{"A":"1"}'), { A: '1' });
  assert.deepEqual(parseSecret('A=1\n# note\nB_2 = two words\n'), { A: '1', B_2: 'two words' });
});

test('federation is off unless the unit says gce', () => {
  assert.equal(federationOn({}), false);
  assert.equal(federationOn({ HAWKES_AWS_FEDERATION: 'gce' }), true);
});
