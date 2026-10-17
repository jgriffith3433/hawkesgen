// The Hawkes Gen MCP tools, shared by the stdio server (src/mcp.ts) and the HTTP endpoint (/mcp in src/api.ts).
// They use the HTTP API through the client they are given: on the server, a client for this service with the
// caller's own API key, so the key's role and projects apply.
//
// Tools stay few and general (list, run, jobs, library, entities, presets, fleet, templates), so they cost little context;
// hawkesgen_tools describes the 30+ generation tools when an agent needs them.

import fs from 'node:fs';
import path from 'node:path';
import { obj, str, type McpTool, type McpServer } from './mcp-core.ts';

export const INSTRUCTIONS = "Hawkes Gen: shared generative AI for the Hawkes Biomedical projects. Use hawkesgen_presets for a project's art direction before generating; GPU tools cost money while servers run.";

/**
 * gen: a HawkesGen client (clients/js/hawkesgen.mjs).
 * remote: the caller is on another machine (the HTTP endpoint): outputs come back as URLs (filesUrl/v1/files/<asset>),
 * and local paths in inputs, save_to and workflow_file mean paths on the server.
 */
export function genMcp(gen: any, { remote = false, filesUrl = '' }: { remote?: boolean; filesUrl?: string } = {}): McpServer {
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
        files.push(`${filesUrl}/v1/files/${o.asset}`);
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

  const tools: McpTool[] = [
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
      }, ['project']),
      run: async (a) => {
        if (remote) for (const v of Object.values<any>(a.inputs ?? {}).flat()) if (typeof v !== 'string' || !/^(asset|blob):/.test(v)) throw new Error('Over the remote MCP endpoint, inputs must be asset:<id> or blob:<sha> (upload files with POST /v1/blobs first).');
        const job = await gen.submit(a.tool, { project: a.project, params: a.params ?? {}, inputs: a.inputs ?? {}, labels: a.labels, preset: a.preset, reuse: a.reuse !== false });
        if (a.wait === false) return summarizeJob(job);
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
      description: 'Search everything Hawkes Gen has made (all projects): images, videos, audio, 3D. Returns asset ids and local paths; use an asset as an input with asset:<id>.',
      inputSchema: obj({ search: str('Text in titles, labels or prompts'), project: str('Project'), kind: str('image, video, audio, mesh, text'), starred: { type: 'boolean' }, limit: { type: 'number' } }),
      run: async (a) => {
        const r = await gen.assets({ ...(a.search ? { q: a.search } : {}), ...(a.project ? { project: a.project } : {}), ...(a.kind ? { kind: a.kind } : {}), ...(a.starred ? { starred: '1' } : {}), limit: String(a.limit ?? 30) });
        return { total: r.total, items: r.items.map((x: any) => ({ id: x.id, kind: x.kind, project: x.project, tool: x.tool, title: x.title, labels: x.labels, path: remote ? `${filesUrl}/v1/files/${x.id}` : x.path, prompt: x.recipe?.params?.prompt, created: new Date(x.created).toISOString() })) };
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
      description: 'GPU fleet status: servers, which are ready, what each is running and costs per hour. Starting or launching costs money: only with the user\'s OK, via action + confirm.',
      inputSchema: obj({ action: str('Optional: start, stop, access (refresh IP), stop-all'), id: str('Server id for start/stop'), confirm: { type: 'boolean', description: 'Required true for start (it costs money). Only after the user agreed.' } }),
      run: async ({ action, id, confirm }) => {
        if (!action) {
          const f = await gen.fleet();
          return { settings: f.settings, servers: f.servers.map((s: any) => ({ id: s.id, state: s.state, ready: s.state === 'running' && s.boot?.stage === 'ready', stage: s.boot?.stage ?? null, stuck: s.stuck ?? null, installUnfinished: s.unfinished ?? null, type: s.type, zone: s.zone, perHour: s.pricePerHour, running: f.busy[s.id] ?? null })), error: f.error };
        }
        if (!['start', 'stop', 'access', 'stop-all'].includes(action)) throw new Error('action must be start, stop, access or stop-all');
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

  return { name: 'hawkesgen', version: '0.3.0', instructions: INSTRUCTIONS, tools };
}
