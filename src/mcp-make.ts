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
  /** Runs a job (or chain) and returns it with its files (mcp-tools.ts withFiles). */
  finish: (job: any) => Promise<any>;
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
    c.finish(await c.gen.submit(tool, { project: project(a), params, inputs, reuse: a.new_take ? false : true }));
  const chain = async (a: any, steps: Step[]) =>
    c.finish(await c.gen.submit('asset.make', { project: project(a), params: { steps }, inputs: {}, reuse: a.new_take ? false : true }));
  const common = { project: str('Project (default: your own)'), new_take: bool('A new take instead of reusing an identical earlier result') };
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
        return { upload_url: c.uploadLink(String(a.filename)), how: `curl -T "${a.filename}" "<upload_url>"`, then: 'Pass the blob:<sha> from the answer as the input. The link works once, for 30 minutes.' };
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
      description: 'Add a humanoid skeleton and skinning to a 3D model (GLB) so it can be animated.',
      inputSchema: obj({ model: fileIn('The 3D model (GLB)'), ...common }, ['model']),
      run: async (a) => run(a, 'mesh.rig', { kind: 'auto' }, { mesh: a.model }),
    },
    {
      name: 'animate_character',
      description: 'A skeletal animation from words ("a confident walk", "jump and land") on a rigged 3D character: a GLB with the clip.',
      inputSchema: obj({ model: fileIn('The rigged 3D model (GLB; rig_character makes one)'), motion: str('The motion'), seconds: num('Length (default 3)'), loop: bool('A seamless loop'), ...common }, ['model', 'motion']),
      run: async (a) => run(a, 'motion.from-text', { prompt: a.motion, ...(a.seconds ? { seconds: a.seconds } : {}), ...(a.loop ? { loop: true } : {}) }, { character: a.model }),
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
