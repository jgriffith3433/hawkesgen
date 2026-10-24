// ComfyUI API graphs. Each is a straight translation of an official template
// in server/templates/ (the templates use subgraphs, which the API can't run),
// with the 4-step speed LoRAs switched on. Ported from Dose Of Destruction's
// tools/gpu/workflows.mjs, where the settings were tuned (docs/comfyui.md).
// Model file names match server/models.json.

import type { Graph } from './client.ts';

function graph() {
  const nodes: Graph = {};
  let n = 0;
  const add = (class_type: string, inputs: Record<string, any> = {}) => {
    const nodeId = String(++n);
    nodes[nodeId] = { class_type, inputs };
    return nodeId;
  };
  return { nodes, add, out: (nodeId: string, slot = 0) => [nodeId, slot] };
}

/** The model files each family loads (for the job's recipe and for syncing servers). */
export const FAMILY_MODELS: Record<string, string[]> = {
  'qwen-edit': ['qwen_image_edit_2511_fp8mixed.safetensors', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'qwen_image_vae.safetensors', 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors'],
  'wan-i2v': ['wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors', 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'wan_2.1_vae.safetensors'],
  'wan-animate': ['Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors', 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'wan_2.1_vae.safetensors', 'clip_vision_h.safetensors'],
};

/** fal's Qwen-Image-Edit-2511 Multiple-Angles LoRA (also in workflows/image-angles): installed on first use. */
export const ANGLES_LORA = {
  file: 'qwen-image-edit-2511-multiple-angles-lora.safetensors',
  dir: 'loras',
  url: 'https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA/resolve/main/qwen-image-edit-2511-multiple-angles-lora.safetensors',
};

/**
 * Qwen-Image-Edit-2511, 4-step Lightning: edit images[0] as the prompt says,
 * with images[1] and images[2] as extra references.
 *
 * Without width/height the output follows images[0]'s size
 * (FluxKontextImageScale). With them, images[0] is scaled to exactly that size,
 * which sets the output (a blockout to paint over, a canvas to paint on).
 * denoise below 1 starts from images[0] itself, which pins the result to its
 * flat shapes (Qwen otherwise drifts to three-quarter views).
 */
export function imageEdit({ images, prompt, negative = '', seed, width, height, prefix = 'hawkesgen/edit', s = {} as any }: {
  images: string[]; prompt: string; negative?: string; seed: number; width?: number; height?: number; prefix?: string; s?: any;
}) {
  const { steps = 4, cfg = 1, shift = 3.1, lora: loraStrength = 1, sampler = 'euler', scheduler = 'simple', denoise = 1, angles = 0 } = s;
  const g = graph();
  const unet = g.add('UNETLoader', { unet_name: 'qwen_image_edit_2511_fp8mixed.safetensors', weight_dtype: 'default' });
  const clip = g.add('CLIPLoader', { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: 'qwen_image_vae.safetensors' });
  const sampling = g.add('ModelSamplingAuraFlow', { model: g.out(unet), shift });
  const norm = g.add('CFGNorm', { model: g.out(sampling), strength: 1 });
  const lightning = g.add('LoraLoaderModelOnly', { model: g.out(norm), lora_name: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', strength_model: loraStrength });
  // fal's Multiple-Angles LoRA (trained on 3D renders): prompts like "<sks> back view eye-level shot medium shot".
  const lora = Number(angles) > 0 ? g.add('LoraLoaderModelOnly', { model: g.out(lightning), lora_name: ANGLES_LORA.file, strength_model: Number(angles) }) : lightning;
  const loads = images.slice(0, 3).map((image) => g.add('LoadImage', { image }));
  const first = width && height
    ? g.add('ImageScale', { image: g.out(loads[0]), upscale_method: 'lanczos', width, height, crop: 'disabled' })
    : g.add('FluxKontextImageScale', { image: g.out(loads[0]) });
  const refs: Record<string, any> = { image1: g.out(first) };
  loads.slice(1).forEach((nodeId, i) => (refs[`image${i + 2}`] = g.out(nodeId)));
  const enc = (text: string) =>
    g.add('FluxKontextMultiReferenceLatentMethod', {
      conditioning: g.out(g.add('TextEncodeQwenImageEditPlus', { clip: g.out(clip), vae: g.out(vae), ...refs, prompt: text })),
      reference_latents_method: 'index_timestep_zero',
    });
  const pos = enc(prompt);
  const neg = enc(negative);
  const latent = g.add('VAEEncode', { pixels: g.out(first), vae: g.out(vae) });
  const sample = g.add('KSampler', {
    model: g.out(lora), positive: g.out(pos), negative: g.out(neg), latent_image: g.out(latent),
    seed, steps, cfg, sampler_name: sampler, scheduler, denoise,
  });
  const decoded = g.add('VAEDecode', { samples: g.out(sample), vae: g.out(vae) });
  g.add('SaveImage', { images: g.out(decoded), filename_prefix: prefix });
  return g.nodes;
}

/**
 * Wan 2.2 14B image-to-video with the 4-step LoRAs: high noise (the motion)
 * then low noise (the detail). image is the first frame; end, when given, the
 * last (first-last-frame), so a loop can start and end on the same pose.
 *
 * The speed LoRAs flatten motion and at CFG 1 the prompt barely steers it, so
 * the first motionSteps run on the plain high-noise model at cfgHigh (the
 * community's "three sampler" setup). motionSteps 0 is the plain template.
 */
export function imageToVideo({ image, end, prompt, negative, width = 640, height = 640, frames = 33, fps = 16, seed, prefix = 'hawkesgen/i2v', s = {} as any }: {
  image: string; end?: string; prompt: string; negative?: string; width?: number; height?: number; frames?: number; fps?: number; seed: number; prefix?: string; s?: any;
}) {
  const { steps = 4, cfg = 1, shift = 5, loraHigh = 1, loraLow = 1, sampler = 'euler', scheduler = 'simple' } = s;
  const split = Math.min(steps - 1, Math.max(1, s.split ?? Math.floor(steps / 2)));
  const motionSteps = Math.min(split, Math.max(0, Math.round(s.motionSteps ?? 0)));
  const cfgHigh = s.cfgHigh ?? cfg;
  // loraVersion 2: lightx2v's newer 4-step LoRAs (1022), which move more than v1.
  const [loraHighFile, loraLowFile] = Number(s.loraVersion) >= 2
    ? ['wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors', 'wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors']
    : ['wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors', 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors'];
  // PainterI2V (start frame only) pushes motion past what the 4-step LoRAs give.
  const amplitude = !end && Number(s.motionAmplitude) > 1 ? Math.min(2, Number(s.motionAmplitude)) : 0;
  const g = graph();
  const clip = g.add('CLIPLoader', { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: 'wan_2.1_vae.safetensors' });
  const model = (unet: string, lora: string, strength: number) =>
    g.add('ModelSamplingSD3', { model: g.out(g.add('LoraLoaderModelOnly', { model: g.out(unet), lora_name: lora, strength_model: strength })), shift });
  const highUnet = g.add('UNETLoader', { unet_name: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors', weight_dtype: 'default' });
  const high = model(highUnet, loraHighFile, loraHigh);
  const raw = motionSteps ? g.add('ModelSamplingSD3', { model: g.out(highUnet), shift }) : null;
  const low = model(g.add('UNETLoader', { unet_name: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors', weight_dtype: 'default' }), loraLowFile, loraLow);
  const pos = g.add('CLIPTextEncode', { clip: g.out(clip), text: prompt });
  const neg = g.add('CLIPTextEncode', { clip: g.out(clip), text: negative ?? '' });
  const load = g.add('LoadImage', { image });
  const i2v = end
    ? g.add('WanFirstLastFrameToVideo', { positive: g.out(pos), negative: g.out(neg), vae: g.out(vae), start_image: g.out(load), end_image: g.out(g.add('LoadImage', { image: end })), width, height, length: frames, batch_size: 1 })
    : amplitude
      ? g.add('PainterI2V', { positive: g.out(pos), negative: g.out(neg), vae: g.out(vae), start_image: g.out(load), width, height, length: frames, batch_size: 1, motion_amplitude: amplitude })
      : g.add('WanImageToVideo', { positive: g.out(pos), negative: g.out(neg), vae: g.out(vae), start_image: g.out(load), width, height, length: frames, batch_size: 1 });
  const motion = raw
    ? g.add('KSamplerAdvanced', {
        model: g.out(raw), add_noise: 'enable', noise_seed: seed, steps, cfg: cfgHigh, sampler_name: sampler, scheduler,
        positive: g.out(i2v, 0), negative: g.out(i2v, 1), latent_image: g.out(i2v, 2), start_at_step: 0, end_at_step: motionSteps, return_with_leftover_noise: 'enable',
      })
    : null;
  const first = g.add('KSamplerAdvanced', {
    model: g.out(high), add_noise: motion ? 'disable' : 'enable', noise_seed: motion ? 0 : seed, steps, cfg: motion ? cfg : cfgHigh, sampler_name: sampler, scheduler,
    positive: g.out(i2v, 0), negative: g.out(i2v, 1), latent_image: motion ? g.out(motion) : g.out(i2v, 2), start_at_step: motionSteps, end_at_step: split, return_with_leftover_noise: 'enable',
  });
  const second = g.add('KSamplerAdvanced', {
    model: g.out(low), add_noise: 'disable', noise_seed: 0, steps, cfg, sampler_name: sampler, scheduler,
    positive: g.out(i2v, 0), negative: g.out(i2v, 1), latent_image: g.out(first), start_at_step: split, end_at_step: 10000, return_with_leftover_noise: 'disable',
  });
  const decoded = g.add('VAEDecode', { samples: g.out(second), vae: g.out(vae) });
  const video = g.add('CreateVideo', { images: g.out(decoded), fps });
  g.add('SaveVideo', { video: g.out(video), filename_prefix: prefix, format: 'auto', codec: 'auto' });
  return { graph: g.nodes, loras: [loraHighFile, loraLowFile] };
}

/**
 * Wan 2.2 Animate: the reference performs the driving video's motion (poses
 * read with DWPose). With no background video or mask, the background comes
 * from the reference image, so a flat green reference keys cleanly.
 */
export function animate({ reference, motion, prompt, negative, width = 640, height = 640, frames = 77, fps = 16, seed, prefix = 'hawkesgen/animate', s = {} as any }: {
  reference: string; motion: string; prompt: string; negative?: string; width?: number; height?: number; frames?: number; fps?: number; seed: number; prefix?: string; s?: any;
}) {
  const { steps = 6, cfg = 1, shift = 8, lora: loraStrength = 1, sampler = 'euler', scheduler = 'simple', hands = true, face = true, poseResolution = 512 } = s;
  const g = graph();
  const unet = g.add('UNETLoader', { unet_name: 'Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors', weight_dtype: 'default' });
  const lora = g.add('LoraLoaderModelOnly', { model: g.out(unet), lora_name: 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', strength_model: loraStrength });
  const model = g.add('ModelSamplingSD3', { model: g.out(lora), shift });
  const clip = g.add('CLIPLoader', { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: 'wan_2.1_vae.safetensors' });
  const vision = g.add('CLIPVisionLoader', { clip_name: 'clip_vision_h.safetensors' });
  const ref = g.add('LoadImage', { image: reference });
  const visionOut = g.add('CLIPVisionEncode', { clip_vision: g.out(vision), image: g.out(ref), crop: 'none' });
  const pos = g.add('CLIPTextEncode', { clip: g.out(clip), text: prompt });
  const neg = g.add('CLIPTextEncode', { clip: g.out(clip), text: negative ?? '' });
  const video = g.add('LoadVideo', { file: motion });
  const parts = g.add('GetVideoComponents', { video: g.out(video) });
  const sized = g.add('ImageScale', { image: g.out(parts, 0), upscale_method: 'lanczos', width, height, crop: 'center' });
  const pose = (hand: string, body: string, faceOn: string) =>
    g.add('DWPreprocessor', {
      image: g.out(sized), detect_hand: hand, detect_body: body, detect_face: faceOn, resolution: poseResolution,
      bbox_detector: 'yolox_l.onnx', pose_estimator: 'dw-ll_ucoco_384_bs5.torchscript.pt', scale_stick_for_xinsr_cn: 'disable',
    });
  const on = (b: boolean) => (b ? 'enable' : 'disable');
  const poses = pose(on(hands), 'enable', 'disable');
  const faces = pose('disable', 'disable', on(face));
  const wan = g.add('WanAnimateToVideo', {
    positive: g.out(pos), negative: g.out(neg), vae: g.out(vae), clip_vision_output: g.out(visionOut),
    reference_image: g.out(ref), pose_video: g.out(poses), face_video: g.out(faces),
    width, height, length: frames, batch_size: 1, continue_motion_max_frames: 5, video_frame_offset: 0,
  });
  const sample = g.add('KSampler', { model: g.out(model), positive: g.out(wan, 0), negative: g.out(wan, 1), latent_image: g.out(wan, 2), seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1 });
  const trimmed = g.add('TrimVideoLatent', { samples: g.out(sample), trim_amount: g.out(wan, 3) });
  const decoded = g.add('VAEDecode', { samples: g.out(trimmed), vae: g.out(vae) });
  const kept = g.add('ImageFromBatch', { image: g.out(decoded), batch_index: g.out(wan, 4), length: 4096 });
  const out = g.add('CreateVideo', { images: g.out(kept), fps });
  g.add('SaveVideo', { video: g.out(out), filename_prefix: prefix, format: 'auto', codec: 'auto' });
  return g.nodes;
}
