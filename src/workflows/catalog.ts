// ComfyUI's template library and node definitions, cached from a ready GPU
// server in DATA_DIR/comfy-cache so the dashboard can browse and import
// templates even while every server is stopped.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import { comfyEndpoints } from '../providers/comfy/fleet.ts';
import { Comfy } from '../providers/comfy/client.ts';
import { convertUiWorkflow, checkGraph } from './convert.ts';
import { draftManifest, saveWorkflow, listWorkflows, type Manifest } from './registry.ts';
import { GenError } from '../util.ts';

const CACHE = path.join(DATA_DIR, 'comfy-cache');
const TEMPLATES = path.join(CACHE, 'templates');
const THUMBS = path.join(CACHE, 'thumbs');
fs.mkdirSync(TEMPLATES, { recursive: true });
fs.mkdirSync(THUMBS, { recursive: true });

let infoCache: Record<string, any> | null = null;

async function readyComfy() {
  const [ep] = await comfyEndpoints();
  if (!ep) throw new GenError('No GPU server is ready to read ComfyUI from. Start one, or use the cached copy.', { status: 409, kind: 'offline' });
  return new Comfy(ep);
}

/** ComfyUI's node definitions (/object_info), from the cache or a ready server. */
export async function objectInfo({ refresh = false } = {}): Promise<Record<string, any>> {
  const file = path.join(CACHE, 'object_info.json');
  if (!refresh) {
    if (infoCache) return infoCache;
    if (fs.existsSync(file)) return (infoCache = JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  const c = await readyComfy();
  infoCache = await c.json('/object_info');
  fs.writeFileSync(file, JSON.stringify(infoCache));
  return infoCache!;
}

/** Refreshes the cached node definitions and template index from a ready server. */
export async function refreshCatalog() {
  const c = await readyComfy();
  infoCache = await c.json('/object_info');
  fs.writeFileSync(path.join(CACHE, 'object_info.json'), JSON.stringify(infoCache));
  const index = await (await c.request('/templates/index.json')).text();
  fs.writeFileSync(path.join(CACHE, '_templates_index.json'), index);
  return { nodes: Object.keys(infoCache!).length, templates: templates().length };
}

export type TemplateInfo = { name: string; title: string; description: string; category: string; tags: string[]; size: number | null; mediaType: string; openSource: boolean; installed: string | null };

/** The template library: open-source (local model) templates only; cloud API templates are left out. */
export function templates(): TemplateInfo[] {
  const file = path.join(CACHE, '_templates_index.json');
  if (!fs.existsSync(file)) return [];
  const installedBy = new Map<string, string>();
  for (const w of listWorkflows()) if (w.manifest.source?.template) installedBy.set(String(w.manifest.source.template), w.manifest.id);
  const out: TemplateInfo[] = [];
  const seen = new Set<string>();
  for (const cat of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    for (const t of cat.templates ?? []) {
      if (seen.has(t.name) || t.openSource === false || t.name.startsWith('api_')) continue;
      seen.add(t.name);
      out.push({
        name: t.name, title: t.title ?? t.name, description: t.description ?? '', category: `${cat.category ?? ''} / ${cat.title ?? ''}`.replace(/^ \/ /, ''),
        tags: t.tags ?? [], size: t.size ?? null, mediaType: t.mediaType ?? 'image', openSource: t.openSource !== false, installed: installedBy.get(t.name) ?? null,
      });
    }
  }
  return out;
}

/** A template's workflow JSON (cached on first use). */
export async function templateWorkflow(name: string) {
  if (!/^[\w.-]+$/.test(name)) throw new GenError('Bad template name');
  const file = path.join(TEMPLATES, `${name}.json`);
  if (!fs.existsSync(file)) {
    const c = await readyComfy();
    fs.writeFileSync(file, await (await c.request(`/templates/${encodeURIComponent(name)}.json`)).text());
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** A template's thumbnail (cached), or null. */
export async function templateThumb(name: string): Promise<string | null> {
  if (!/^[\w.-]+$/.test(name)) return null;
  for (const ext of ['webp', 'png', 'jpg', 'gif']) {
    const f = path.join(THUMBS, `${name}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  try {
    const c = await readyComfy();
    for (const ext of ['webp', 'png', 'jpg', 'gif']) {
      try {
        const r = await c.request(`/templates/${encodeURIComponent(name)}-1.${ext}`);
        const f = path.join(THUMBS, `${name}.${ext}`);
        fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
        return f;
      } catch {
        // try the next extension
      }
    }
  } catch {
    // no server
  }
  return null;
}

/**
 * Imports a workflow as a tool: a template by name, or a workflow J exported
 * from ComfyUI (UI or API format). Converts it, checks it against the node
 * definitions, drafts the manifest and saves workflows/<folder>/.
 */
export async function importWorkflow(opts: { template?: string; workflow?: any; id: string; title?: string; description?: string; family?: string; overwrite?: boolean }) {
  const info = await objectInfo();
  const t = opts.template ? templates().find((x) => x.name === opts.template) : null;
  if (opts.template && !t) throw new GenError(`No template ${opts.template} (refresh the catalog?)`, { status: 404 });
  const source = opts.template ? await templateWorkflow(opts.template) : opts.workflow;
  if (!source || typeof source !== 'object') throw new GenError('Send a template name or a workflow');
  if (!opts.overwrite && listWorkflows().some((w) => w.manifest.id === opts.id)) throw new GenError(`A tool ${opts.id} already exists`, { status: 409 });
  const conv = convertUiWorkflow(source, info);
  const check = checkGraph(conv.graph, info);
  const problems = [...conv.problems, ...check.problems];
  if (problems.length) throw new GenError(`This workflow can't run on the servers as it is:\n  ${problems.join('\n  ')}`, { status: 422 });
  const manifest: Manifest = draftManifest(opts.id, opts.title ?? t?.title ?? opts.id, opts.description ?? t?.description ?? '', conv.graph, conv.models, info, {
    family: opts.family ?? opts.id,
    source: opts.template ? { template: opts.template, size: t?.size ?? null } : { upload: true },
  });
  const unknownModels = check.missingModels.filter((f) => !conv.models.some((m) => m.file === f));
  const folder = opts.id.replace(/\./g, '-');
  const dir = saveWorkflow(folder, manifest, conv.graph, source);
  return { manifest, dir, unknownModels, note: unknownModels.length ? `No download link for ${unknownModels.join(', ')}: add them to the manifest's models (dir, file, url) or install them on the servers.` : null };
}
