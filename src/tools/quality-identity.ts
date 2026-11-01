// quality.identity: how close the faces in a picture or clip are to a character's references (docs/bench.md). Pure, so
// the CPU suite's service can run it (src/cpu/suite.ts): insightface on the CPU, no API, no database.

import type { Tool } from './types.ts';
import type { OutputKind } from '../quality/index.ts';
import { identityScoreImpl, IDENTITY_FRAMES } from '../quality/identity.ts';
import { GenError } from '../util.ts';

/** A file's kind from its name (`auto`), or the kind asked for. */
export function kindOfFile(file: string, asked: unknown = 'auto'): OutputKind {
  if (asked === 'image' || asked === 'video' || asked === 'mesh' || asked === 'audio') return asked;
  const ext = String(file).toLowerCase().split('.').pop() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi'].includes(ext)) return 'video';
  if (['glb', 'gltf'].includes(ext)) return 'mesh';
  if (['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(ext)) return 'audio';
  throw new GenError(`Can't tell what kind of file ${file} is: set kind`);
}

export const qualityIdentityTool: Tool = {
  id: 'quality.identity',
  version: 1,
  title: 'Check a face against a character',
  description: 'How close the faces in a picture or a clip are to a character\'s reference pictures: ArcFace cosine distance (insightface buffalo_l on the CPU) from the best-matching face in each checked frame (about 8 for a clip) to the references. Lower is closer: real video of one person scores about 0.08, the target is under 0.15. Returns the distance, each frame\'s, the spread between frames and the faces found; distance null when no face was found. Free (CPU only, a few seconds).',
  provider: 'local',
  output: 'json',
  inputs: {
    file: { kind: 'file', required: true, description: 'The picture or clip to check.' },
    refs: { kind: 'image', required: true, multiple: true, max: 8, description: 'The character\'s reference pictures (their sheet, front, portrait).' },
  },
  params: {
    kind: { type: 'enum', values: ['auto', 'image', 'video'], default: 'auto', advanced: true },
    frames: { type: 'integer', min: 1, max: 24, default: IDENTITY_FRAMES, advanced: true, description: 'Frames sampled from a clip.' },
  },
  async run(ctx) {
    const kind = kindOfFile(ctx.inputs.file, ctx.params.kind);
    if (kind !== 'image' && kind !== 'video') throw new GenError('quality.identity checks pictures and clips');
    const refs: string[] = ([] as string[]).concat(ctx.inputs.refs ?? []);
    ctx.step(`finding faces in ${kind === 'video' ? `${ctx.params.frames} frames` : 'the picture'}`);
    const r = await identityScoreImpl({ file: ctx.inputs.file, kind }, refs, { frames: ctx.params.frames, signal: ctx.signal, python: (s, a) => ctx.python(s, a) });
    ctx.log(r.distance == null ? 'no face to compare' : `distance ${r.distance} over ${r.perFrame.length} frame(s), spread ${r.spread}`);
    ctx.result(r);
  },
};
