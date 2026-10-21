// The film recipes: the plans they build name real tools, real inputs and valid params, wire steps to the right outputs, and the
// trailer cut keeps trailer pace. Offline: nothing renders and nothing is generated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cinemaPass, dialogueCloseup, vfxLayers, characterLora, trailerCut, shotFileRefs, renderFiles, lineSeconds, talkFrames, type Recipe } from '../src/film/recipes.ts';
import { resultRef } from '../src/tools/pipeline.ts';
import { getTool } from '../src/tools/index.ts';
import { validateParams } from '../src/tools/validate.ts';
import { planCompose } from '../src/tools/compose.ts';
import type { Shot } from '../src/film/shot.ts';

const shot: Shot = {
  speaker: 1,
  characters: [
    { file: 0, height: 1.8, position: [-1.5, 0], facing: 90, beats: [{ animation: 'Walk', to: [0.5, 0], seconds: 2 }, { animation: 'Idle', seconds: 3, lookAt: 1 }], attachments: [{ prop: 0, bone: 'right hand' }] },
    { file: 1, height: 1.7, position: [2.5, 0.5], facing: -90, animation: 'Idle' },
  ],
  props: [{ file: 2, size: 0.8 }],
  ground: { material: { albedo: 3, normal: 4, roughness: 5 } },
  background: { file: 6 },
  camera: { target: 1, distance: 4, height: 1.6, angle: 40 },
};

/** Every step names a real tool and only its inputs and params, with values it accepts. */
function checkRecipe(r: Recipe, where: string) {
  assert.ok(r.steps.length >= 2, where);
  const saves = new Set<string>();
  r.steps.forEach((s, i) => {
    const tool = getTool(s.tool);
    assert.ok(tool, `${where} step ${i + 1}: unknown tool ${s.tool}`);
    for (const name of Object.keys(s.inputs ?? {})) assert.ok(name in tool!.inputs, `${where} step ${i + 1}: ${s.tool} has no input ${name}`);
    for (const [name, spec] of Object.entries(tool!.inputs)) if (spec.required) assert.ok(s.inputs?.[name] != null, `${where} step ${i + 1}: ${s.tool} needs input ${name}`);
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.params ?? {})) params[k] = typeof v === 'string' && /^\$(prev|step\d+)\.result/.test(v) ? {} : v;
    for (const [k, spec] of Object.entries(tool!.params)) if (spec.required && params[k] === undefined) params[k] = spec.type === 'json' ? {} : 'x';
    assert.doesNotThrow(() => validateParams(tool!, params), `${where} step ${i + 1} (${s.tool})`);
    // Step references only point backwards, and at a title the earlier tool really makes.
    for (const v of Object.values(s.inputs ?? {}).flat()) {
      const m = /^\$step(\d+)(?::(.+))?$/.exec(String(v));
      if (m) assert.ok(Number(m[1]) <= i, `${where} step ${i + 1} points forward at ${v}`);
      if (/^\$step\d+\.result/.test(String(v))) assert.fail(`${where}: results go in params, not inputs`);
    }
    if (s.save) { assert.ok(!saves.has(s.save), `${where}: save ${s.save} twice`); saves.add(s.save); }
  });
  assert.ok(r.pickAt >= 1 && r.pickAt <= r.steps.length, `${where}: pickAt`);
  assert.ok(r.candidates >= 1 && r.candidates <= 8, `${where}: candidates`);
}

test('shotFileRefs: every file index the shot points at, sky and texture maps included', () => {
  assert.deepEqual(shotFileRefs(shot), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(renderFiles(shot), ['$input:0', '$input:1', '$input:2', '$input:3', '$input:4', '$input:5', '$input:6']);
  assert.throws(() => renderFiles({ characters: [] }), /uses no files/);
});

test('cinema pass: gate, render, control mix, look best-of-3, restore, video.control, upscale; wired to the right outputs', () => {
  const r = cinemaPass({ shot, look: 'A rain-soaked neon alley, live-action film still.', motion: 'He walks up to her; footsteps splash.', refs: [7] });
  checkRecipe(r, 'cinema');
  assert.deepEqual(r.steps.map((s) => s.tool), ['film.gate', 'blender.render', 'video.control-mix', 'image.edit', 'image.restore', 'video.control', 'video.upscale']);
  const [gate, render, mix, edit, restore, control, up] = r.steps;
  assert.equal(render.params!.shot, '$step1.result.shot', 'the render takes the shot the gate approved');
  assert.deepEqual(mix.inputs!.videos, ['$step2:depth', '$step2:pose', '$step2:edges']);
  assert.deepEqual(edit.inputs!.images, ['$step2:first frame', '$input:7']);
  assert.equal(r.steps[r.pickAt - 1], edit, 'the best-of-N is the repaint');
  assert.equal(r.candidates, 3);
  assert.deepEqual(r.refs, [7]);
  assert.deepEqual(control.inputs, { control: '$step3:control', image: '$step5' });
  assert.deepEqual(up.inputs, { video: '$prev' });
  assert.equal(up.save, 'shot');
  assert.equal(restore.save, 'keyframe');
  assert.match(String(edit.params!.prompt), /Keep the composition, camera, framing and every pose exactly as in image 1\. Image 2 is the character reference sheet/);
  assert.equal(control.params!.width, 1280);
  assert.deepEqual(gate.inputs!.files, render.inputs!.files, 'the gate previews with the same files');
  assert.equal(gate.params!.seconds, render.params!.seconds);
});

test('cinema pass: options (no gate, depth only, relight, Wan) change the chain, not the wiring', () => {
  const plain = cinemaPass({ shot, look: 'x', motion: 'y', gate: false, controls: 'depth', relight: 'warm key light from the left', restore: false, upscale: false });
  checkRecipe(plain, 'plain');
  assert.deepEqual(plain.steps.map((s) => s.tool), ['blender.render', 'image.edit', 'image.relight', 'video.control']);
  assert.deepEqual(plain.steps[0].params!.shot, shot, 'no gate: the shot as given');
  assert.deepEqual(plain.steps[3].inputs, { control: '$step1:depth', image: '$step3' });
  assert.equal(plain.steps[2].save, 'keyframe');
  const wan = cinemaPass({ shot, look: 'x', motion: 'y', engine: 'wan', controls: 'depth+pose', gate: false });
  checkRecipe(wan, 'wan');
  assert.deepEqual(wan.steps.map((s) => s.tool), ['blender.render', 'video.control-mix', 'image.edit', 'image.restore', 'video.control-wan', 'video.upscale', 'video.interpolate']);
  assert.equal(wan.steps[0].params!.fps, 16);
  assert.equal(wan.steps[4].params!.frames, 81);
  assert.equal(wan.steps[6].params!.multiplier, 2);
  assert.throws(() => cinemaPass({ shot, look: 'x', motion: 'y', refs: [1] }), /put reference sheets after/);
  assert.throws(() => cinemaPass({ shot, look: 'x', motion: 'y', refs: [7, 8, 9] }), /at most two/);
  const layers = cinemaPass({ shot, look: 'x', motion: 'y', layers: true, gate: false });
  assert.ok((layers.steps[0].params!.passes as string[]).includes('layers'));
});

test('dialogue close-up: a Blender frame of the speaker, a portrait, a voice line, InfiniteTalk', () => {
  const line = 'You said you would come alone. You lied to me, and now we both pay for it.';
  const r = dialogueCloseup({ shot, speaker: 1, line, voice: 'abcdefghij', look: 'Gritty live-action film still, night, rain, neon.', refs: [7] });
  checkRecipe(r, 'dialogue');
  assert.deepEqual(r.steps.map((s) => s.tool), ['blender.render', 'image.edit', 'audio.voice', 'video.talk']);
  const cam = (r.steps[0].params!.shot as any).camera;
  assert.equal(cam.target, 1);
  assert.ok(cam.lens >= 85 && cam.distance < 1.5 && cam.dof, 'a close-up on the speaker with a long lens and shallow focus');
  assert.equal((r.steps[0].params!.shot as any).characters[0].beats, undefined, 'the close-up is one frame: no beats');
  assert.deepEqual(r.steps[0].params!.stills, [0]);
  assert.deepEqual(r.steps[0].params!.passes, []);
  assert.deepEqual(r.steps[1].inputs!.images, ['$step1:still 1', '$input:7']);
  assert.deepEqual(r.steps[3].inputs, { image: '$step2', audio: '$step3' });
  assert.equal(r.pickAt, 2);
  // Two passes of `frames`: the clip covers the line.
  const talk = r.steps[3].params as any;
  const secs = lineSeconds(line);
  assert.ok((2 * talk.frames) / talk.fps >= secs && (talk.frames - 1) % 4 === 0, JSON.stringify(talk));
  assert.equal(talkFrames(3, 25), 41);
  assert.ok(lineSeconds('Run.') >= 1.5 && lineSeconds('word '.repeat(200)) <= 12);
  assert.throws(() => dialogueCloseup({ shot, speaker: 5, line, voice: 'v', look: 'x' }), /not a character/);
  assert.throws(() => dialogueCloseup({ shot, speaker: 0, line: ' ', voice: 'v', look: 'x' }), /Give the line/);
});

test('layered VFX: the effect runs on one character\'s matte and the composite protects the other', () => {
  const r = vfxLayers({ shot, base: '$input:8', fx: 0, look: 'Lightning crackles around his arms.', motion: 'Lightning arcs between his hands.' });
  checkRecipe(r, 'vfx');
  assert.deepEqual(r.steps.map((s) => s.tool), ['blender.render', 'video.control-mix', 'video.matte', 'image.edit', 'video.control', 'video.composite']);
  assert.ok((r.steps[0].params!.passes as string[]).includes('layers'));
  assert.deepEqual(r.steps[2].inputs, { video: '$prev', matte: '$step1:layer 0' });
  assert.deepEqual(r.steps[4].inputs, { control: '$step3', image: '$prev' });
  assert.deepEqual(r.steps[5].inputs, { base: '$input:8', fx: '$prev', matte: '$step1:layer 0', protect: '$step1:layer 1' });
  assert.equal(r.steps[r.pickAt - 1].tool, 'image.edit');
  assert.match(String(r.steps[3].params!.prompt), /character 0 only/);
  assert.throws(() => vfxLayers({ shot: { characters: [{ file: 0 }] }, base: 'x', fx: 0, look: 'x', motion: 'y' }), /two characters/);
  assert.throws(() => vfxLayers({ shot, base: 'x', fx: 0, protect: 0, look: 'x', motion: 'y' }), /different characters/);
});

test('character LoRA: turntable and bust stills out of Blender, lora.train with auto captions, on-model references', () => {
  const r = characterLora({ name: 'pierce', caption: 'a tall man in a dark coat', height: 1.85 });
  checkRecipe(r, 'lora');
  assert.deepEqual(r.steps.map((s) => s.tool), ['blender.render', 'blender.render', 'lora.train', 'image.character']);
  const train = r.steps[2];
  assert.equal((train.inputs!.images as string[]).length, 16);
  assert.equal(train.params!.autoCaption, true);
  assert.equal(train.inputs!.images![0], '$step1:still 1');
  assert.equal(train.inputs!.images![8], '$step2:still 1');
  const stills = r.steps[0].params!.stills as number[];
  assert.equal(stills.length, 8);
  assert.ok(stills.every((s) => s >= 0 && s < 1), 'a full turn, the first angle not repeated');
  assert.equal((r.steps[0].params!.shot as any).camera.move, 'turntable');
  assert.equal(r.steps[3].params!.lora, '$prev');
  assert.equal(characterLora({ name: 'x', caption: 'y', reference: false }).steps.length, 3);
});

test('trailer cut: 2-4 s shots, lines duck the music, wides keep their sound and close-ups take the voice', () => {
  const cut = trailerCut([
    { id: 'w1', kind: 'wide', clip: 'shot:w1', seconds: 5 },
    { id: 'c1', kind: 'closeup', clip: 'shot:c1', seconds: 6.5, dialogue: { audio: 'voice:c1', text: 'You lied to me.', seconds: 2.1 } },
    { id: 'w2', kind: 'wide', clip: 'shot:w2', seconds: 3.2, transition: 'crossfade' },
    { id: 'c2', kind: 'closeup', clip: 'shot:c2', seconds: 6.5, dialogue: { audio: 'voice:c2', text: 'A very long line indeed.', seconds: 6.2 } },
  ], { music: 'music:trailer' });
  const clips = (cut.params.timeline as any).clips;
  assert.deepEqual(clips.map((c: any) => +(c.out - c.in).toFixed(2)), [4, 2.45, 3.2, 5]);
  assert.equal(clips[0].sound, true);
  assert.equal(clips[1].sound, false, 'the close-up\'s sound is the voice line, laid separately');
  assert.equal(clips[2].transition, 'crossfade');
  const audio = (cut.params.timeline as any).audio;
  assert.equal(audio[0].duck, true, 'the music comes first and ducks');
  assert.equal(audio.filter((a: any) => a.dialogue).length, 2);
  assert.deepEqual(cut.inputs.clips, ['shot:w1', 'shot:c1', 'shot:w2', 'shot:c2']);
  assert.deepEqual(cut.inputs.audio, ['voice:c1', 'voice:c2', 'music:trailer']);
  assert.ok(cut.notes.some((n) => /c2: the line runs 6\.2 s/.test(n)));
  assert.equal(cut.params.captions, 'both');
  // The plan really composes (video.compose's own planner accepts it: every index and clip is valid).
  const probe = (d: number) => ({ duration: d, video: true, audio: true, width: 1280, height: 704, fps: 24 });
  const plan = planCompose(cut.params.timeline as any, [probe(5), probe(6.5), probe(3.2), probe(6.5)], [probe(2.1), probe(6.2), probe(30)], { width: 1280, height: 704, fps: 24, fit: 'pad', color: '000000', burn: false });
  assert.ok(Math.abs(plan.duration - cut.duration) < 0.1, `${plan.duration} vs ${cut.duration}`);
  assert.equal(plan.captions.length, 2);
  assert.throws(() => trailerCut([]), /at least one/);
  assert.throws(() => trailerCut([{ id: 'a', kind: 'wide', clip: 'x', seconds: 3 }, { id: 'a', kind: 'wide', clip: 'y', seconds: 3 }]), /twice/);
  const three = trailerCut(['a', 'b', 'c'].map((id) => ({ id, kind: 'wide' as const, clip: id, seconds: 4 })));
  assert.ok(three.notes.some((n) => /three wide shots in a row/.test(n)));
});

test('asset.make params can take a step\'s result: "$step1.result.shot"', () => {
  const results = [{ pass: true, shot: { camera: { angle: 10 } }, tries: 1 }, undefined];
  assert.deepEqual(resultRef('$step1.result.shot', results), { camera: { angle: 10 } });
  assert.equal(resultRef('$step1.result.shot.camera.angle', results), 10);
  assert.deepEqual(resultRef({ a: ['$step1.result.tries', 'plain', 3], b: { c: '$step1.result.pass' } }, results), { a: [1, 'plain', 3], b: { c: true } });
  assert.equal(resultRef('$input:0', results), '$input:0', 'only .result references are resolved in params');
  assert.equal(resultRef('$step1:depth', results), '$step1:depth');
  assert.throws(() => resultRef('$step1.result.nope', results), /has no "nope"/);
  assert.throws(() => resultRef('$step2.result', results), /returned no value/);
  assert.deepEqual(resultRef('$prev.result.tries', [{ tries: 2 }]), 2);
});
