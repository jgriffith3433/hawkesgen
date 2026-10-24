// Image to 3D always takes more than one view. A single picture makes the 3D model guess the back and the sides, and
// the guess is lumpy and lopsided. mesh.views3d (front|back|left|right) is the way; mesh.textured and mesh.from-image
// stay for props and blockouts and refuse a call that doesn't say so (allowSingleView), and mesh.views3d refuses a
// picture that is plainly not a sheet of views. docs/3d-characters.md ("Always more than one view").

import fs from 'node:fs';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';

/** Tools that turn ONE image into 3D. Deprecated: kept for props and blockouts and for recipes already made. */
export const SINGLE_VIEW_TOOLS = ['mesh.textured', 'mesh.from-image'];
/** Also deprecated, but two views is not a guess: no refusal, only the notice. */
export const DEPRECATED_MESH_TOOLS = [...SINGLE_VIEW_TOOLS, 'mesh.from-views'];
/** The image-to-3D tools, best first (the tool list shows them in this order). */
export const MESH_ORDER = ['mesh.views3d', 'image.viewsheet', 'image.sheet'];

const NOTICE = 'DEPRECATED (one view guesses the back; use mesh.views3d): ';
export const HOW_TO_GET_VIEWS = 'Make the views with image.viewsheet (give it the cutout of the front view: it makes the back, left and right of the same ' +
  'character, checks they match and lays the sheet) or image.sheet (when you already have the views, front, back, left, right), then run mesh.views3d ' +
  'on its front, back, left and right outputs (or the sheet). image.angles is not enough (it has no back view). The preset shared/character3d does all of it.';

export function singleViewMessage(toolId: string) {
  return `${toolId} makes 3D from ONE image, so the model has to guess the back and the sides and the mesh comes out lumpy and lopsided. ` +
    `Gen turns images into 3D from more than one view: use mesh.views3d. ${HOW_TO_GET_VIEWS} ` +
    `For a prop or a blockout where one view really is enough, pass allowSingleView: true.`;
}

/** Width and height of a PNG or JPEG from its header (null when unreadable or another format). */
export function imageSize(file: string): { width: number; height: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(32);
    fs.readSync(fd, head, 0, 32, 0);
    if (head.subarray(1, 4).toString() === 'PNG') return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    if (head[0] === 0xff && head[1] === 0xd8) {
      const buf = fs.readFileSync(file);
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* unreadable: no opinion */ } finally { if (fd !== null) fs.closeSync(fd); }
  return null;
}

/** A sheet of 4 equal cells is at least 3 times wider than tall (image.sheet's cells are square: 4:1). */
export const MIN_SHEET_RATIO = 3;

/** Adds the deprecation notice, the allowSingleView escape hatch and the refusals to the image-to-3D tools. */
export function decorateMeshTool(t: Tool): Tool {
  if (DEPRECATED_MESH_TOOLS.includes(t.id) && !t.description.startsWith('DEPRECATED')) t = { ...t, description: NOTICE + t.description };
  if (SINGLE_VIEW_TOOLS.includes(t.id)) {
    return {
      ...t,
      params: { ...t.params, allowSingleView: { type: 'boolean', default: false, description: 'Props and blockouts only: allow making 3D from one image (the model guesses the back and sides). Characters and robots need mesh.views3d.' } },
      guard(call) {
        if (!call.params.allowSingleView) throw new GenError(singleViewMessage(t.id));
      },
    };
  }
  if (t.id === 'mesh.views3d') {
    return {
      ...t,
      description: 'THE way Gen turns images into 3D (always more than one view). A textured PBR GLB (Pixal3D multi-view + TRELLIS.2) from the front, back, left and right views of the same character or object: ' +
        'pass them as front, back, left, right (image.viewsheet outputs them; left = the camera moved to your left, so the object faces right in the picture), or one sheet of them side by side in 4 equal cells, front|back|left|right (the sheet of image.viewsheet, image.sheet). ' +
        'Gen frames them the way Pixal3D wants (on black, square, the same scale in every view) and saves the four views it received (front view, left view, back view, right view). The preset shared/character3d runs the whole chain.',
      guard(call) {
        views3dSources(call.inputs);
      },
      async run(ctx) {
        const src = views3dSources(ctx.inputs);
        const files: Record<string, string> = {};
        if (src.sheet) {
          ctx.step('splitting the sheet into its four views');
          const parts = VIEW_ORDER.map((v) => ctx.tmp(`panel-${v}.png`));
          await ctx.python('prep.py', ['split', src.sheet, String(VIEW_ORDER.length), ...parts]);
          VIEW_ORDER.forEach((v, i) => (files[v] = parts[i]));
        } else Object.assign(files, src.views);
        ctx.step('framing the views for Pixal3D (on black, the same scale)');
        const framed = VIEW_ORDER.map((v) => ctx.tmp(`framed-${v}.png`));
        const info = JSON.parse(await ctx.python('prep.py', ['views', String(PIXAL_SIZE), String(PIXAL_PAD), ...VIEW_ORDER.map((v) => files[v]), ...framed]));
        if (info.heightRatio > 1.25) ctx.log(`warning: the object's height differs ${info.heightRatio}x between the views; each view was scaled to the same height`);
        const inputs = Object.fromEntries(VIEW_ORDER.map((v, i) => [v, framed[i]]));
        await t.run({ ...ctx, inputs });
      },
    };
  }
  return t;
}

/**
 * The order of views in a sheet (image.viewsheet, image.sheet) and in Gen everywhere: front, back, left, right.
 * "left" is the view from your left as you face the front: the camera moves 90 degrees to the viewer's left, so the object
 * faces RIGHT in the picture and shows its own right side ("right" is the mirror case). That is what Pixal3D's
 * conditioning calls left (ComfyUI's own example sheet, front|left|back|right: in its left panel the figure faces right),
 * and what blender.character's angles op calls left (the camera at -X, the character facing -Y). Swapping the two
 * twists the mesh.
 */
export const VIEW_ORDER = ['front', 'back', 'left', 'right'] as const;
/** Pixal3D's views: square, this size, the object's widest extent over all views spanning 1/PAD of the frame. */
export const PIXAL_SIZE = 1024;
export const PIXAL_PAD = 1.1;

/** What mesh.views3d was given: the four views, or one sheet of them. Throws (at submit) when it is neither. */
export function views3dSources(inputs: Record<string, any>): { sheet?: string; views?: Record<string, string> } {
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
  const given = VIEW_ORDER.filter((v) => one(inputs[v]));
  if (given.length === VIEW_ORDER.length) return { views: Object.fromEntries(VIEW_ORDER.map((v) => [v, one(inputs[v])!])) };
  if (given.length) throw new GenError(`mesh.views3d needs all four views (front, back, left, right), or one sheet of them as image; it got only ${given.join(', ')}. ${HOW_TO_GET_VIEWS}`);
  const sheet = one(inputs.image);
  if (!sheet) throw new GenError(`mesh.views3d needs the four views (front, back, left, right) or a sheet of them (image). ${HOW_TO_GET_VIEWS}`);
  const size = imageSize(sheet);
  if (size && size.width < MIN_SHEET_RATIO * size.height) {
    throw new GenError(`mesh.views3d wants a sheet of 4 views side by side (front, back, left, right: about 4 times wider than tall), and this image is ${size.width}x${size.height}, which looks like a single view. ${HOW_TO_GET_VIEWS}`);
  }
  return { sheet };
}

/** The tool list's order: the image-to-3D tools first (mesh.views3d at the top), the deprecated ones last. */
export function orderTools(tools: Tool[]): Tool[] {
  const rank = (t: Tool) => {
    const i = MESH_ORDER.indexOf(t.id);
    return i >= 0 ? i - MESH_ORDER.length : DEPRECATED_MESH_TOOLS.includes(t.id) ? 1 : 0;
  };
  const rankOf = new Map(tools.map((t, i) => [t.id, i]));
  return [...tools].sort((a, b) => rank(a) - rank(b) || rankOf.get(a.id)! - rankOf.get(b.id)!);
}
