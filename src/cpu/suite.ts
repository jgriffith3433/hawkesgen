// The CPU suite (docs/cpu-cloudrun.md): Gen's tools that need no GPU and no API key, only ffmpeg, Pillow, rembg and
// numpy. Each runs on Gen's own machine or, when settings.cpu sends it there, on the gen-cpu Cloud Run service: the
// same tool.run() code either way. The service (server/cpu-cloudrun/server.ts) imports this file, so it must import
// nothing but the tools' own pure modules (no database, no library, no settings).

import type { Tool } from '../tools/types.ts';
import { cutoutTool, frameTool, videoFitTool, tileTool, materialMapsTool, probeTool, splatBuildTool, spriteSheetTool, transformTool } from '../tools/local.ts';
import { composeTool } from '../tools/compose.ts';
import { videoMatteTool, videoCompositeTool, videoControlMixTool } from '../tools/film-video.ts';
import { sheetTool } from '../tools/sheet.ts';

/** How heavy a call is, for the doc's price table and the service's concurrency (a heavy call wants the instance's CPUs). */
export type Weight = 'light' | 'medium' | 'heavy';

export type SuiteTool = { tool: Tool; area: 'image' | 'texture' | 'video' | 'sprite' | '3d' | 'media'; weight: Weight; typicalSeconds: number };

/** Every tool the service can run, with what it is for. typicalSeconds: one ordinary call on 4 vCPUs (docs/cpu-cloudrun.md). */
export const CPU_SUITE: SuiteTool[] = [
  { tool: transformTool, area: 'image', weight: 'light', typicalSeconds: 2 },
  { tool: cutoutTool, area: 'image', weight: 'heavy', typicalSeconds: 20 },
  { tool: frameTool, area: 'image', weight: 'light', typicalSeconds: 2 },
  { tool: sheetTool, area: 'image', weight: 'light', typicalSeconds: 3 },
  { tool: tileTool, area: 'texture', weight: 'light', typicalSeconds: 2 },
  { tool: materialMapsTool, area: 'texture', weight: 'medium', typicalSeconds: 5 },
  { tool: spriteSheetTool, area: 'sprite', weight: 'medium', typicalSeconds: 8 },
  { tool: probeTool, area: 'media', weight: 'light', typicalSeconds: 1 },
  { tool: videoFitTool, area: 'video', weight: 'medium', typicalSeconds: 10 },
  { tool: composeTool, area: 'video', weight: 'heavy', typicalSeconds: 60 },
  { tool: videoMatteTool, area: 'video', weight: 'heavy', typicalSeconds: 30 },
  { tool: videoCompositeTool, area: 'video', weight: 'heavy', typicalSeconds: 40 },
  { tool: videoControlMixTool, area: 'video', weight: 'heavy', typicalSeconds: 30 },
  { tool: splatBuildTool, area: '3d', weight: 'heavy', typicalSeconds: 45 },
];

/** CPU tools that stay on Gen's machine, and why (the doc and GET /v1/cpu say so). */
export const STAYS_LOCAL: Record<string, string> = {
  'file.import': 'it only files a file in the library: nothing to compute',
  'film.gate': 'it orchestrates Claude calls and reads the library',
  'film.plan': 'it orchestrates Claude calls and reads the library',
  'asset.lod': 'its bookkeeping reads and writes the library; only its level making runs on the service (POST /exec)',
};

const byId = new Map(CPU_SUITE.map((s) => [s.tool.id, s]));
/** The suite entry for a tool id, or undefined when the tool can't run on the service. */
export const suiteTool = (id: string) => byId.get(id);
export const inSuite = (id: string) => byId.has(id);

/** The LOD system's two commands the service runs for asset.lod (src/lod.ts): Pillow levels and gltf-transform levels. */
export const EXEC_KINDS = ['lod-images', 'lod-mesh'] as const;
export type ExecKind = (typeof EXEC_KINDS)[number];

/** The suite as Studio and the portal list it: id, title, what it does, inputs, params, area, weight. */
export function describeSuite() {
  return CPU_SUITE.map(({ tool, area, weight, typicalSeconds }) => ({
    id: tool.id, version: tool.version, title: tool.title, description: tool.description, area, weight, typicalSeconds,
    output: tool.output, inputs: tool.inputs, params: tool.params,
  }));
}
