// Every tool Hawkes Gen offers. Add new ones here.

import type { Tool } from './types.ts';
import { imageEditTool, imagePaintTool, videoI2vTool, videoAnimateTool, comfyGraphTool } from './comfy.ts';
import { cutoutTool, frameTool, videoFitTool, tileTool, materialMapsTool, probeTool, importTool, splatBuildTool } from './local.ts';
import { voiceTool, sfxTool, voiceDesignTool, voiceSaveTool, llmTextTool, llmJsonTool } from './api.ts';
import { loadWorkflows, listWorkflows } from '../workflows/registry.ts';
import { workflowTool } from '../workflows/tool.ts';
import { unityBuild, unityTest } from './build.ts';
import { playtestRunTool, playtestReviewTool } from './playtest.ts';
import { assetMakeTool } from './pipeline.ts';
import { libraryJudgeTool } from './judge.ts';
import { loraTrainTool, imageCharacterTool } from './lora.ts';
import { blenderRenderTool } from './blender.ts';
import { composeTool } from './compose.ts';
import { filmGateTool, filmPlanTool } from './film.ts';
import { videoMatteTool, videoCompositeTool, videoControlMixTool } from './film-video.ts';
import { meshRigTool } from './rig.ts';
import { blenderCharacterTool } from './character.ts';
import { motionFromTextTool } from './motion.ts';
import { sheetTool } from './sheet.ts';
import { viewSheetTool } from './viewsheet.ts';
import { decorateMeshTool, orderTools } from './threed.ts';

/** Tools written in code. Workflow tools (workflows/) are added by reloadTools(). */
const BUILT_IN: Tool[] = [
  imageEditTool, imagePaintTool, videoI2vTool, videoAnimateTool, comfyGraphTool,
  voiceTool, sfxTool, voiceDesignTool, voiceSaveTool,
  llmTextTool, llmJsonTool,
  cutoutTool, frameTool, videoFitTool, tileTool, materialMapsTool, probeTool, importTool, splatBuildTool,
  unityBuild, unityTest, playtestRunTool, playtestReviewTool, assetMakeTool, libraryJudgeTool, loraTrainTool, imageCharacterTool,
  blenderRenderTool, composeTool, meshRigTool,   blenderCharacterTool, motionFromTextTool, sheetTool, viewSheetTool,
  filmGateTool, filmPlanTool, videoMatteTool, videoCompositeTool, videoControlMixTool,
];

export let TOOLS: Tool[] = [];
let byId = new Map<string, Tool>();

/** Rebuilds the tool list: the built-in tools plus every workflow folder (a workflow can replace a built-in tool of the same id). */
export function reloadTools() {
  loadWorkflows();
  const wf = listWorkflows().map(workflowTool);
  const ids = new Set(wf.map((t) => t.id));
  TOOLS = orderTools([...BUILT_IN.filter((t) => !ids.has(t.id)), ...wf].map(decorateMeshTool));
  byId = new Map(TOOLS.map((t) => [t.id, t]));
  return TOOLS;
}
reloadTools();

export const getTool = (toolId: string) => byId.get(toolId) ?? null;

/** What the API and dashboard show about a tool (no code). */
export function describeTool(t: Tool) {
  return {
    id: t.id, version: t.version, title: t.title, description: t.description, provider: t.provider,
    family: typeof t.family === 'string' ? t.family : t.family ? 'per job' : null,
    output: t.output, inputs: t.inputs, params: t.params,
    workflow: t.workflow ?? null,
  };
}
