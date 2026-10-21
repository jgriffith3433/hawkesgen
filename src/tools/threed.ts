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
  'on the sheet. image.angles is not enough (it has no back view). The preset shared/character3d does all of it.';

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
      description: 'THE way Gen turns images into 3D (always more than one view). A textured PBR GLB (Pixal3D multi-view + TRELLIS.2) from a sheet of front, back, left and right views of the same character, side by side in equal cells. Make the sheet with image.viewsheet (from the front view) or image.sheet; the preset shared/character3d runs the whole chain.',
      guard(call) {
        const file = Array.isArray(call.inputs.image) ? call.inputs.image[0] : call.inputs.image;
        const size = file ? imageSize(file) : null;
        if (size && size.width < MIN_SHEET_RATIO * size.height) {
          throw new GenError(`mesh.views3d wants a sheet of 4 views side by side (front, back, left, right: about 4 times wider than tall), and this image is ${size.width}x${size.height}, which looks like a single view. ${HOW_TO_GET_VIEWS}`);
        }
      },
    };
  }
  return t;
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
