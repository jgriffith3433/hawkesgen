// The Hawkes Gen MCP tools, shared by the stdio server (src/mcp.ts) and the HTTP endpoint (/mcp in src/api.ts).
// They use the HTTP API through the client they are given: on the server, a client for this service with the
// caller's own API key, so the key's role and projects apply.
//
// Tools stay few and general (list, run, jobs, library, entities, presets, fleet, templates), so they cost little context;
// hawkesgen_tools describes the 30+ generation tools when an agent needs them.

import fs from 'node:fs';
import path from 'node:path';
import { makeTools } from './mcp-make.ts';
import { obj, str, type McpTool, type McpServer } from './mcp-core.ts';

export const INSTRUCTIONS = "Hawkes Gen: shared generative AI for the Hawkes Biomedical projects. Use hawkesgen_presets for a project's art direction before generating; GPU tools cost money while servers run. The making tools (generate_image, make_video and the rest) wait up to wait_seconds (default 240); a longer job comes back as state \"running\" with a task_id: call get_task with it until state is \"done\", then download its files.";

/**
 * gen: a HawkesGen client (clients/js/hawkesgen.mjs).
 * remote: the caller is on another machine (the HTTP endpoint): outputs come back as URLs (filesUrl/v1/files/<asset>),
 * and local paths in inputs, save_to and workflow_file mean paths on the server.
 */
/**
 * Labels every job from this MCP server carries (HAWKESGEN_LABELS, a JSON object): Studio gives its agents
 * `{ "studioChange": "c_..." }`, so it can boost a video's jobs while J waits for it (POST /v1/jobs/boost).
 */
function envLabels(): Record<string, string> {
  try {
    const v = JSON.parse(process.env.HAWKESGEN_LABELS ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string').map(([k, x]) => [k, String(x)])) : {};
  } catch {
    return {};
  }
}

export function genMcp(gen: any, { remote = false, filesUrl = '', account, fileLink, uploadLink }: {
  remote?: boolean; filesUrl?: string;
  /** A Gen account's own project: the default project of every tool (mcp-http.ts). */
  account?: string;
  /** A link that downloads an output without a credential (src/links.ts); remote only. */
  fileLink?: (assetId: string, name: string) => string;
  /** A one-time upload link (src/links.ts); remote only. */
  uploadLink?: (filename: string) => string;
} = {}): McpServer {
  function summarizeJob(j: any) {
    return {
      id: j.id, tool: j.tool, project: j.project, status: j.status, detail: j.detail, error: j.error ?? undefined,
      outputs: j.outputs, result: j.result ?? undefined, cost: j.cost, gpu_seconds: j.gpu_seconds,
    };
  }

  async function withFiles(job: any, saveTo?: string) {
    const out = summarizeJob(job);
    const files: string[] = [];
    if (remote && saveTo) throw new Error('save_to only works with the local MCP server (bin/hawkesgen-mcp.mjs). Over HTTP, download the output URLs instead.');
    for (const o of job.outputs ?? []) {
      if (remote) {
        files.push(fileLink ? fileLink(o.asset, `${job.tool.replace(/\./g, '-')}-${o.title ? String(o.title).replace(/[^\w.-]+/g, '_') : o.asset}`) : `${filesUrl}/v1/files/${o.asset}`);
        continue;
      }
      const a = await gen.asset(o.asset);
      if (saveTo) {
        const name = `${job.tool.replace(/\./g, '-')}-${o.seed ?? o.asset}${o.title ? `-${String(o.title).replace(/[^\w.-]+/g, '_')}` : ''}${path.extname(a.path)}`;
        files.push(await gen.download(o.asset, path.join(saveTo, name)));
      } else files.push(a.path);
    }
    return { ...out, files };
  }

  // ------------------------------------------------------------ results as tasks (the friendly tools and get_task)

  const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'model/gltf-binary': '.glb', 'application/json': '.json', 'application/zip': '.zip' };
  /** A finished job's outputs as {url, filename, mime, title, asset} (an editor saves each file by its own name). */
  async function fileObjects(job: any) {
    const out: any[] = [];
    for (const o of job.outputs ?? []) {
      const stem = `${job.tool.replace(/\./g, '-')}-${o.title ? String(o.title).replace(/[^\w.-]+/g, '_') : o.asset}`;
      const ext = EXT[o.mime] ?? '';
      const filename = stem.toLowerCase().endsWith(ext) ? stem : `${stem}${ext}`;
      const url = remote ? (fileLink ? fileLink(o.asset, filename) : `${filesUrl}/v1/files/${o.asset}`) : (await gen.asset(o.asset)).path;
      out.push({ url, filename, mime: o.mime ?? null, title: o.title ?? null, asset: o.asset });
    }
    return out;
  }
  const running = (j: any) => ({
    state: 'running', task_id: j.id, tool: j.tool, status: j.status, detail: j.detail ?? null,
    progress: { message: j.detail ?? (j.status === 'queued' ? 'Waiting for a free server' : 'Working') },
    next: 'Call get_task with this task_id (wait_seconds up to 60) until state is "done".',
  });
  /** Waits up to wait_seconds (default 240: under an editor's HTTP timeout) for a job; a failed one is an error. */
  async function settle(job: any, waitSeconds?: unknown, fallback = 240) {
    const s = waitSeconds === undefined || waitSeconds === null || waitSeconds === '' ? fallback : Number(waitSeconds);
    const ms = Math.max(0, Math.min(1800, Number.isFinite(s) ? s : fallback)) * 1000;
    let j: any;
    try {
      j = await gen.wait(job.id, { timeoutMs: ms, throwOnFail: false });
    } catch (e: any) {
      if (e?.kind === 'timeout' && e.job) return running(e.job);
      throw e;
    }
    if (j.status !== 'done') throw new Error(j.status === 'cancelled' ? `${j.tool} was cancelled` : `${j.tool} failed: ${j.error ?? j.detail ?? 'no reason given'}`);
    return { state: 'done', task_id: j.id, ...summarizeJob(j), files: await fileObjects(j) };
  }

  const tools: McpTool[] = [
    {
      name: 'get_task',
      description: 'A task a tool started that was still running (state "running"): waits up to wait_seconds, then returns it again: still running, or done with its files.',
      inputSchema: obj({ task_id: str('The task_id a tool returned'), wait_seconds: { type: 'number', description: 'How long to wait for it (0-60, default 5)' } }, ['task_id']),
      run: async (a) => {
        const id = String(a.task_id ?? '');
        if (!/^[\w-]{1,80}$/.test(id)) throw new Error('task_id is the id a tool returned');
        return settle(await gen.job(id), Math.min(60, Math.max(0, Number(a.wait_seconds ?? 5) || 0)), 5);
      },
    },
    {
      name: 'hawkesgen_tools',
      description: 'List Hawkes Gen generation tools (images, video, 3D, music, voice, sound, Claude, local image tools) with their inputs and params. Give a tool id for its full details.',
      inputSchema: obj({ tool: str('A tool id for full details (optional)'), search: str('Filter by text (optional)') }),
      run: async ({ tool, search }) => {
        if (tool) return gen.tool(tool);
        const tools = await gen.tools();
        const q = (search ?? '').toLowerCase();
        return tools
          .filter((t: any) => !q || `${t.id} ${t.title} ${t.description}`.toLowerCase().includes(q))
          .map((t: any) => ({ id: t.id, title: t.title, provider: t.provider, output: t.output, inputs: Object.keys(t.inputs), params: Object.fromEntries(Object.entries<any>(t.params).filter(([, p]) => !p.advanced).map(([k, p]) => [k, `${p.type}${p.required ? ' (required)' : ''}${p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ''}`])), description: t.description }));
      },
    },
    {
      name: 'hawkesgen_run',
      description: 'Run a Hawkes Gen tool and wait for it. Inputs are local file paths, asset:<id> or blob:<sha>. Use a preset ("name" in the project, or "project/name") to apply that project\'s art direction. GPU tools use the shared AWS fleet (cents per run on a running server; if none is running the job waits, so tell the user). Returns the output files (library paths, or copies in save_to; over the remote MCP endpoint, URLs that need the same API key or the website login, and inputs must be asset:<id> or blob:<sha>).',
      inputSchema: obj({
        tool: str('Tool id, e.g. image.generate (optional with a preset that names one)'),
        project: str('Project name, e.g. doseofdestruction, sickofit, phorigins'),
        params: { type: 'object', description: 'Tool params (see hawkesgen_tools)' },
        inputs: { type: 'object', description: 'Input name -> file path / asset:<id> (or a list)' },
        preset: str('Preset name (optional)'),
        labels: { type: 'object', description: 'Project meaning to attach (fighter, level...)' },
        save_to: str('Folder to copy the outputs into (optional)'),
        reuse: { type: 'boolean', description: 'Hand back a finished job of exactly this recipe (any seed) from the library instead of paying again (default true; false for a new take)' },
        wait: { type: 'boolean', description: 'Wait for it to finish (default true). False returns the job id.' },
        timeout_minutes: { type: 'number', description: 'How long to wait (default 30)' },
        wait_for_server: { type: 'boolean', description: 'Wait even when no GPU server is running (default false: return at once, queued)' },
      }, account ? [] : ['project']),
      run: async (a) => {
        if (remote) for (const v of Object.values<any>(a.inputs ?? {}).flat()) if (typeof v !== 'string' || !/^(asset|blob):/.test(v)) throw new Error('Over the remote MCP endpoint, inputs must be asset:<id> or blob:<sha> (upload files with POST /v1/blobs first).');
        const job = await gen.submit(a.tool, { project: a.project ?? account, params: a.params ?? {}, inputs: a.inputs ?? {}, labels: { ...envLabels(), ...(a.labels ?? {}) }, preset: a.preset, reuse: a.reuse !== false });
        if (a.wait === false) return summarizeJob(job);
        // No GPU server running: the job waits in the queue until J starts one. Say so now instead of blocking.
        const first = job.status === 'queued' ? await new Promise((r) => setTimeout(r, 2000)).then(() => gen.job(job.id)) : job;
        if (first.status === 'queued' && /no GPU server is ready/i.test(first.detail ?? '') && !a.wait_for_server) {
          return { ...summarizeJob(first), waitingForServer: true, note: 'Queued: no GPU server is running. Only J can start one (agents and Talk cannot). Tell J (studio_inbox ask, with hawkesgen_estimate\'s price); the job runs by itself once a server is up. Check it later with hawkesgen_job.' };
        }
        const done = await gen.wait(job.id, { timeoutMs: (a.timeout_minutes ?? 30) * 60000, throwOnFail: false });
        return withFiles(done, a.save_to);
      },
    },
    {
      name: 'hawkesgen_estimate',
      description: 'What a batch of generation would cost before running it: GPU hours (from past jobs of each tool), model loads, server boots, API costs, dollars, wall time, and the idle tail if servers are left on. Items are { tool | preset, params, count, label }; asset.make items expand into their steps and candidates. Show J this before starting servers or a big batch.',
      inputSchema: obj({
        project: str('Project name'),
        items: { type: 'array', items: { type: 'object' }, description: '[{ tool | preset, params, count, label }]' },
        servers: { type: 'number', description: 'At most this many servers (default: the fleet cap)' },
      }, ['project', 'items']),
      run: async (a) => gen.estimate(a.items, { project: a.project, servers: a.servers }),
    },
    {
      name: 'hawkesgen_job',
      description: 'A job\'s status and outputs (optionally wait for it, or copy its outputs into a folder).',
      inputSchema: obj({ id: str('Job id (j_...)'), wait: { type: 'boolean' }, save_to: str('Folder to copy outputs into (optional)') }, ['id']),
      run: async ({ id, wait, save_to }) => withFiles(wait ? await gen.wait(id, { throwOnFail: false }) : await gen.job(id), save_to),
    },
    {
      name: 'hawkesgen_jobs',
      description: 'Recent jobs, newest first.',
      inputSchema: obj({ project: str('Filter by project (optional)'), status: str('queued, running, done, failed or cancelled (comma separated, optional)'), limit: { type: 'number' } }),
      run: async ({ project, status, limit }) => (await gen.jobs({ ...(project ? { project } : {}), ...(status ? { status } : {}), limit: String(limit ?? 20) })).map(summarizeJob),
    },
    {
      name: 'hawkesgen_cancel',
      description: 'Cancel a queued or running job.',
      inputSchema: obj({ id: str('Job id') }, ['id']),
      run: async ({ id }) => summarizeJob(await gen.cancel(id)),
    },
    {
      name: 'hawkesgen_library',
      description: 'Search everything Hawkes Gen has made (all projects): usable generative assets (images, videos, audio, 3D, and the CC0 motion library: Quaternius clips with name, tags such as locomotion/melee/hit/death/idle, duration, loop). Playtest outputs (playtest.run recordings, screenshots, reports) are excluded by default unless playtest: true is passed. A motion clip\'s id is motion:<pack>/<name> (motion:ual1/Walk_Loop); use that as a file input. tool "motion.library" lists the clips.',
      inputSchema: obj({ search: str('Text in titles, labels or prompts'), project: str('Project'), kind: str('image, video, audio, mesh, text'), starred: { type: 'boolean' }, playtest: { type: 'boolean', description: 'True to list only playtest outputs (default false: excludes playtest.run)' }, limit: { type: 'number' } }),
      run: async (a) => {
        const r = await gen.assets({ ...(a.search ? { q: a.search } : {}), ...(a.project ? { project: a.project } : {}), ...(a.kind ? { kind: a.kind } : {}), ...(a.starred ? { starred: '1' } : {}), ...(a.playtest ? { playtest: '1' } : {}), limit: String(a.limit ?? 30) });
        return { total: r.total, items: r.items.map((x: any) => ({ id: x.id, kind: x.kind, project: x.project, tool: x.tool, title: x.title, labels: x.labels, tags: x.tags?.length ? x.tags : undefined, duration: x.meta?.duration, loop: x.meta?.loop, path: String(x.id).startsWith('motion:') ? x.id : (remote ? `${filesUrl}/v1/files/${x.id}` : x.path), prompt: x.recipe?.params?.prompt, created: new Date(x.created).toISOString() })) };
      },
    },
    // The Gen app's editor (src/editor.ts): the same projects the person edits at hawkesgen.ai, so Claude anywhere
    // can cut, arrange and generate into them; the app shows the changes.
    {
      name: 'hawkesgen_editor',
      description:
        'Timeline scenes: video, image and audio (the Gen app\'s timeline: tracks top first, a higher one drawing over the ones below; any clip on any track; a magnetic track plays its clips back to back). ' +
        'Without id: list video projects. With id: the scene (its tracks, and every clip: id, track, start, in/out of its source, asset or the job it waits on, placement). ' +
        'create: true makes a new one (title). Change a project with hawkesgen_editor_apply.',
      inputSchema: obj({ id: str('Project id ep_... (optional)'), create: { type: 'boolean' }, title: str('Title for a new project'), project: str('Library project (default: your account\'s)') }),
      run: async (a) => {
        if (a.create) return gen.request('/editor/projects', { method: 'POST', body: { title: a.title, ...(a.project ? { project: a.project } : {}) } });
        if (a.id) return gen.request(`/editor/projects/${a.id}`);
        return gen.request(`/editor/projects${a.project ? `?project=${encodeURIComponent(a.project)}` : ''}`);
      },
    },
    {
      name: 'hawkesgen_editor_apply',
      description:
        'Edits a video editor project, in order (an edit that fails is reported and the rest still apply). Ops: ' +
        'add {track, asset, in, out, start | index | after}; generate {tool, params, inputs ("clip:c_..." for a clip\'s file), place: {track, after|start} | {replace: clipId} | {library: true}, label} ' +
        '(a waiting clip shows until the job ends; costs credits); trim {id, in, out | length}; split {id, at}; move {id, index | after | start}; delete {id}; ' +
        'deleteRange {start, end, tracks}; set {id, volume, speed, muted, transition, transitionSeconds, zoom, text}; text {text, start, end}; settings {width, height, fps, title}. ' +
        'Times in seconds (in/out: of the clip\'s source; start/at: on the timeline).',
      inputSchema: obj({ id: str('Project id ep_...'), ops: { type: 'array', items: { type: 'object' }, description: 'The edits' } }, ['id', 'ops']),
      run: async (a) => {
        const r = await gen.request(`/editor/projects/${a.id}/apply`, { method: 'POST', body: { ops: a.ops } });
        return { results: r.results, version: r.project.version, clips: r.project.doc.clips };
      },
    },
    {
      name: 'hawkesgen_editor_ask',
      description: 'Asks a project\'s AI editor (on the account\'s own Claude) to do something in words, with an optional selection ({clips: [ids], range: {start, end}, playhead}). Returns what it said and did; costly generation comes back as `proposed` (apply those ops with hawkesgen_editor_apply to run them).',
      inputSchema: obj({ id: str('Project id ep_...'), say: str('What to do'), selection: { type: 'object' } }, ['id', 'say']),
      run: async (a) => {
        const r = await gen.request(`/editor/projects/${a.id}/assistant`, { method: 'POST', body: { messages: [{ role: 'user', text: a.say }], selection: a.selection ?? {} } });
        return { say: r.say, results: r.results, proposed: r.proposed, version: r.project.version };
      },
    },
    {
      name: 'hawkesgen_entities',
      description:
        'The library\'s structure, shared by every product: entities (a fighter, a stage, a set, a shot: "doseofdestruction/break") with named slots ' +
        '(concept, side, pose/air, clip/jab, model, animation/walk) and every version of each slot (takes, the current one, old, discarded; with notes ' +
        'and what each was made from). Without id: list entities. With id: one entity and its slots. With id and slot: that slot\'s history.',
      inputSchema: obj({ id: str('Entity id, project/slug (optional)'), slot: str('Slot name with id (optional)'), project: str('Project, to list'), kind: str('character, stage, prop, shot... to list'), search: str('Text to find, to list') }),
      run: async (a) => {
        const view = (v: any) => v && { id: v.id, n: v.n, status: v.status, note: v.note || undefined, by: v.by || undefined, asset: v.asset, kind: v.file?.kind, prompt: v.file?.prompt ?? undefined, made_from: v.made_from?.length ? v.made_from.map((m: any) => m.slot ? `${m.entity} ${m.slot} v${m.n}` : m.asset) : undefined, file: remote ? `${filesUrl}/v1/files/${v.asset}` : undefined, created: new Date(v.created).toISOString() };
        if (a.id && a.slot) return { entity: a.id, slot: a.slot, versions: (await gen.slot(a.id, a.slot)).versions.map(view) };
        if (a.id) {
          const e = await gen.entity(a.id);
          return { ...e, slots: Object.fromEntries(Object.entries<any>(e.slots).map(([k, s]) => [k, { current: view(s.current), takes: s.takes, versions: s.versions }])) };
        }
        const r = await gen.entities({ ...(a.project ? { project: a.project } : {}), ...(a.kind ? { kind: a.kind } : {}), ...(a.search ? { q: a.search } : {}), limit: '200' });
        return { total: r.total, items: r.items.map((e: any) => ({ id: e.id, kind: e.kind, name: e.name, slots: Object.fromEntries(Object.entries<any>(e.slots).map(([k, s]) => [k, s.current ? `v${s.current.n}${s.takes ? ` (+${s.takes} takes)` : ''}` : `${s.takes} takes, none picked`])) })) };
      },
    },
    {
      name: 'hawkesgen_entity_edit',
      description:
        'Change the library: create or update an entity (create with project, name, kind; data is merged: canon, look, slots.<slot>.brief/make), file a ' +
        'file into a slot (file: a path on this machine, asset:<id> or blob:<sha>), pick a version as current, discard or restore one, or note on it. ' +
        'Picking changes what products use: do it when the user chose, not on your own.',
      inputSchema: obj({
        action: str('create, update, add, pick, discard, restore or note'), id: str('Entity id (project/slug)'), project: str('create: project'), name: str('create/update: name'),
        kind: str('create/update: kind'), data: { type: 'object', description: 'create/update: data to merge' }, slot: str('add: slot'), file: str('add: the file'),
        version: str('pick/discard/restore/note: version id (v_...)'), note: str('add/pick/note: the note'),
      }, ['action']),
      run: async (a) => {
        if (a.action === 'create') return gen.createEntity({ project: a.project, name: a.name, kind: a.kind, data: a.data, ...(a.id ? { slug: String(a.id).split('/').pop() } : {}) });
        if (a.action === 'update') return gen.updateEntity(a.id, { name: a.name, kind: a.kind, data: a.data });
        if (a.action === 'add') {
          if (remote && a.file && !/^(asset|blob):/.test(a.file)) throw new Error('Over HTTP, file must be asset:<id> or blob:<sha256>');
          return gen.addVersion(a.id, a.slot, a.file, { note: a.note });
        }
        if (a.action === 'pick') return gen.pick(a.version, a.note);
        if (a.action === 'discard') return gen.discard(a.version);
        if (a.action === 'restore') return gen.restore(a.version);
        if (a.action === 'note') return gen.note(a.version, a.note ?? '');
        throw new Error('action is create, update, add, pick, discard, restore or note');
      },
    },
    {
      name: 'hawkesgen_entity_make',
      description:
        'Make new takes for an entity\'s slot (they land in the slot when the job ends). With feedback and revise: true, edits the current version with ' +
        'the feedback ("make the visor bigger"). Without make, the slot\'s own recipe is used (the entity\'s data.slots.<slot>.make, else the project\'s ' +
        'kinds in its presets). make: { tool | preset | steps, params, inputs, candidates, pick, pickAt, saves }; inputs can say "slot:./side". GPU work ' +
        'costs money: price big batches with hawkesgen_estimate first.',
      inputSchema: obj({ id: str('Entity id'), slot: str('Slot'), feedback: str('What to change'), revise: { type: 'boolean', description: 'Edit the current version with the feedback' }, make: { type: 'object' }, count: { type: 'number' }, wait: { type: 'boolean', description: 'Wait for the job (default true)' } }, ['id', 'slot']),
      run: async (a) => {
        const job = a.revise ? await gen.revise(a.id, a.slot, a.feedback, { count: a.count }) : await gen.make(a.id, a.slot, { make: a.make, feedback: a.feedback, count: a.count });
        if (a.wait === false) return summarizeJob(job);
        const done = await gen.wait(job.id, { throwOnFail: false });
        return { job: summarizeJob(done), takes: (await gen.slot(a.id, a.slot)).versions.filter((v: any) => v.job === done.id).map((v: any) => ({ id: v.id, n: v.n, asset: v.asset })) };
      },
    },
    {
      name: 'hawkesgen_entity_judge',
      description:
        "Claude picks the best version of an entity's slot: the current one against its takes (newest first), with the entity's on-model " +
        'references, look, canon and the art direction (videos judged by three frames). apply (default true) makes the winner current with the ' +
        "reason as its note; retire moves the takes that lost to old so the slot stops waiting. Cents per call (Claude only, no GPU). A person can always pick again.",
      inputSchema: obj({ id: str('Entity id (project/slug)'), slot: str('Slot'), criteria: str('What makes a version the best (optional)'), apply: { type: 'boolean', description: 'Make the winner current (default true)' }, retire: { type: 'boolean', description: 'Move the losing takes to old' }, max: { type: 'number', description: 'At most this many candidates (default 6)' } }, ['id', 'slot']),
      run: async (a) => {
        const job = await gen.submit('library.judge', { project: String(a.id).split('/')[0], params: { entity: a.id, slot: a.slot, criteria: a.criteria, apply: a.apply, retire: a.retire, max: a.max } });
        const done = await gen.wait(job.id, { throwOnFail: false });
        return { job: summarizeJob(done), result: done.result };
      },
    },
    {
      name: 'hawkesgen_presets',
      description: 'A project\'s art direction: its style line and named presets (tool + prompt template + params). Without a project, lists every project\'s presets.',
      inputSchema: obj({ project: str('Project (optional)') }),
      run: async ({ project }) => (project ? gen.request(`/presets/${project}`) : gen.request('/presets')),
    },
    {
      name: 'hawkesgen_fleet',
      description: 'GPU fleet status: servers, which are ready, what each is running and costs per hour. start, stop and stop-all need the owner key (J\'s): Talk and agents get "This needs the owner role", so don\'t try them there; ask J instead (studio_inbox ask, with hawkesgen_estimate\'s price). An approval of the work is not a key. quota shows a region\'s GPU quota (vCPUs of "Running On-Demand G and VT instances") and its increase requests (PENDING, CASE_OPENED, APPROVED, DENIED...); request-quota asks AWS for more (free, launches nothing; owner key too). machines: every machine Gen runs (GPU servers, build server, playtester) with CPU, memory, GPU, disk, network, idle time and what needs action (alerts); free, starts nothing.',
      inputSchema: obj({ action: str('Optional: start, stop, access (refresh IP), stop-all, quota, request-quota, machines'), id: str('Server id for start/stop'), region: str('Region for quota/request-quota (default us-east-1)'), value: { type: 'number', description: 'request-quota: the vCPUs wanted in total (e.g. 16 = two g6e.xlarge)' }, confirm: { type: 'boolean', description: 'Required true for start (it costs money). Only after the user agreed.' } }),
      run: async ({ action, id, region, value, confirm }) => {
        if (!action) {
          const f = await gen.fleet();
          const elevenlabsBilling = (await gen.health().catch(() => null))?.elevenlabsBilling;
          return { elevenlabsBilling, settings: f.settings, servers: f.servers.map((s: any) => ({ id: s.id, state: s.state, ready: s.state === 'running' && s.boot?.stage === 'ready', stage: s.boot?.stage ?? null, stuck: s.stuck ?? null, installUnfinished: s.unfinished ?? null, type: s.type, zone: s.zone, perHour: s.pricePerHour, running: f.busy[s.id] ?? null })), error: f.error };
        }
        if (action === 'machines') return gen.request('/machines?live=1');
        if (action === 'quota') return gen.request(`/fleet/quota?region=${encodeURIComponent(region || 'us-east-1')}`);
        if (action === 'request-quota') return gen.request('/fleet/quota', { method: 'POST', body: { region: region || 'us-east-1', value } });
        if (!['start', 'stop', 'access', 'stop-all'].includes(action)) throw new Error('action must be start, stop, access, stop-all, quota, request-quota or machines');
        return gen.fleetAction(action, { id, confirm: confirm === true });
      },
    },
    {
      name: 'hawkesgen_templates',
      description: 'Browse ComfyUI\'s template library (open-source models) that can be imported as new Hawkes Gen tools.',
      inputSchema: obj({ search: str('Text to find (e.g. "upscale", "3d", "music")') }),
      run: async ({ search }) => (await gen.request(`/comfy/templates${search ? `?q=${encodeURIComponent(search)}` : ''}`)).templates.slice(0, 40),
    },
    {
      name: 'hawkesgen_import_workflow',
      description: 'Add a new tool from a ComfyUI template (by name) or a ComfyUI workflow JSON file (UI or API format). It converts it, finds its inputs, prompts and seeds, and records its model download links. Review the result with hawkesgen_tools.',
      inputSchema: obj({ id: str('New tool id, area.name (e.g. image.relight)'), template: str('Template name from hawkesgen_templates'), workflow_file: str('Path to an exported ComfyUI workflow .json'), title: str('Title'), description: str('Description') }, ['id']),
      run: async (a) => gen.request('/workflows/import', { method: 'POST', body: { id: a.id, template: a.template, workflow: a.workflow_file ? (remote ? (() => { throw new Error('workflow_file only works with the local MCP server; use a template over HTTP.'); })() : JSON.parse(fs.readFileSync(a.workflow_file, 'utf8'))) : undefined, title: a.title, description: a.description } }),
    },
  ];

  // The friendly tools (src/mcp-make.ts): what the app's Create tab makes, by plain name, run as the caller.
  tools.push(...makeTools({ gen, account, remote, uploadLink, finish: (job: any, a: any) => settle(job, a?.wait_seconds) }));
  return { name: 'hawkesgen', version: '0.4.0', instructions: INSTRUCTIONS, tools };
}
