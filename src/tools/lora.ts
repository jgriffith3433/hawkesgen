// Character LoRAs: train a small add-on model on a character's images (ComfyUI's native training nodes, on the
// GPU fleet), then generate that character on-model with image.character. Base model: Z-Image Turbo (the
// image.generate workflow), so the LoRA works with the same graph and speed.
//
// The trained file is a library output (kind "file", .safetensors) and lives on the server that trained it under
// models/loras/hawkes/. image.character copies it to any other server that needs it.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import { getAsset } from '../library.ts';
import { paths } from '../config.ts';
import { sshRun, scpToServer, MODELS_DIR } from '../providers/comfy/fleet.ts';
import { ask } from '../providers/anthropic.ts';

const WORKFLOW = () => path.join(paths.server, '..', 'workflows', 'image-generate');
const baseModels = () => JSON.parse(fs.readFileSync(path.join(WORKFLOW(), 'workflow.json'), 'utf8')).models ?? [];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'character';

export const loraTrainTool: Tool = {
  id: 'lora.train',
  version: 3,
  title: 'Train a character LoRA',
  description:
    'Trains a LoRA (a small add-on model) on 5 to 30 images of one character, so image.character can draw it on-model ' +
    'in any pose or scene. Use the character\'s source image and poses (e.g. AllTheCharacters/<Folder>/poses). Images ' +
    'are framed on a plain background here; training runs on the GPU fleet (Z-Image Turbo base, about 20 to 40 minutes). ' +
    'The output is the .safetensors file; its trigger word goes at the start of prompts. Captions per image (what changes: ' +
    'pose, view, expression, framing; never the character’s own look) train a much stronger LoRA than one caption for all: ' +
    'give `captions` or set `autoCaption` (Claude writes them).',
  provider: 'comfy',
  family: 'z-image',
  output: 'file',
  inputs: { images: { kind: 'image', multiple: true, max: 40, required: true, description: 'The character: clean images, one character each, varied poses' } },
  params: {
    name: { type: 'string', required: true, description: 'The character (names the file and the trigger word)', example: 'susan' },
    caption: { type: 'text', description: 'What the character is (after the trigger word in every training caption)', example: 'a woman in a dark coat with shadow tendrils, full body, game character art' },
    captions: { type: 'json', description: 'One caption per image, in order (the trigger word is added): what differs in that image, e.g. "side view facing right, mid-jump, fists raised"' },
    autoCaption: { type: 'boolean', default: false, description: 'Claude writes a caption per image (pose, view, framing; not the character’s look, so the look binds to the trigger word). About 5 cents.' },
    steps: { type: 'integer', min: 100, max: 4000, description: 'Training steps (default: 100 per image, 600 to 1500)' },
    rank: { type: 'integer', default: 16, min: 4, max: 64, advanced: true },
    learningRate: { type: 'number', default: 0.0001, min: 0.00001, max: 0.001, advanced: true },
    size: { type: 'integer', default: 768, min: 512, max: 1024, advanced: true, description: 'Training resolution (square). 1024 needs more than the L40S has free.' },
    offload: { type: 'boolean', default: false, advanced: true, description: 'Offload weights to system memory (slower; used automatically if the GPU runs out)' },
    seed: { type: 'integer', default: 1, min: 0, max: 2147483647, advanced: true },
  },
  models: () => baseModels().map((m: any) => m.file),
  gpuSeconds: (p) => Math.round((p.steps ?? 1000) * 1.6),
  async run(ctx) {
    const c = ctx.comfy;
    if (!c) throw new GenError('lora.train needs a GPU server');
    const p = ctx.params;
    const images: string[] = ctx.inputs.images;
    if (images.length < 3) throw new GenError('Give at least 3 images of the character (5 to 30 is best)');
    const name = slug(p.name);
    const trigger = `hwk_${name.replace(/-/g, '_')}`;
    const steps = p.steps ?? Math.max(600, Math.min(1500, images.length * 100));
    await c.ensureModels(baseModels());

    // Frame each image on a plain square so every training image is the same size.
    ctx.step(`preparing ${images.length} training images`);
    const names: string[] = [];
    for (const [i, img] of images.entries()) {
      const out = ctx.tmp(`train-${i}.png`);
      await ctx.python('prep.py', ['frame', img, out, String(p.size), String(p.size), '0.88', 'eeeeee', '0.04']);
      names.push(await c.upload(out));
    }
    const g: Record<string, any> = {
      unet: { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
      clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' } },
      vae: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
      sampling: { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, model: ['unet', 0] } },
      caption: { class_type: 'PrimitiveString', inputs: { value: `${trigger}, ${p.caption || `the character ${p.name}, full body, plain background`}` } },
    };
    let batch: [string, number] | null = null;
    names.forEach((n, i) => {
      g[`img${i}`] = { class_type: 'LoadImage', inputs: { image: n } };
      if (!batch) batch = [`img${i}`, 0];
      else {
        g[`batch${i}`] = { class_type: 'ImageBatch', inputs: { image1: batch, image2: [`img${i}`, 0] } };
        batch = [`batch${i}`, 0];
      }
    });
    // Captions: one per image when given (or written by Claude), else the one caption for all.
    let captions: string[] | null = Array.isArray(p.captions) ? p.captions.map(String) : null;
    if (captions && captions.length !== images.length) throw new GenError(`captions: give one per image (${images.length}), not ${captions.length}`);
    if (!captions && p.autoCaption) {
      ctx.step(`Claude is captioning ${images.length} training images`);
      const r = await ask({
        system: 'You caption training images for a character LoRA. For each image, write one short caption of what is specific to that image: camera view (front, three-quarter, side facing left/right, back), pose and action, expression, framing (full body, upper body, close-up), and anything held or happening. Do NOT describe the character’s permanent look (face, hair, body, outfit colors, signature items): that must bind to the trigger word.',
        prompt: `The character: ${p.caption || p.name}. ${images.length} images, in order. Return one caption per image.`,
        images, effort: 'low', maxTokens: 4000,
        schema: { type: 'object', additionalProperties: false, required: ['captions'], properties: { captions: { type: 'array', items: { type: 'string' } } } },
      }, ctx.signal);
      ctx.usage({ provider: 'anthropic', unit: 'tokens', amount: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), cost: r.cost, detail: `${r.model} captions` });
      const got: string[] = JSON.parse(r.text).captions ?? [];
      if (got.length === images.length) captions = got;
      else ctx.log(`Claude gave ${got.length} captions for ${images.length} images; using the one caption for all`);
    }
    if (captions) {
      // ComfyUI reads per-image captions from a folder of image + .txt pairs in its input folder.
      const dir = `hwk-${name}-${ctx.job.id}`;
      await sshRun(`mkdir -p /opt/comfy/input/${dir} && echo ok`, c.server.id);
      ctx.step(`sending ${images.length} captioned images to the server`);
      for (const [i, img] of images.entries()) {
        const framed = ctx.tmp(`train-${i}.png`);
        const txt = ctx.tmp(`train-${i}.txt`);
        fs.writeFileSync(txt, `${trigger}, ${captions[i]}`);
        await scpToServer(framed, `/opt/comfy/input/${dir}/${String(i).padStart(3, '0')}.png`, c.server.id);
        await scpToServer(txt, `/opt/comfy/input/${dir}/${String(i).padStart(3, '0')}.txt`, c.server.id);
      }
      for (const k of Object.keys(g)) if (/^(img|batch)\d+$/.test(k) || k === 'caption') delete g[k];
      g.folder = { class_type: 'LoadImageTextDataSetFromFolder', inputs: { folder: dir } };
      g.dataset = { class_type: 'MakeTrainingDataset', inputs: { images: ['folder', 0], vae: ['vae', 0], clip: ['clip', 0], texts: ['folder', 1] } };
    } else {
      g.dataset = { class_type: 'MakeTrainingDataset', inputs: { images: batch, vae: ['vae', 0], clip: ['clip', 0], texts: ['caption', 0] } };
    }
    g.train = {
      class_type: 'TrainLoraNode',
      inputs: {
        model: ['sampling', 0], latents: ['dataset', 0], positive: ['dataset', 1], batch_size: 1, grad_accumulation_steps: 1, steps,
        learning_rate: p.learningRate, rank: p.rank, optimizer: 'AdamW', loss_function: 'MSE', seed: p.seed, training_dtype: 'bf16',
        lora_dtype: 'bf16', quantized_backward: false, algorithm: 'LoRA', gradient_checkpointing: true, checkpoint_depth: 1,
        offloading: Boolean(p.offload), existing_lora: '[None]', bucket_mode: false, bypass_mode: false,
      },
    };
    const prefix = `loras/hawkes/${name}-${ctx.job.id}`;
    g.save = { class_type: 'SaveLoRA', inputs: { lora: ['train', 0], prefix, steps } };
    ctx.step(`training ${trigger}: ${steps} steps on ${images.length} images`);
    try {
      await c.runGraph(g as any);
    } catch (e: any) {
      if (!/out of memory|exceed allowed memory/i.test(String(e.message)) || p.offload) throw e;
      ctx.log('the GPU ran out of memory; training again with weights offloaded to system memory');
      g.train.inputs.offloading = true;
      ctx.step(`training ${trigger} (offloaded): ${steps} steps`);
      await c.runGraph(g as any);
    }

    // SaveLoRA writes into ComfyUI's output folder; put a copy where loaders find it, and keep one here.
    const found = (await sshRun(`ls -t /opt/comfy/output/${prefix}* 2>/dev/null | head -1`, c.server.id)).trim();
    if (!found) throw new GenError('Training finished but no LoRA file was saved (see the job graph and the server log)');
    const file = path.posix.basename(found);
    const final = `${name}.safetensors`;
    await sshRun(`sudo mkdir -p ${MODELS_DIR}/loras/hawkes && sudo cp '${found}' ${MODELS_DIR}/loras/hawkes/'${final}' && echo ok`, c.server.id);
    const data = await c.download({ filename: file, subfolder: path.posix.dirname(prefix), type: 'output' });
    await ctx.emit({ data, ext: '.safetensors', mime: 'application/octet-stream', title: `${name} LoRA`, meta: { lora: final, trigger, steps, images: images.length, captions: captions ? 'per image' : 'one for all', base: 'z_image_turbo_bf16' } });
    ctx.result({ lora: final, trigger, steps, images: images.length, captions, note: `Use image.character with lora = this asset id; prompts start with "${trigger}".` });
  },
};

export const imageCharacterTool: Tool = {
  id: 'image.character',
  version: 1,
  title: 'Draw a trained character',
  description:
    'Generates images of a character trained with lora.train: the same Z-Image Turbo graph as image.generate, plus the ' +
    'character\'s LoRA, so it stays on-model in new poses, angles and scenes. Use the LoRA asset id from lora.train.',
  provider: 'comfy',
  family: 'z-image',
  output: 'image',
  inputs: {},
  params: {
    lora: { type: 'string', required: true, description: 'The lora.train output (asset id)', example: 'a_0123456789abcdef' },
    prompt: { type: 'text', required: true, description: 'The pose and scene (the trigger word is added for you)', example: 'running toward the camera, dynamic pose, plain light grey background' },
    strength: { type: 'number', default: 1, min: 0, max: 2 },
    width: { type: 'integer', default: 1024, min: 256, max: 2048 },
    height: { type: 'integer', default: 1024, min: 256, max: 2048 },
    count: { type: 'integer', default: 1, min: 1, max: 8 },
    seed: { type: 'integer', min: 0, max: 2147483647 },
    steps: { type: 'integer', default: 8, min: 4, max: 30, advanced: true },
  },
  models: (p) => [...baseModels().map((m: any) => m.file), `lora:${p.lora}`],
  gpuSeconds: (p) => 8 * (p.count ?? 1),
  async run(ctx) {
    const c = ctx.comfy;
    if (!c) throw new GenError('image.character needs a GPU server');
    const p = ctx.params;
    const id = String(p.lora).replace(/^asset:/, '');
    const a = getAsset(id);
    if (!a || !a.meta?.lora) throw new GenError(`${p.lora} is not a lora.train output`);
    const file = String(a.meta.lora);
    const trigger = String(a.meta.trigger ?? '');
    await c.ensureModels(baseModels());
    const have = (await sshRun(`test -s ${MODELS_DIR}/loras/hawkes/'${file}' && echo yes || echo no`, c.server.id)).trim();
    if (have !== 'yes') {
      ctx.step(`copying the ${file} LoRA to the server`);
      await scpToServer(a.path, `${MODELS_DIR}/loras/hawkes/${file}`, c.server.id);
    }
    const graph = JSON.parse(fs.readFileSync(path.join(WORKFLOW(), 'graph.json'), 'utf8'));
    graph.lora = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['57:28', 0], lora_name: `hawkes/${file}`, strength_model: p.strength } };
    graph['57:11'].inputs.model = ['lora', 0];
    graph['57:27'].inputs.text = `${trigger}, ${p.prompt}`;
    graph['57:13'].inputs.width = p.width;
    graph['57:13'].inputs.height = p.height;
    graph['57:3'].inputs.steps = p.steps;
    for (let i = ctx.done; i < p.count; i++) {
      const seed = ctx.seed(i);
      graph['57:3'].inputs.seed = seed;
      ctx.step(`drawing ${i + 1} of ${p.count}`);
      const files = await c.runGraph(graph);
      for (const f of files) await ctx.emit({ data: await c.download(f), ext: path.extname(f.filename) || '.png', seed, title: `${trigger} ${i + 1}` });
    }
  },
};
