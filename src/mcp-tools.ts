// The Hawkes Gen MCP tools, shared by the stdio server (src/mcp.ts) and the HTTP endpoint (/mcp in src/api.ts).
// They use the HTTP API through the client they are given: on the server, a client for this service with the
// caller's own API key, so the key's role and projects apply.
//
// Tools stay few and general (list, run, jobs, library, presets, fleet, templates), so they cost little context;
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
        wait: { type: 'boolean', description: 'Wait for it to finish (default true). False returns the job id.' },
        timeout_minutes: { type: 'number', description: 'How long to wait (default 30)' },
      }, ['project']),
      run: async (a) => {
        if (remote) for (const v of Object.values<any>(a.inputs ?? {}).flat()) if (typeof v !== 'string' || !/^(asset|blob):/.test(v)) throw new Error('Over the remote MCP endpoint, inputs must be asset:<id> or blob:<sha> (upload files with POST /v1/blobs first).');
        const job = await gen.submit(a.tool, { project: a.project, params: a.params ?? {}, inputs: a.inputs ?? {}, labels: a.labels, preset: a.preset });
        if (a.wait === false) return summarizeJob(job);
        const done = await gen.wait(job.id, { timeoutMs: (a.timeout_minutes ?? 30) * 60000, throwOnFail: false });
        return withFiles(done, a.save_to);
      },
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
          return { settings: f.settings, servers: f.servers.map((s: any) => ({ id: s.id, state: s.state, ready: s.state === 'running' && s.boot?.stage === 'ready', type: s.type, zone: s.zone, perHour: s.pricePerHour, running: f.busy[s.id] ?? null })), error: f.error };
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
