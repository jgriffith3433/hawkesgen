#!/usr/bin/env node
// cdn.hawkesgen.ai: a CloudFront distribution in front of the library bucket (src/storage.ts). Idempotent: every step
// looks at what exists and only does what's missing. Dry run by default (reads only, prints the plan and the cost);
// --apply creates things. Docs: docs/cdn.md.
//
//   node deploy/cdn.mjs                 # plan
//   node deploy/cdn.mjs --apply         # create/repair, then save settings.storage.cdn
//   options: --domain cdn.hawkesgen.ai  --zone hawkesgen.ai  --bucket <name>  --alarm-usd 20
//
// Uses Gen's own AWS config (awsConfig(): .env keys or the instance role). Keys are never printed.
import { CloudFrontClient, ListOriginAccessControlsCommand, CreateOriginAccessControlCommand, ListCachePoliciesCommand, CreateCachePolicyCommand, ListResponseHeadersPoliciesCommand, CreateResponseHeadersPolicyCommand, ListDistributionsCommand, CreateDistributionCommand } from '@aws-sdk/client-cloudfront';
import { ACMClient, ListCertificatesCommand, RequestCertificateCommand, DescribeCertificateCommand } from '@aws-sdk/client-acm';
import { Route53Client, ListHostedZonesByNameCommand, ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { S3Client, GetBucketPolicyCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';
import { CloudWatchClient, DescribeAlarmsCommand, PutMetricAlarmCommand } from '@aws-sdk/client-cloudwatch';
import { awsConfig } from '../src/providers/comfy/fleet.ts';
import { bucket as configuredBucket } from '../src/storage.ts';
import { loadSettings, saveSettings } from '../src/config.ts';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const APPLY = flag('apply');
const DOMAIN = opt('domain', 'cdn.hawkesgen.ai');
const ZONE = opt('zone', 'hawkesgen.ai');
const BUCKET = opt('bucket', configuredBucket() ?? 'hawkes-gen-library-028793236279');
const ALARM_USD = Number(opt('alarm-usd', 20));
const NAMES = { oac: 'hawkesgen-library-oac', cache: 'hawkesgen-cdn-path-only', headers: 'hawkesgen-cdn-headers', alarm: 'hawkesgen-cdn-cloudfront-charges', sid: 'HawkesCdnRead' };
const CF_ZONE_ID = 'Z2FDTNDATAQYW2'; // CloudFront's fixed hosted zone, for alias records
const cfg = { ...awsConfig(), region: 'us-east-1' }; // CloudFront, ACM (for CloudFront) and billing metrics all live in us-east-1
const cf = new CloudFrontClient(cfg), acm = new ACMClient(cfg), r53 = new Route53Client(cfg), s3 = new S3Client(cfg), cw = new CloudWatchClient(cfg);

const say = (m) => console.log(m);
const did = (m) => say(`  ${APPLY ? 'done' : 'would'}: ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notFound = (e) => e?.name === 'NoSuchBucketPolicy' || e?.$metadata?.httpStatusCode === 404;

say(`CDN for ${DOMAIN}  <-  s3://${BUCKET}   (${APPLY ? 'APPLYING' : 'dry run: nothing is changed; add --apply to act'})\n`);

// 1. The DNS zone.
say('1. Route 53 zone');
const zones = await r53.send(new ListHostedZonesByNameCommand({ DNSName: ZONE, MaxItems: 1 }));
const zone = zones.HostedZones?.find((z) => z.Name === `${ZONE}.`);
if (!zone) throw new Error(`No Route 53 hosted zone for ${ZONE} in this AWS account`);
const zoneId = zone.Id.replace('/hostedzone/', '');
say(`  found ${ZONE} (${zoneId})`);
const upsert = (changes, comment) => r53.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: zoneId, ChangeBatch: { Comment: comment, Changes: changes.map((c) => ({ Action: 'UPSERT', ResourceRecordSet: c })) } }));

// 2. The certificate (us-east-1), validated by DNS.
say('2. ACM certificate');
let certArn;
for (let tok; ; ) {
  const l = await acm.send(new ListCertificatesCommand({ NextToken: tok, CertificateStatuses: ['ISSUED', 'PENDING_VALIDATION'] }));
  const hit = (l.CertificateSummaryList ?? []).find((c) => c.DomainName === DOMAIN);
  if (hit) { certArn = hit.CertificateArn; break; }
  if (!(tok = l.NextToken)) break;
}
if (!certArn) {
  did(`request a DNS-validated certificate for ${DOMAIN}`);
  if (APPLY) certArn = (await acm.send(new RequestCertificateCommand({ DomainName: DOMAIN, ValidationMethod: 'DNS', IdempotencyToken: 'hawkescdn' }))).CertificateArn;
} else say(`  found ${certArn}`);
let certReady = false;
if (certArn) {
  let desc;
  for (let i = 0; i < 40; i++) {
    desc = (await acm.send(new DescribeCertificateCommand({ CertificateArn: certArn }))).Certificate;
    const rr = desc.DomainValidationOptions?.[0]?.ResourceRecord;
    if (desc.Status === 'ISSUED') { certReady = true; break; }
    if (!APPLY) break;
    if (rr && i === 0 || (rr && i % 10 === 0)) { await upsert([{ Name: rr.Name, Type: rr.Type, TTL: 300, ResourceRecords: [{ Value: rr.Value }] }], 'ACM validation for the CDN'); say('  validation record is in Route 53; waiting for ACM to issue (up to ~10 min)'); }
    await sleep(15000);
  }
  say(`  status ${desc?.Status}${certReady ? '' : APPLY ? ' (still not issued: run again in a few minutes)' : ' (the validation CNAME would be added in Route 53)'}`);
} else say('  (validation record and waiting for ISSUED would follow)');

// 3-5. Origin access control, cache policy, response headers policy.
async function ensure(kind, find, create) {
  const have = await find();
  if (have) { say(`  found ${kind} ${have}`); return have; }
  did(`create ${kind}`);
  return APPLY ? create() : null;
}
say('3. Origin access control');
const oacId = await ensure('OAC', async () => (await cf.send(new ListOriginAccessControlsCommand({}))).OriginAccessControlList?.Items?.find((o) => o.Name === NAMES.oac)?.Id,
  async () => (await cf.send(new CreateOriginAccessControlCommand({ OriginAccessControlConfig: { Name: NAMES.oac, Description: 'Hawkes Gen library bucket', SigningProtocol: 'sigv4', SigningBehavior: 'always', OriginAccessControlOriginType: 's3' } }))).OriginAccessControl.Id);

say('4. Cache policy (path only, one-year TTLs, compression)');
const cacheId = await ensure('cache policy', async () => (await cf.send(new ListCachePoliciesCommand({ Type: 'custom' }))).CachePolicyList?.Items?.find((p) => p.CachePolicy.CachePolicyConfig.Name === NAMES.cache)?.CachePolicy.Id,
  async () => (await cf.send(new CreateCachePolicyCommand({ CachePolicyConfig: { Name: NAMES.cache, Comment: 'Content-addressed files: key on the path only', MinTTL: 1, DefaultTTL: 31536000, MaxTTL: 31536000,
    ParametersInCacheKeyAndForwardedToOrigin: { EnableAcceptEncodingGzip: true, EnableAcceptEncodingBrotli: true, HeadersConfig: { HeaderBehavior: 'none' }, CookiesConfig: { CookieBehavior: 'none' }, QueryStringsConfig: { QueryStringBehavior: 'none' } } } }))).CachePolicy.Id);

say('5. Response headers policy (CORS *, Timing-Allow-Origin *, nosniff, sandboxed CSP)');
const headersId = await ensure('response headers policy', async () => (await cf.send(new ListResponseHeadersPoliciesCommand({ Type: 'custom' }))).ResponseHeadersPolicyList?.Items?.find((p) => p.ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name === NAMES.headers)?.ResponseHeadersPolicy.Id,
  async () => (await cf.send(new CreateResponseHeadersPolicyCommand({ ResponseHeadersPolicyConfig: { Name: NAMES.headers, Comment: 'Library files can be used by sandboxed games but never run as a page',
    CorsConfig: { AccessControlAllowOrigins: { Quantity: 1, Items: ['*'] }, AccessControlAllowHeaders: { Quantity: 1, Items: ['*'] }, AccessControlAllowMethods: { Quantity: 3, Items: ['GET', 'HEAD', 'OPTIONS'] }, AccessControlAllowCredentials: false, OriginOverride: true },
    SecurityHeadersConfig: { ContentTypeOptions: { Override: true }, ContentSecurityPolicy: { Override: true, ContentSecurityPolicy: "default-src 'none'; sandbox" } },
    CustomHeadersConfig: { Quantity: 1, Items: [{ Header: 'Timing-Allow-Origin', Value: '*', Override: true }] } } }))).ResponseHeadersPolicy.Id);

// 6. The distribution.
say('6. CloudFront distribution (pay-as-you-go, PriceClass_100)');
let dist;
for (let m; ; ) {
  const l = (await cf.send(new ListDistributionsCommand({ Marker: m }))).DistributionList;
  dist = (l?.Items ?? []).find((d) => d.Aliases?.Items?.includes(DOMAIN));
  if (dist || !l?.IsTruncated) break;
  m = l.NextMarker;
}
if (dist) say(`  found ${dist.Id} (${dist.DomainName}, ${dist.Status})`);
else if (!APPLY || (oacId && cacheId && headersId && certReady)) {
  did(`create the distribution for ${DOMAIN}`);
  if (APPLY) {
    const originId = 'library-s3';
    dist = (await cf.send(new CreateDistributionCommand({ DistributionConfig: {
      CallerReference: `hawkesgen-cdn-${Date.now()}`, Comment: `Hawkes Gen library (${DOMAIN})`, Enabled: true, PriceClass: 'PriceClass_100', HttpVersion: 'http2and3', IsIPV6Enabled: true, DefaultRootObject: '',
      Aliases: { Quantity: 1, Items: [DOMAIN] },
      ViewerCertificate: { ACMCertificateArn: certArn, SSLSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' },
      Origins: { Quantity: 1, Items: [{ Id: originId, DomainName: `${BUCKET}.s3.us-east-1.amazonaws.com`, OriginAccessControlId: oacId, S3OriginConfig: { OriginAccessIdentity: '' } }] },
      DefaultCacheBehavior: { TargetOriginId: originId, ViewerProtocolPolicy: 'redirect-to-https', Compress: true, CachePolicyId: cacheId, ResponseHeadersPolicyId: headersId, AllowedMethods: { Quantity: 3, Items: ['GET', 'HEAD', 'OPTIONS'], CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } } },
    } }))).Distribution;
    say(`  created ${dist.Id} (${dist.DomainName})`);
  }
} else say('  not created yet: the certificate, OAC and policies must exist first (run --apply again once the certificate is issued)');

// 7. The bucket stays private; only this distribution may read sha256/*.
say('7. Bucket policy (this distribution only, sha256/*)');
if (dist?.ARN) {
  let policy = { Version: '2012-10-17', Statement: [] };
  try { policy = JSON.parse((await s3.send(new GetBucketPolicyCommand({ Bucket: BUCKET }))).Policy); } catch (e) { if (!notFound(e)) throw e; }
  const want = { Sid: NAMES.sid, Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject', Resource: `arn:aws:s3:::${BUCKET}/sha256/*`, Condition: { StringEquals: { 'AWS:SourceArn': dist.ARN } } };
  const cur = policy.Statement.find((s) => s.Sid === NAMES.sid);
  if (cur && JSON.stringify(cur) === JSON.stringify(want)) say('  already allows this distribution');
  else {
    did('allow the distribution to read sha256/* (other statements kept)');
    if (APPLY) await s3.send(new PutBucketPolicyCommand({ Bucket: BUCKET, Policy: JSON.stringify({ ...policy, Statement: [...policy.Statement.filter((s) => s.Sid !== NAMES.sid), want] }) }));
  }
} else say('  waits for the distribution');

// 8. DNS alias.
say('8. Route 53 alias');
if (dist) {
  did(`point ${DOMAIN} (A and AAAA) at ${dist.DomainName}`);
  if (APPLY) await upsert(['A', 'AAAA'].map((Type) => ({ Name: `${DOMAIN}.`, Type, AliasTarget: { HostedZoneId: CF_ZONE_ID, DNSName: dist.DomainName, EvaluateTargetHealth: false } })), 'Hawkes Gen CDN');
} else say('  waits for the distribution');

// 9. A cost alarm: CloudFront's month-to-date charges (billing metrics; "Receive Billing Alerts" must be on in the account).
say(`9. CloudWatch alarm (CloudFront charges over $${ALARM_USD} this month)`);
const alarms = await cw.send(new DescribeAlarmsCommand({ AlarmNames: [NAMES.alarm] }));
if (alarms.MetricAlarms?.length) say('  found it');
else {
  did(`create alarm ${NAMES.alarm} (visible in CloudWatch; attach an SNS topic there to be emailed)`);
  if (APPLY) await cw.send(new PutMetricAlarmCommand({ AlarmName: NAMES.alarm, AlarmDescription: 'Hawkes Gen CDN: CloudFront month-to-date charges', Namespace: 'AWS/Billing', MetricName: 'EstimatedCharges', Dimensions: [{ Name: 'Currency', Value: 'USD' }, { Name: 'ServiceName', Value: 'AmazonCloudFront' }], Statistic: 'Maximum', Period: 21600, EvaluationPeriods: 1, Threshold: ALARM_USD, ComparisonOperator: 'GreaterThanThreshold', TreatMissingData: 'notBreaching' }));
}

// 10. Gen's setting.
say('10. Gen setting storage.cdn');
const url = `https://${DOMAIN}`;
if (loadSettings().storage.cdn === url) say(`  already ${url}`);
else if (APPLY && dist) {
  const s = loadSettings();
  saveSettings({ storage: { ...s.storage, cdn: url } });
  say(`  set to ${url} in this checkout's settings. On the cloud server run: curl -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"storage":{"bucket":"${BUCKET}","cdn":"${url}"}}' https://gen.hawkesgen.ai/v1/settings`);
} else did(`set storage.cdn to ${url}`);

say(`\nCost: pay-as-you-go, no monthly fee. The free tier covers 1 TB out and 10M requests a month; after that about $0.085/GB and $0.01 per 10,000 HTTPS requests (US, PriceClass_100: US/Canada/Europe edges). S3 to CloudFront transfer is free. The certificate, OAC and policies are free; the Route 53 records cost about $0.40 a month for the alias queries at most, and CloudWatch gives the first 10 alarms free.`);
if (!APPLY) say('Dry run only. Run again with --apply to create it.');
