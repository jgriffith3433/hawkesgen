// The friendly MCP tools (J, 2026-10-30: the portal's MCP tools moved here, "with the new hawkes gen interface in
// mind"): plain names for what the app's Create tab makes (dashboard/gen/studio.js GROUPS and its chains), each one a
// Gen job or an asset.make chain run as the caller (an editor signed in with its Gen account works in that account's
// project, on its credits, like the app). hawkesgen_run and hawkesgen_tools stay for everything else.

import { obj, str, type McpTool } from './mcp-core.ts';

type Step = { tool: string; params?: Record<string, unknown>; inputs?: Record<string, unknown> };
export type MakeContext = {
  gen: any;
  /** The project to work in when the caller names none (a Gen account's own). */
  account?: string;
  /**
   * Waits for a job (or chain) up to the call's wait_seconds and returns it with its files (state "done"), or
   * {state: "running", task_id} for get_task when it is still going (mcp-tools.ts settle).
   */
  finish: (job: any, a: any) => Promise<any>;
  remote: boolean;
  /** An upload link for a file (remote only: src/links.ts). */
  uploadLink?: (filename: string) => string;
};

const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });
const SHAPES: Record<string, [number, number]> = { square: [1024, 1024], wide: [1344, 768], tall: [768, 1344], landscape: [1216, 832], portrait: [832, 1216] };
const shape = str('Shape: square, wide, tall, landscape or portrait (default square)');
const fileIn = (what: string) => str(`${what}: asset:<id> from earlier results, blob:<sha> from upload_file, or a library file`);
/** Wan i2v makes 16 fps clips of 4n + 1 frames. */
const wanFrames = (seconds: number) => Math.round((Math.min(10, Math.max(1, seconds)) * 16) / 4) * 4 + 1;

export function makeTools(c: MakeContext): McpTool[] {
  const project = (a: any) => {
    const p = a.project ?? c.account;
    if (!p) throw new Error('Name the project to work in (project)');
    return p;
  };
  const run = async (a: any, tool: string, params: Record<string, unknown>, inputs: Record<string, unknown> = {}) =>
    c.finish(await c.gen.submit(tool, { project: project(a), params, inputs, reuse: a.new_take ? false : true }), a);
  const chain = async (a: any, steps: Step[]) =>
    c.finish(await c.gen.submit('asset.make', { project: project(a), params: { steps }, inputs: {}, reuse: a.new_take ? false : true }), a);
  const common = {
    project: str('Project (default: your own)'), new_take: bool('A new take instead of reusing an identical earlier result'),
    wait_seconds: num('How long to wait for the result (0-1800, default 240). Still running then: state "running" and a task_id for get_task'),
  };
  const dims = (a: any) => SHAPES[String(a.shape ?? 'square')] ?? SHAPES.square;

  const tools: McpTool[] = [
    {
      name: 'account',
      description: 'Your Hawkes Gen account: credits left and plan. Generating spends credits; estimate_cost prices a batch first.',
      inputSchema: obj({}),
      run: async () => c.gen.request('/users/me').catch(() => ({ note: 'This connection is not a Gen account (an API key or a platform token).' })),
    },
    {
      name: 'upload_file',
      description: 'Upload a file to use as an input (a picture to edit, a clip to turn into a sprite sheet, a model to rig). Returns a one-time link: PUT the file to it (curl -T <file> "<url>"); the answer gives blob:<sha> to pass to a tool.',
      inputSchema: obj({ filename: str('The file name, with its extension (hero.png)') }, ['filename']),
      run: async (a) => {
        if (!c.remote || !c.uploadLink) return { note: 'On this computer, pass the file path itself as the input.' };
        const url = c.uploadLink(String(a.filename));
        return { upload_url: url, upload: { url }, how: `curl -T "${a.filename}" "<upload_url>"`, then: 'Pass the blob:<sha> from the answer as the input. The link works once, for 30 minutes.' };
      },
    },
    {
      name: 'generate_image',
      description: 'A new picture from words. transparent: true cuts the subject out onto a transparent background (characters, props, icons). Returns the file(s).',
      inputSchema: obj({ prompt: str('What to draw'), shape, count: num('How many (1-4, default 1)'), transparent: bool('Cut the subject out (transparent PNG)'), ...common }, ['prompt']),
      run: async (a) => {
        const [width, height] = dims(a);
        const gen = { tool: 'image.generate', params: { prompt: a.prompt, width, height, count: Math.min(4, Math.max(1, Number(a.count) || 1)) } };
        return a.transparent ? chain(a, [gen, { tool: 'image.cutout', inputs: { image: '$prev' } }]) : run(a, gen.tool, gen.params);
      },
    },
    {
      name: 'edit_image',
      description: 'Change a picture by saying what to change ("make it night", "give her a red scarf"). Up to 3 pictures: the first is edited, the others are references.',
      inputSchema: obj({ image: fileIn('The picture'), references: { type: 'array', items: { type: 'string' }, description: 'More pictures as references (optional)' }, instruction: str('What to change'), ...common }, ['image', 'instruction']),
      run: async (a) => run(a, 'image.edit', { prompt: a.instruction }, { images: [a.image, ...(a.references ?? [])].slice(0, 3) }),
    },
    {
      name: 'remove_background',
      description: 'Cut the subject of a picture out onto a transparent background.',
      inputSchema: obj({ image: fileIn('The picture'), ...common }, ['image']),
      run: async (a) => run(a, 'image.cutout', {}, { image: a.image }),
    },
    {
      name: 'upscale_image',
      description: 'A bigger, sharper copy of a picture (4x).',
      inputSchema: obj({ image: fileIn('The picture'), ...common }, ['image']),
      run: async (a) => run(a, 'image.upscale', {}, { image: a.image }),
    },
    {
      name: 'make_texture',
      description: 'A seamless, tileable texture from words, and with maps: true its PBR material maps (normal, roughness, height, ambient occlusion...).',
      inputSchema: obj({ prompt: str('The material, e.g. "worn steel grating with a little rust, top-down"'), maps: bool('Also make the material maps (default true)'), ...common }, ['prompt']),
      run: async (a) => {
        const tex = { tool: 'image.generate', params: { prompt: a.prompt, seamless: true, width: 1024, height: 1024 } };
        return a.maps === false ? run(a, tex.tool, tex.params) : chain(a, [tex, { tool: 'texture.maps', inputs: { image: '$prev' } }]);
      },
    },
    {
      name: 'make_skybox',
      description: 'A seamless 360° panorama from words, for a skybox or an environment map.',
      inputSchema: obj({ prompt: str('The place, e.g. "a stormy sea at dusk"'), ...common }, ['prompt']),
      run: async (a) => run(a, 'image.panorama', { prompt: a.prompt }),
    },
    {
      name: 'character_views',
      description: 'Front, back, left and right views of a character from one picture, checked for consistency: the sheet for 3D (make_3d_model) or reference art.',
      inputSchema: obj({ image: fileIn('The character, full body, plain background'), description: str('What the character is (helps the back and sides)'), ...common }, ['image']),
      run: async (a) => chain(a, [
        { tool: 'image.cutout', inputs: { image: a.image } },
        { tool: 'image.viewsheet', params: a.description ? { form: a.description } : {}, inputs: { image: '$prev' } },
      ]),
    },
    {
      name: 'make_3d_model',
      description: 'A textured 3D model (GLB) of a character or creature, from words or a picture: concept art (from words), a clean cutout, a checked 4-view sheet, then the model; rigged: true adds a humanoid skeleton so it can be animated (animate_character).',
      inputSchema: obj({ prompt: str('What to make (or give image)'), image: fileIn('A picture of it (optional, instead of prompt)'), rigged: bool('Add a skeleton (default false)'), ...common }),
      run: async (a) => {
        if (!a.prompt && !a.image) throw new Error('Give prompt or image');
        const steps: Step[] = [];
        if (!a.image) steps.push({ tool: 'image.generate', params: { prompt: `${a.prompt}, full body, front view, A-pose, plain light background` } });
        steps.push({ tool: 'image.cutout', inputs: { image: a.image ?? '$prev' } });
        steps.push({ tool: 'image.viewsheet', params: { form: a.prompt ?? '' }, inputs: { image: '$prev' } });
        steps.push({ tool: 'mesh.views3d', inputs: { image: '$prev:sheet' } });
        if (a.rigged) steps.push({ tool: 'mesh.rig', params: { kind: 'auto' }, inputs: { mesh: '$prev' } });
        return chain(a, steps);
      },
    },
    {
      name: 'rig_character',
      description: 'Add a skeleton and skinning to a 3D model (GLB, FBX or OBJ) so it can be animated. Humanoids get a Mixamo-named skeleton (fingers too): any Mixamo or library clip plays on it, and Unity maps it as Humanoid with no setup. Returns the rigged GLB, an FBX and a walk video.',
      inputSchema: obj({ model: fileIn('The 3D model (GLB from make_3d_model, or FBX/OBJ), standing upright'), humanoid: bool('It is a humanoid (default: decided from its shape; others get a skeleton that fits their body)'), height: num('Scale it to this many meters tall (optional)'), ...common }, ['model']),
      run: async (a) => run(a, 'mesh.rig', { kind: a.humanoid ? 'humanoid' : 'auto', ...(a.height ? { height: Number(a.height) } : {}) }, { mesh: a.model }),
    },
    {
      name: 'animate_character',
      description: 'A new skeletal animation from words on a rigged humanoid: "a person throws a straight right punch and returns to guard". Write the move as one present-tense sentence naming the limbs and how it ends. Returns the clip as GLB and FBX on the character, a BVH, a preview video, and a motion check (foot slide, pops, jitter) per take. takes > 1 makes variations; the result names the best by the check. A stock clip (stock_animations) is cheaper when one fits.',
      inputSchema: obj({
        model: fileIn('The rigged 3D model (GLB or FBX; rig_character makes one)'), motion: str('The move, as a sentence'), seconds: num('Length, 0.4-12 (default 2; attacks 0.8-2)'),
        loop: bool('A seamless loop (idles, cycles)'), in_place: bool('Remove the travel (attacks, hits, idles)'), takes: num('Variations to make, 1-8 (default 1)'), ...common,
      }, ['model', 'motion']),
      run: async (a) => run(a, 'motion.from-text', {
        prompt: a.motion, ...(a.seconds ? { seconds: Number(a.seconds) } : {}), ...(a.loop ? { loop: true } : {}), ...(a.in_place ? { inPlace: true } : {}),
        ...(a.takes ? { takes: Math.min(8, Math.max(1, Math.round(Number(a.takes)))) } : {}),
      }, { character: a.model }),
    },
    {
      name: 'animate_from_video',
      description: 'Motion capture from an ordinary video: the person\'s movement becomes a skeletal animation on your rigged character (or a BVH alone). Best with the whole body in frame, one person, a still camera, up to 60 s. Give video, or leave it out and describe the move: the character is first filmed doing it (a still of the model animated by a video model), then the motion is read back. Returns GLB, FBX, BVH, a preview and a motion check.',
      inputSchema: obj({
        model: fileIn('The rigged 3D model (GLB or FBX; rig_character makes one)'), video: fileIn('The video of someone moving (mp4/mov/webm; optional)'),
        motion: str('Without a video: the move as it happens ("she spins on one foot and lands a roundhouse kick")'), start: num('Seconds into the video where the move starts'), seconds: num('How much of the video to read (default: all, up to 60)'),
        still_camera: bool('The camera does not move (more accurate)'), loop: bool('A seamless loop'), in_place: bool('Remove the travel'), name: str('The clip\'s name (default mocap)'), ...common,
      }, ['model']),
      run: async (a) => {
        const params = {
          name: a.name ?? 'mocap', camera: a.still_camera ? 'still' : 'auto', ...(a.start ? { start: Number(a.start) } : {}), ...(a.seconds ? { seconds: Number(a.seconds) } : {}),
          ...(a.loop ? { loop: true } : {}), ...(a.in_place ? { inPlace: true } : {}),
        };
        if (a.video) return run(a, 'motion.from-video', params, { video: a.video, character: a.model });
        if (!a.motion) throw new Error('Give video, or describe the move (motion) to film the character doing it');
        return chain(a, [
          { tool: 'blender.render', params: { shot: { characters: [{ file: 0, height: 1.8, facing: 0 }], camera: { move: 'static', angle: 0, distance: 3.4, height: 1.0, lens: 40 }, lights: 'studio' }, passes: [], stills: [0], engine: 'eevee', width: 640, height: 960, snap: false, frames: 1 }, inputs: { files: [a.model] } },
          { tool: 'video.i2v', params: { prompt: `${a.motion}. The whole body stays in frame, the camera does not move, plain studio background.`, width: 640, height: 960, frames: wanFrames(Number(a.seconds) || 3) }, inputs: { start: '$prev' } },
          { tool: 'motion.from-video', params: { ...params, camera: 'still' }, inputs: { video: '$prev', character: a.model } },
        ]);
      },
    },
    {
      name: 'stock_animations',
      description: 'The free (CC0) stock animation library: Quaternius\'s humanoid clips (walks, runs, idles, melee, hits, deaths, jumps...). Search by word; each has an id like motion:ual1/Walk_Loop to pass to add_animations. Free to use, cheaper than generating.',
      inputSchema: obj({ search: str('A word to look for (walk, punch, death...; empty lists all)'), limit: num('How many (default 40)') }),
      run: async (a) => {
        const q = new URLSearchParams({ tool: 'motion.library', limit: String(Math.min(200, Number(a.limit) || 40)), ...(a.search ? { q: String(a.search) } : {}) });
        const r = await c.gen.request(`/assets?${q}`);
        return { clips: (r.items ?? []).map((x: any) => ({ id: x.id, name: x.title, tags: x.tags, seconds: x.duration ?? x.meta?.duration, loop: x.loop ?? x.meta?.loop })), total: r.total };
      },
    },
    {
      name: 'add_animations',
      description: 'Put clips on a rigged character: stock clips (motion:ual1/Walk_Loop from stock_animations), Mixamo FBX downloads, BVH mocap, or clips from another character. Each is retargeted (any Mixamo, Unreal, Rigify, SMPL or SOMA skeleton), optionally looped or kept in place, and exported. Returns one GLB per clip (and an FBX with all of them, Mixamo names, ready for Unity Humanoid), plus preview videos when asked.',
      inputSchema: obj({
        model: fileIn('The rigged 3D model (GLB or FBX)'), clips: { type: 'array', items: { type: 'string' }, description: 'Clip ids or files: motion:ual1/Walk_Loop, asset:<id> of an FBX/GLB/BVH, blob:<sha>' },
        names: { type: 'array', items: { type: 'string' }, description: 'A name per clip (default: the clip\'s own)' }, in_place: bool('Remove the travel from every clip'), loop: bool('Make every clip loop'),
        preview: bool('Also a video of each clip (default false)'), ...common,
      }, ['model', 'clips']),
      run: async (a) => {
        const clips: string[] = (a.clips ?? []).slice(0, 16);
        if (!clips.length) throw new Error('Give at least one clip');
        const names: string[] = clips.map((cl, i) => String(a.names?.[i] ?? cl.replace(/^motion:[^/]+\//, '').replace(/^(asset|blob):/, '').replace(/[^\w-]/g, '').slice(0, 40) ?? `Clip${i + 1}`) || `Clip${i + 1}`);
        const ops: Record<string, unknown>[] = [{ op: 'import', file: 0, clips: false }];
        names.forEach((name, i) => {
          ops.push({ op: 'retarget', file: i + 1, name });
          if (a.in_place) ops.push({ op: 'inplace', clip: name, mode: 'travel' });
          if (a.loop) ops.push({ op: 'loop', clip: name, blend: 6 });
          ops.push({ op: 'export', format: 'glb', name, clips: [name] });
        });
        ops.push({ op: 'export', format: 'fbx', name: 'character' });
        if (a.preview) ops.push({ op: 'preview', turntable: false, clips: names, size: 512, samples: 16, maxFrames: 360 });
        return run(a, 'blender.character', { ops }, { files: [a.model, ...clips] });
      },
    },
    {
      name: 'export_character',
      description: 'Package a rigged character with its clips for a game engine: unity (FBX, Mixamo bone names so Unity maps it as Humanoid, each clip a take, 1 unit = 1 m) or web (GLB, one animation per clip, Draco and WebP for a small file, for Babylon.js 9 AnimatorAvatar or three.js). Pass the clips (GLBs from animate_character / add_animations, or any clip file).',
      inputSchema: obj({ model: fileIn('The rigged 3D model'), clips: { type: 'array', items: { type: 'string' }, description: 'Clip files to include (asset:<id>, motion:ual1/...)' }, engine: str('unity or web (default both)'), ...common }, ['model']),
      run: async (a) => {
        const engine = String(a.engine ?? 'both').toLowerCase();
        const ops: Record<string, unknown>[] = [{ op: 'import', file: 0 }, { op: 'retarget', file: '*' }];
        if (engine !== 'web') ops.push({ op: 'export', format: 'fbx', name: 'character' });
        if (engine !== 'unity') ops.push({ op: 'export', format: 'glb', name: 'character', compress: 'draco', textures: 'webp' }, { op: 'export', format: 'glb', name: 'character-full', title: 'glb-uncompressed' });
        return run(a, 'blender.character', { ops }, { files: [a.model, ...(a.clips ?? []).slice(0, 24)] });
      },
    },
    {
      name: 'check_animation',
      description: 'Measure a humanoid clip (a BVH from animate_character or animate_from_video, or any BVH): foot slide, feet through the floor, joint pops, jitter, loop seam, travel. Free. Returns ok, the problems and what to try.',
      inputSchema: obj({ clip: fileIn('The clip as a BVH'), loop: bool('It should loop'), in_place: bool('It should stay in place'), ...common }, ['clip']),
      run: async (a) => run(a, 'motion.check', { ...(a.loop ? { loop: true } : {}), ...(a.in_place ? { inPlace: true } : {}) }, { clip: a.clip }),
    },
    {
      name: 'animate_image',
      description: 'Bring a picture to life: a short clip of it moving. Describe the motion as it happens ("the bird spreads its wings and takes off over the water"), not as an instruction.',
      inputSchema: obj({ image: fileIn('The picture (the first frame)'), motion: str('What happens'), seconds: num('Length, 1-10 (default 5)'), ...common }, ['image', 'motion']),
      run: async (a) => run(a, 'video.i2v', { prompt: a.motion, frames: wanFrames(Number(a.seconds) || 5) }, { start: a.image }),
    },
    {
      name: 'make_video',
      description: 'A video clip from words.',
      inputSchema: obj({ prompt: str('What happens, as a scene'), seconds: num('Length (default 5)'), shape, ...common }, ['prompt']),
      run: async (a) => {
        const [width, height] = dims({ shape: a.shape ?? 'wide' });
        return run(a, 'video.t2v', { prompt: a.prompt, seconds: Number(a.seconds) || 5, width, height });
      },
    },
    {
      name: 'make_sprite_sheet',
      description: 'An animated game sprite sheet: a character (from words or a picture) does a motion ("a looping run cycle, side view"), then the clip becomes a sheet (PNG atlas, frame JSON in TexturePacker format, a preview GIF), background keyed out.',
      inputSchema: obj({ prompt: str('The character (or give image)'), image: fileIn('A picture of the character (optional)'), motion: str('The motion, e.g. "runs in place, a looping run cycle, side view"'), frames: num('Frames in the sheet (default 8)'), ...common }, ['motion']),
      run: async (a) => {
        if (!a.prompt && !a.image) throw new Error('Give prompt or image');
        const steps: Step[] = [];
        if (!a.image) steps.push({ tool: 'image.generate', params: { prompt: `${a.prompt}, side view, full body, centered, plain flat green background` } });
        steps.push({ tool: 'video.i2v', params: { prompt: `${a.motion}, the camera stays still, plain background`, frames: wanFrames(2) }, inputs: { start: a.image ?? '$prev' } });
        // A picture of their own keeps its background unless it's the flat green the generated one gets.
        steps.push({ tool: 'sprite.sheet', params: { frames: Number(a.frames) || 8, loop: true, ...(a.image ? {} : { key: '00ff00' }) }, inputs: { video: '$prev' } });
        return chain(a, steps);
      },
    },
    {
      name: 'list_voices',
      description: 'The voices voice_line can speak in (name, accent, style).',
      inputSchema: obj({}),
      run: async () => c.gen.request('/editor/voices').then((r: any) => r.voices),
    },
    {
      name: 'voice_line',
      description: 'A line spoken in a voice (list_voices names them).',
      inputSchema: obj({ text: str('What is said'), voice: str('A voice id or name from list_voices'), ...common }, ['text', 'voice']),
      run: async (a) => run(a, 'audio.voice', { text: a.text, voice: a.voice, provider: 'elevenlabs' }),
    },
    {
      name: 'sound_effect',
      description: 'A sound effect from words ("a heavy wooden door creaks open").',
      inputSchema: obj({ text: str('The sound'), seconds: num('Length (optional)'), loop: bool('A seamless loop'), ...common }, ['text']),
      run: async (a) => run(a, 'audio.sfx', { text: a.text, ...(a.seconds ? { duration: a.seconds } : {}), ...(a.loop ? { loop: true } : {}), provider: 'elevenlabs' }),
    },
    {
      name: 'make_music',
      description: 'Music from a description, with or without lyrics.',
      inputSchema: obj({ prompt: str('Style, mood, instruments, tempo'), lyrics: str('Lyrics (optional; none: instrumental)'), seconds: num('Length (default 60)'), ...common }, ['prompt']),
      run: async (a) => run(a, 'audio.music', { prompt: a.prompt, ...(a.lyrics ? { lyrics: a.lyrics } : {}), seconds: Number(a.seconds) || 60 }),
    },
  ];
  return tools;
}
