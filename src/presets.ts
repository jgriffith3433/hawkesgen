// Presets: each project's art direction, kept as data in presets/<project>.json
// so J, the dashboard and agents can all edit it.
//
//   {
//     "project": "sickofit",
//     "title": "Sick Of It",
//     "style": "Dark fantasy video game character art: painterly...",
//     "negative": "text, watermark",
//     "presets": {
//       "enemy": {
//         "tool": "image.generate",
//         "description": "A new enemy, full body, side view, on green for keying",
//         "prompt": "{prompt}. Full-body side profile facing right. {style} Plain flat pure green background.",
//         "params": { "width": 1024, "height": 1024 }
//       }
//     }
//   }
//
// A job names one as "preset": "enemy" (in its own project) or
// "sickofit/enemy". The preset's tool is used if the job gives none, its params
// fill in what the job leaves out, its prompt template wraps the job's prompt
// ({prompt}, {style}), and the project's negative is added to the tool's
// negative. The job keeps the final params, so its recipe is exact.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';
import { GenError } from './util.ts';

export const PRESETS_DIR = path.join(ROOT, 'presets');

export type Preset = { tool?: string; description?: string; prompt?: string; negative?: string; params?: Record<string, unknown>; inputs?: Record<string, unknown> };
export type ProjectPresets = { project: string; title?: string; style?: string; negative?: string; notes?: string; presets: Record<string, Preset>; kinds?: Record<string, any> };

/** Kinds every project has (presets/shared/kinds.json: character3d). A project's own kinds add to them and replace one
 * of the same name. */
export function sharedKinds(): Record<string, any> {
  const f = path.join(PRESETS_DIR, 'shared', 'kinds.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

const withShared = (p: ProjectPresets): ProjectPresets => {
  const shared = sharedKinds();
  delete shared._about;
  return { ...p, kinds: { ...shared, ...(p.kinds ?? {}) } };
};

export function listPresets(): ProjectPresets[] {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json')).map((f) => withShared(JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8'))));
}

export function getProjectPresets(project: string): ProjectPresets | null {
  const f = path.join(PRESETS_DIR, `${project}.json`);
  return fs.existsSync(f) ? withShared(JSON.parse(fs.readFileSync(f, 'utf8'))) : null;
}

export function saveProjectPresets(p: ProjectPresets) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(p.project ?? '')) throw new GenError('presets need a project name');
  if (!p.presets || typeof p.presets !== 'object') throw new GenError('presets must be an object of named presets');
  // The shared kinds come with every read; a project file keeps only its own (and its changes to a shared one).
  if (p.kinds && typeof p.kinds === 'object') {
    const shared = sharedKinds();
    const own = Object.fromEntries(Object.entries(p.kinds).filter(([k, v]) => !(k in shared) || JSON.stringify(v) !== JSON.stringify(shared[k])));
    p = { ...p, kinds: own };
    if (!Object.keys(own).length) delete p.kinds;
  }
  fs.mkdirSync(PRESETS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PRESETS_DIR, `${p.project}.json`), JSON.stringify(p, null, 2));
  return withShared(p);
}

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '').replace(/\s+([.,])/g, '$1').replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim();

/**
 * Applies a preset to a job spec: returns the tool, params and inputs to use.
 * name is "preset" (in the job's project) or "project/preset".
 */
export function applyPreset(spec: { tool?: string; project: string; params?: Record<string, any>; inputs?: Record<string, any>; preset?: string }, toolParams: (toolId: string) => Record<string, any> | null) {
  if (!spec.preset) return { tool: spec.tool, params: spec.params ?? {}, inputs: spec.inputs ?? {}, preset: null };
  const [proj, name] = spec.preset.includes('/') ? spec.preset.split('/', 2) : [spec.project, spec.preset];
  const pp = getProjectPresets(proj);
  const preset = pp?.presets?.[name];
  if (!pp || !preset) throw new GenError(`No preset ${proj}/${name}`, { status: 404 });
  const tool = spec.tool ?? preset.tool;
  if (!tool) throw new GenError(`Preset ${proj}/${name} names no tool; give one`);
  const accepts = toolParams(tool) ?? {};
  const params: Record<string, any> = { ...(preset.params ?? {}), ...(spec.params ?? {}) };
  const vars = { style: pp.style ?? '', prompt: String(spec.params?.prompt ?? preset.params?.prompt ?? '') };
  if (preset.prompt && 'prompt' in accepts) params.prompt = fill(preset.prompt, vars);
  else if (typeof params.prompt === 'string' && params.prompt.includes('{')) params.prompt = fill(params.prompt, vars);
  const negative = [params.negative, preset.negative, pp.negative].filter((s) => typeof s === 'string' && s.trim()).join(', ');
  if (negative && 'negative' in accepts) params.negative = negative;
  return { tool, params, inputs: { ...(preset.inputs ?? {}), ...(spec.inputs ?? {}) }, preset: `${proj}/${name}` };
}
