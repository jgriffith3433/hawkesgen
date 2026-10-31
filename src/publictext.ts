// What customers read never names what Gen is made of (J, 2026-10-30: "Remove any wording that says what our
// infrastructure and code is made of. (don't say comfy, modal, runpod, any tool names etc)"). A job's step, error and log
// lines come from providers, models and tools ("modal: waiting for a free modal GPU", "speaking with qwen3-tts on
// gen-gpu-a10", "Bad params for audio.voice: ..."): for a customer (a Gen account or a customer key) they are put in plain
// words here, and the job's internals (its server, its ComfyUI graphs, the GPU route) are left out. The owner, admins and
// Studio still see everything.

/** Where the work runs: any provider, service or machine. */
const PLACES = /\b(?:runpod|run ?pod|modal|cloud ?run|cloudrun(?::[\w.-]+)?|google cloud|gcp|aws|ec2|fleet|comfy ?ui|comfy(?:\.org)?|gen-gpu[\w-]*|gen-cpu[\w-]*|gen-playtest[\w-]*|hawkes-[\w-]+|g6e[\w.]*|g4dn[\w.]*|l40s|a10g?|l4|t4|rtx [\w ]+? ?\d{3,4}|nvidia|cuda)\b/gi;
/** The models and services behind the tools. */
const MODELS = /\b(?:qwen[\w.-]*(?: ?image(?: ?edit)?(?: \d+)?)?|wan ?2(?:\.\d)?(?: ?(?:fun control|animate|i2v|t2v|flf2v))?|ltx[\w.-]*|hunyuan[\w.-]*|trellis[\w.-]*|z-image[\w-]*|flux[\w.-]*|stable ?audio(?: ?\d)?|ace-step[\w.-]*|eleven ?labs|eleven_[\w]+|birefnet|rembg|sam ?\d|segment anything|moge|infinite ?talk|chatterbox|voxcpm\d*|moss-tts|kimodo|hy-motion|make-it-animatable|skintokens|blender|cycles|anthropic|claude(?: code)?|sonnet|opus|haiku|gpt-?[\w.]*|whisper|playwright|chromium|swiftshader|ffmpeg|pillow|litestream|ksampler|safetensors|lora)\b/gi;
/** A tool's id (image.generate, audio.voice, asset.make...). */
const TOOL_IDS = /\b(?:image|video|audio|mesh|asset|film|blender|motion|sprite|texture|llm|playtest|unity|splat|media|comfy|scene|character|lod)\.[a-z][\w-]*\b/g;

/** One line in plain words: providers, models, tools and machine names replaced, the wording otherwise kept. */
export function publicText(s: unknown): string {
  if (s == null) return s as any;
  let t = String(s);
  // "runpod: [Errno 28] ..." and "gen-gpu-l4: ..." at the start of a line: the place goes, the message stays.
  t = t.replace(/^\s*(?:runpod|modal|cloudrun(?::[\w.-]+)?|cloud run|fleet|gen-[\w-]+)\s*:\s*/i, '');
  t = t.replace(/\[Errno \d+\]\s*/g, '');
  // A place named before a noun ("a free modal GPU", "the runpod worker") just goes.
  t = t.replace(/\b(?:runpod|modal|cloud ?run|aws|fleet|comfy ?ui)\s+(?=(?:gpus?|workers?|servers?|instances?|machines?|jobs?)\b)/gi, '');
  t = t.replace(/No space left on device/gi, 'the server ran out of room');
  t = t.replace(TOOL_IDS, 'a step');
  t = t.replace(MODELS, 'the model');
  t = t.replace(PLACES, 'the server');
  // Tidy what the replacements leave: "the server the server", "with the model on the server" stays readable.
  t = t.replace(/\b(the (?:server|model))(?:\s+\1)+\b/gi, '$1').replace(/\s{2,}/g, ' ').trim();
  return t;
}

/** A job as this caller may see it: unchanged for the owner, admins and Studio; in plain words for a customer (api.ts isCustomer). */
export function publicJob<T extends Record<string, any>>(j: T, customer: boolean): T {
  if (!j || !customer) return j;
  const labels = Object.fromEntries(Object.entries(j.labels ?? {}).filter(([k]) => !/^(gpu|server|cloud|fleet|provider|backend)/i.test(k)));
  return {
    ...j,
    detail: j.detail == null ? j.detail : publicText(j.detail),
    error: j.error == null ? j.error : publicText(j.error),
    ...(Array.isArray(j.log) ? { log: j.log.map((l: unknown) => publicText(l)) } : {}),
    server: undefined,
    graphs: [],
    labels,
  };
}
