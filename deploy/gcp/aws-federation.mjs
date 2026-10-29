// Keyless AWS for the Google control VM: the IAM role hawkes/hawkes-control-gce that trusts Google's own identity provider
// (accounts.google.com, built into AWS: no OIDC provider to create) for exactly one principal, the VM's service account.
// Gen and Studio trade the VM's metadata identity token for this role's credentials (hawkesgen src/providers/gceaws.ts,
// AssumeRoleWithWebIdentity; HAWKES_AWS_FEDERATION=gce in their units). No AWS keys live on the VM.
//
//   node deploy/gcp/aws-federation.mjs              print the trust and permission policies (plan)
//   node deploy/gcp/aws-federation.mjs --apply      create or update the role (J: IAM writes are his)
//   options: --sa-id <unique id>  (else hawkesstudio/deploy/.keys/gcp-control.json, else gcloud)  --json (only the JSON)
//            --gen-sa-id <unique id>  Gen on Cloud Run's account (gen-control@hawkes-staging; else the state file, else
//            gcloud); --no-gen leaves it out. Each account is its own statement, so neither can borrow the other's claims.
//
// The trust policy pins three claims of the token (AWS's names for Google's claims):
//   accounts.google.com:aud  = the service account's unique id (AWS maps Google's azp here)
//   accounts.google.com:sub  = the same unique id (the token's subject)
//   accounts.google.com:oaud = hawkes-control-aws (the audience Gen asks the metadata server for)
// Permissions: the same as today's EC2 role hawkes/hawkes-control (its inline policies hawkes-control and hawkes-mail are
// copied live from AWS when the claw keys may read them, else the copy below from hawkesstudio deploy/provision.mjs).
import { AWS, ROLE_ARN, SA_EMAIL, GCP, APPLY, flag, opt, say, warn, fail, header, gcpState, saveGcpState, gcloudJson, awsCfg, awsSdk } from './lib.mjs';

const ROLE_NAME = AWS.roleName;
const OLD_ROLE = 'hawkes-control';

/** hawkesstudio deploy/provision.mjs ROLE_POLICY (2026-10-28) and deploy.mjs setupEmail's hawkes-mail. */
const FALLBACK = {
  'hawkes-control': {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: ['ec2:*', 'servicequotas:GetServiceQuota', 'servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota', 'servicequotas:RequestServiceQuotaIncrease', 'sts:GetCallerIdentity'], Resource: '*' },
      { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:*:${AWS.account}:secret:hawkes/*` },
      { Effect: 'Allow', Action: 's3:*', Resource: ['arn:aws:s3:::hawkes-*', 'arn:aws:s3:::hawkes-*/*'] },
      { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], Resource: '*' },
      { Effect: 'Allow', Action: ['ce:GetCostAndUsage', 'ce:GetCostForecast'], Resource: '*' },
    ],
  },
  'hawkes-mail': {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['ses:SendEmail', 'ses:SendRawEmail'], Resource: 'arn:aws:ses:us-east-1:*:identity/hawkesgen.ai', Condition: { StringLike: { 'ses:FromAddress': '*@hawkesgen.ai' } } }],
  },
};

const GEN_SA = 'gen-control@hawkes-staging.iam.gserviceaccount.com';

/** Gen on Cloud Run (docs/gpu-providers.md in hawkesgen, "AWS from Cloud Run"): it trades its own identity token too. */
function genSaId() {
  if (flag('no-gen')) return null;
  const given = opt('gen-sa-id') ?? gcpState().genServiceAccountId;
  if (given) return String(given);
  const sa = gcloudJson(['iam', 'service-accounts', 'describe', GEN_SA, '--project', 'hawkes-staging']);
  if (sa?.uniqueId) { saveGcpState({ genServiceAccountId: sa.uniqueId }); return sa.uniqueId; }
  return null;
}

function saId() {
  const given = opt('sa-id') ?? gcpState().serviceAccountId;
  if (given) return String(given);
  const sa = gcloudJson(['iam', 'service-accounts', 'describe', SA_EMAIL, '--project', GCP.project]);
  if (sa?.uniqueId) { saveGcpState({ serviceAccountId: sa.uniqueId }); return sa.uniqueId; }
  return null;
}

export function trustPolicy(id, genId = null) {
  const statement = (Sid, who) => ({
    Sid,
    Effect: 'Allow',
    Principal: { Federated: 'accounts.google.com' },
    Action: 'sts:AssumeRoleWithWebIdentity',
    Condition: { StringEquals: { 'accounts.google.com:aud': who, 'accounts.google.com:sub': who, 'accounts.google.com:oaud': AWS.audience } },
  });
  return {
    Version: '2012-10-17',
    Statement: [statement('HawkesControlVmOnGoogle', id), ...(genId ? [statement('HawkesGenOnCloudRun', genId)] : [])],
  };
}

async function livePolicies(iam) {
  const { GetRolePolicyCommand } = await awsSdk('@aws-sdk/client-iam');
  const out = {};
  for (const name of Object.keys(FALLBACK)) {
    try {
      const r = await iam.send(new GetRolePolicyCommand({ RoleName: OLD_ROLE, PolicyName: name }));
      out[name] = JSON.parse(decodeURIComponent(r.PolicyDocument));
    } catch (e) {
      if (e.name !== 'NoSuchEntity') warn(`could not read ${OLD_ROLE}/${name} (${e.name}): using the copy in this script`);
      out[name] = FALLBACK[name];
    }
  }
  return out;
}

const id = saId();
if (!id) fail(`No unique id for ${SA_EMAIL}: run provision.mjs --apply first, or pass --sa-id <number> (gcloud iam service-accounts describe ${SA_EMAIL} --format="value(uniqueId)")`);
if (!/^\d{10,}$/.test(id)) fail(`--sa-id must be the service account's numeric unique id, not ${id}`);
const genId = genSaId();
if (genId && !/^\d{10,}$/.test(genId)) fail(`--gen-sa-id must be the service account's numeric unique id, not ${genId}`);
if (!genId && !flag('no-gen')) warn(`no unique id for ${GEN_SA}: Gen on Cloud Run can't use AWS until this runs again with it (--gen-sa-id <number>)`);

let policies = FALLBACK;
let iam = null;
if (APPLY || flag('live')) {
  const { IAMClient } = await awsSdk('@aws-sdk/client-iam');
  iam = new IAMClient(awsCfg());
  policies = await livePolicies(iam);
}

if (flag('json')) {
  console.log(JSON.stringify({ roleArn: ROLE_ARN, trust: trustPolicy(id, genId), policies }, null, 2));
  process.exit(0);
}

header(`AWS role ${ROLE_ARN} for ${SA_EMAIL} (unique id ${id})${genId ? ` and ${GEN_SA} (${genId})` : ''}`);
say('trust policy:');
console.log(JSON.stringify(trustPolicy(id, genId), null, 2));
for (const [name, doc] of Object.entries(policies)) {
  say(`inline policy ${name}${APPLY || flag('live') ? ' (copied from hawkes/hawkes-control)' : ' (the copy in this script; --live reads the current one)'}:`);
  console.log(JSON.stringify(doc, null, 2));
}
say('then the VM units set HAWKES_AWS_FEDERATION=gce, HAWKES_AWS_ROLE_ARN and HAWKES_AWS_AUDIENCE (move.mjs drop-ins)');

if (APPLY) {
  const { CreateRoleCommand, UpdateAssumeRolePolicyCommand, PutRolePolicyCommand, TagRoleCommand } = await awsSdk('@aws-sdk/client-iam');
  const trust = JSON.stringify(trustPolicy(id, genId));
  try {
    await iam.send(new CreateRoleCommand({
      RoleName: ROLE_NAME, Path: AWS.rolePath, MaxSessionDuration: 3600, AssumeRolePolicyDocument: trust,
      Description: 'Hawkes control server on Google Compute Engine (Studio + Gen): web identity from its service account',
      Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }],
    }));
    say(`created ${ROLE_ARN}`);
  } catch (e) {
    if (e.name !== 'EntityAlreadyExistsException') throw e;
    await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: ROLE_NAME, PolicyDocument: trust }));
    await iam.send(new TagRoleCommand({ RoleName: ROLE_NAME, Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }] }));
    say(`updated the trust policy of ${ROLE_ARN}`);
  }
  for (const [PolicyName, doc] of Object.entries(policies)) {
    await iam.send(new PutRolePolicyCommand({ RoleName: ROLE_NAME, PolicyName, PolicyDocument: JSON.stringify(doc) }));
    say(`put inline policy ${PolicyName}`);
  }
  saveGcpState({ awsRoleArn: ROLE_ARN });
  say('done. Check from the VM: node deploy/gcp/move.mjs check (it assumes the role with the VM\'s identity)');
}
