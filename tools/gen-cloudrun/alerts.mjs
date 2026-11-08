#!/usr/bin/env node
// Cloud Monitoring alerts for Hawkes Gen on Cloud Run (docs/gen-cloudrun.md, "Alerts"). Prints the four alert policies
// (and the three log-based metrics two of them need); creates nothing without --apply.
//
//   node tools/gen-cloudrun/alerts.mjs [--lane live|beta] [--project hawkes-staging] [--region us-east4]
//                                      [--channel <notification channel id or full name>]... [--apply]
//
// 5xx rate        built-in metric run.googleapis.com/request_count, response_code_class 5xx
// instance boots  log-based metric gen_<lane>_boots: the "Hawkes Gen on http://" line each start logs
// event-loop lag  log-based metric gen_<lane>_loop_blocks: the "[lag] event loop blocked" line src/lag.ts logs (>= 500 ms)
// queue depth     log-based metric gen_<lane>_queue_depth: the "[queue-depth] queued=N" line /v1/health logs when jobs wait
// Existing policies and metrics (by name) are left alone, so running it again is safe. Nothing is deleted, ever.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, gcloud, gcloudQuery, die, done, APPLY } from '../unity-cloudrun/common.mjs';

/** The metrics and policies for one lane; pure, so a test can read it. */
export function buildPlan({ lane = 'live', region = 'us-east4', channels = [] } = {}) {
  if (!['live', 'beta'].includes(lane)) throw new Error(`lane is live or beta, not ${lane}`);
  const service = lane === 'beta' ? 'gen-beta' : 'gen';
  const base = `resource.type="cloud_run_revision" AND resource.labels.service_name="${service}"`;
  const m = (name) => `gen_${lane}_${name}`;
  const metrics = [
    { name: m('boots'), description: `Each time ${service} starts an instance (a restart or a new instance)`,
      filter: `${base} AND textPayload:"Hawkes Gen on http://"` },
    { name: m('loop_blocks'), description: `${service}: event loop blocked for 500 ms or more (src/lag.ts)`,
      filter: `${base} AND textPayload:"[lag] event loop blocked"` },
    { name: m('queue_depth'), description: `${service}: jobs waiting in the queue, as /v1/health saw them`,
      filter: `${base} AND textPayload:"[queue-depth] queued="`,
      extractor: 'REGEXP_EXTRACT(textPayload, "queued=(\\\\d+)")', distribution: true },
  ];
  const win = (s) => `${s}s`;
  const policy = (displayName, documentation, condition) => ({
    displayName: `Gen ${lane}: ${displayName}`,
    documentation: { mimeType: 'text/markdown', content: documentation },
    combiner: 'OR',
    conditions: [condition],
    alertStrategy: { autoClose: '1800s' },
    notificationChannels: channels,
    enabled: true,
  });
  const logCount = (metric, label, threshold, seconds) => ({
    displayName: label,
    conditionThreshold: {
      filter: `metric.type="logging.googleapis.com/user/${metric}" AND resource.type="cloud_run_revision"`,
      aggregations: [{ alignmentPeriod: win(seconds), perSeriesAligner: 'ALIGN_SUM', crossSeriesReducer: 'REDUCE_SUM' }],
      comparison: 'COMPARISON_GT', thresholdValue: threshold, duration: '0s', trigger: { count: 1 },
    },
  });
  const policies = [
    policy('5xx rate', `More than 5 server errors in 5 minutes on ${service}. Look at the logs for the service, then \`/v1/health?deep=1\` (owner key).`, {
      displayName: '5xx responses over 5 in 5 min',
      conditionThreshold: {
        filter: `metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision" AND resource.labels.service_name="${service}" AND metric.labels.response_code_class="5xx"`,
        aggregations: [{ alignmentPeriod: '300s', perSeriesAligner: 'ALIGN_SUM', crossSeriesReducer: 'REDUCE_SUM' }],
        comparison: 'COMPARISON_GT', thresholdValue: 5, duration: '0s', trigger: { count: 1 },
      },
    }),
    policy('instance restarts', `${service} started more than 2 instances in 15 minutes: a crash loop, out of memory, or a bad deploy (CI rolls a bad revision back after 3 minutes).`,
      logCount(m('boots'), 'More than 2 boots in 15 min', 2, 900)),
    policy('event-loop lag', `${service}'s event loop was blocked 500 ms or more, 3 times in 10 minutes. \`/v1/health?deep=1\` lists the blocks and the requests around them (loop.blocks).`,
      logCount(m('loop_blocks'), 'More than 3 blocks in 10 min', 3, 600)),
    policy('queue depth', `More than 50 jobs waiting for 10 minutes (the deepest queue /v1/health saw). A GPU provider may be down: see Settings > GPU providers.`, {
      displayName: 'Queue deeper than 50 for 10 min',
      conditionThreshold: {
        filter: `metric.type="logging.googleapis.com/user/${m('queue_depth')}" AND resource.type="cloud_run_revision"`,
        aggregations: [{ alignmentPeriod: '300s', perSeriesAligner: 'ALIGN_DELTA', crossSeriesReducer: 'REDUCE_PERCENTILE_99' }],
        comparison: 'COMPARISON_GT', thresholdValue: 50, duration: '600s', trigger: { count: 1 },
      },
    }),
  ];
  return { service, region, metrics, policies };
}

function main() {
  const project = flag('project', 'hawkes-staging');
  const lane = flag('lane', 'live');
  const region = flag('region', 'us-east4');
  const args = process.argv.slice(2);
  const channels = args.flatMap((a, i) => (a === '--channel' ? [args[i + 1]] : a.startsWith('--channel=') ? [a.slice(10)] : []))
    .map((c) => (c.startsWith('projects/') ? c : `projects/${project}/notificationChannels/${c}`));
  let plan;
  try { plan = buildPlan({ lane, region, channels }); } catch (e) { die(e.message); }
  console.log(`Alerts for ${plan.service} in ${project}\n${channels.length ? `Notify: ${channels.join(', ')}` : 'No notification channel (--channel <id>): the alerts show in the console only.'}\n`);

  console.log('# Log-based metrics');
  const haveMetrics = gcloudQuery(['logging', 'metrics', 'list', `--project=${project}`, '--format=value(name)']) ?? '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-alerts-'));
  for (const mt of plan.metrics) {
    if (haveMetrics.split(/\s+/).includes(mt.name)) { console.log(`  ${mt.name}: exists, left alone`); continue; }
    if (mt.extractor) {
      // A value-extracting metric needs a config file (a distribution of the numbers in the line).
      const f = path.join(tmp, `${mt.name}.json`);
      const cfg = { name: mt.name, description: mt.description, filter: mt.filter, valueExtractor: mt.extractor,
        metricDescriptor: { metricKind: 'DELTA', valueType: 'DISTRIBUTION', unit: '1' },
        bucketOptions: { explicitBuckets: { bounds: [0, 1, 5, 10, 25, 50, 100, 250, 500] } } };
      if (APPLY) fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
      else console.log(JSON.stringify(cfg, null, 2));
      gcloud(['logging', 'metrics', 'create', mt.name, `--config-from-file=${f}`, `--project=${project}`]);
    } else {
      gcloud(['logging', 'metrics', 'create', mt.name, `--description=${mt.description}`, `--log-filter=${mt.filter}`, `--project=${project}`]);
    }
  }

  console.log('\n# Alert policies');
  const havePolicies = gcloudQuery(['alpha', 'monitoring', 'policies', 'list', `--project=${project}`, '--format=value(displayName)']) ?? '';
  for (const p of plan.policies) {
    console.log(`\n${p.displayName}\n  ${p.conditions[0].displayName}\n  ${p.documentation.content}`);
    if (havePolicies.split('\n').includes(p.displayName)) { console.log('  exists, left alone'); continue; }
    const f = path.join(tmp, `${p.displayName.replace(/\W+/g, '-')}.json`);
    if (APPLY) fs.writeFileSync(f, JSON.stringify(p, null, 2));
    gcloud(['alpha', 'monitoring', 'policies', 'create', `--policy-from-file=${f}`, `--project=${project}`]);
  }
  done();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
