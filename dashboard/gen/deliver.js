// Delivery from the app (docs/finishing.md): after a video scene's export, "Get it ready to share" offers the
// deliverables as simple choices (the shapes each platform wants, captions, titles and credits, thumbnails, a trailer)
// and runs video.deliver, then lists every file it made. A world's "Take this world into a game" runs world.export and
// hands back the pack. Both are plain functions any module can call: the export sheet (tools.js) and the world's home.

import { h, api, toast, icon, plainError } from './lib.js';
import { state, needSignIn } from './account.js';
import { waitJob, quote, credits } from './media.js';

const FORMATS = [
  { id: '16:9', label: 'Wide', for: 'YouTube and the web' },
  { id: '9:16', label: 'Tall', for: 'Shorts, Reels, TikTok' },
  { id: '1:1', label: 'Square', for: 'feeds' },
  { id: '4:5', label: 'Portrait', for: 'Instagram feed' },
];
const CAPTIONS = [
  { id: 'none', label: 'No captions' },
  { id: 'soft', label: 'Captions viewers can turn on' },
  { id: 'burn', label: 'Captions in the picture' },
];

const chip = (label, on, onclick, title) => {
  const b = h('button', { class: `chip${on ? ' on' : ''}`, type: 'button', title: title ?? '', onclick: () => { onclick(b); } }, label);
  return b;
};
const KIND_LABEL = { master: 'The finished video', aspect: 'Shape', captions: 'Captions', thumbnail: 'Thumbnail', trailer: 'Trailer' };

/** The file list a delivery sheet comes back with: each file, what it's for, and its download. */
export function sheetList(sheet) {
  return h('div', { class: 'deliver-files' },
    ...sheet.files.filter((f) => f.asset).map((f) => h('div', { class: 'row deliver-file' },
      h('span', { class: 'grow' }, h('b', {}, f.kind === 'aspect' ? `${f.title}` : KIND_LABEL[f.kind] ?? f.title), f.for ? h('span', { class: 'muted small' }, ` · ${f.for}`) : '', f.width ? h('span', { class: 'muted small' }, ` · ${f.width}×${f.height}`) : ''),
      h('a', { class: 'btn ghost small', href: `/v1/assets/${f.asset}/file?download=1`, download: '' }, icon('download'), 'Download'))),
    ...(sheet.notes ?? []).map((n) => h('p', { class: 'muted small' }, n)));
}

/**
 * Mounts "Get it ready to share" under an export: the choices, the price, and the button that makes them all.
 * `o.title` names the video; `o.world` is the world it belongs to (titles and credits come from it); `o.captions` are
 * the timeline's words as [{ start, end, text }]; `o.wide` says the cut is already landscape.
 */
export function mountDeliver(box, asset, o = {}) {
  const pick = { formats: new Set(['9:16']), captions: o.captions?.length ? 'soft' : 'none', titles: true, thumbnails: true, trailer: false };
  const price = h('span', { class: 'muted small' });
  const status = h('div', { class: 'small muted' });
  const result = h('div');
  const params = () => ({
    title: o.title || 'Untitled', ...(o.world ? { world: o.world } : {}), formats: [...pick.formats], titles: pick.titles, thumbnails: pick.thumbnails, trailer: pick.trailer,
    captionMode: pick.captions, ...(pick.captions !== 'none' && o.captions?.length ? { captionList: o.captions } : {}),
  });
  const reprice = async () => { const q = await quote('video.deliver', params()); price.textContent = q ? credits(q) : ''; };
  const toggleSet = (set, id) => (b) => { set.has(id) ? set.delete(id) : set.add(id); b.classList.toggle('on', set.has(id)); reprice(); };
  const flag = (k) => (b) => { pick[k] = !pick[k]; b.classList.toggle('on', pick[k]); reprice(); };
  const capRow = h('div', { class: 'row wrap' });
  const drawCaps = () => capRow.replaceChildren(...CAPTIONS.map((c) => chip(c.label, pick.captions === c.id, () => { pick.captions = c.id; drawCaps(); reprice(); })));
  drawCaps();
  const go = h('button', { class: 'primary', type: 'button' }, 'Make them');
  go.addEventListener('click', () => needSignIn(async () => {
    go.disabled = true;
    status.textContent = 'Starting';
    result.replaceChildren();
    try {
      const r = await api('/v1/jobs', { body: { project: state.user.project, tool: 'video.deliver', params: params(), inputs: { video: `asset:${asset}` }, labels: { title: `Deliver: ${o.title || 'video'}` } } });
      const done = await waitJob(r.jobs[0].id, (s) => { status.textContent = s; });
      status.textContent = '';
      result.replaceChildren(sheetList(done.result));
      toast('Everything is ready and saved to Media.');
    } catch (err) {
      status.textContent = plainError(err.message);
    } finally {
      go.disabled = false;
    }
  }, 'login'));
  box.append(h('div', { class: 'deliver' },
    h('h3', {}, 'Get it ready to share'),
    h('p', { class: 'muted small' }, 'Pick what you want; the AI makes each one, keeps the subject in frame and lists every file.'),
    h('div', { class: 'row wrap' }, ...FORMATS.filter((f) => !(o.wide && f.id === '16:9')).map((f) => chip(f.label, pick.formats.has(f.id), toggleSet(pick.formats, f.id), f.for))),
    capRow,
    h('div', { class: 'row wrap' },
      chip('Title and credits', pick.titles, flag('titles')),
      chip('Thumbnails', pick.thumbnails, flag('thumbnails')),
      chip('A trailer', pick.trailer, flag('trailer'), 'A 45-second trailer with music'),
    ),
    h('div', { class: 'row end' }, price, go),
    status, result));
  reprice();
}

/** "Take this world into a game": packs the world (models, pictures, voices, skyboxes, sets, the look) as a zip. */
export function exportWorld(worldId, title = 'world', onDone) {
  needSignIn(async () => {
    toast(`Packing ${title} for games…`);
    try {
      const r = await api('/v1/jobs', { body: { project: state.user.project, tool: 'world.export', params: { world: worldId }, labels: { title: `Game pack: ${title}` } } });
      const done = await waitJob(r.jobs[0].id);
      const zip = done.outputs.find((x) => x.kind === 'file' && /\.zip$/i.test(x.path ?? x.title ?? '')) ?? done.outputs[0];
      const missing = done.result?.missing?.length ?? 0;
      toast(missing ? `${title} is packed (${missing} thing${missing === 1 ? '' : 's'} still to make are listed inside).` : `${title} is packed for games.`, {
        action: 'Download', onAction: () => { location.href = `/v1/assets/${zip.asset}/file?download=1`; }, ms: 12000,
      });
      onDone?.(done);
    } catch (err) {
      toast(plainError(err.message));
    }
  }, 'login');
}

/** The world entry point as a button, for the world's home. */
export function worldExportButton(worldId, title) {
  return h('button', { class: 'ghost', type: 'button', onclick: () => exportWorld(worldId, title), title: 'Characters, places and props as 3D models, skyboxes and sounds, for Unity and web games' }, icon('download'), 'Take this world into a game');
}
