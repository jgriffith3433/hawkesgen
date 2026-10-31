// Starting from an idea instead of a blank scene: a few ready briefs per kind. Picking one makes the scene and asks its
// AI to build it (the AI editor, the AI director or the character AI), so the first thing a person sees is something
// happening. From "+" in the bar, the empty center ("start from an idea") and the command palette.

import { h, icon, toast } from './lib.js';
import { newScene, activeKind } from './scenes.js';

export const STARTERS = [
  { kind: 'world', icon: 'layers', title: 'Start a world', about: 'A sentence or a mood board: the AI builds the world, its people, places and a story',
    start: () => import('./world.js').then((w) => w.startWorld()) },
  { kind: 'video', icon: 'film', title: 'Trailer', about: 'A 15-second trailer with music and a title',
    prompt: 'Make a 15-second trailer: pick a strong idea, make 4 short shots that build, add music that fits and a title at the start.' },
  { kind: 'video', icon: 'image', title: 'Slideshow', about: 'Your latest pictures, moving gently, with music',
    prompt: 'Turn my latest pictures into a slideshow: each one with a slow push in, soft crossfades between them, and calm music under it all.' },
  { kind: 'video', icon: 'person', title: 'Talking character', about: 'A character who says a line to camera',
    prompt: 'Make a portrait of a friendly character and have them say a short, warm welcome line to camera.' },
  { kind: 'image', icon: 'image', title: 'Poster', about: 'A striking picture, a bold title, a tagline',
    prompt: 'Design a movie poster: a striking background picture, a bold title at the top and a short tagline at the bottom.' },
  { kind: 'image', icon: 'frame', title: 'Thumbnail', about: 'A bold video thumbnail with big words',
    prompt: 'Make a bold video thumbnail: one big, clear subject and three punchy words of text that read at a glance.' },
  { kind: 'audio', icon: 'mic', title: 'Podcast intro', about: 'A voiced 10-second intro over a music sting',
    prompt: 'Write and voice a 10-second podcast intro over a short music sting, with the music dipping under the voice.' },
  { kind: 'audio', icon: 'music', title: 'Ambience', about: 'A calm 30-second bed of rain and soft music',
    prompt: 'Make a calm 30-second ambience: gentle rain on its own track and soft music under it, fading in and out.' },
  { kind: 'stage', icon: 'cube', title: 'Two-person scene', about: 'Two people talk, framed like a film',
    prompt: 'Two people meet and talk: block them facing each other, give each a line, and frame it like a film with a slow push in.' },
  { kind: 'character', icon: 'person', title: 'A new character', about: 'Their look, a voice and their pictures',
    prompt: 'Make a character: a battle-worn space pilot with a dry sense of humor. Write their look, pick a voice that fits and make their pictures.' },
];

/** Makes the starter's scene and asks its AI to build it. */
export async function startFrom(s) {
  if (s.start) return s.start();
  try {
    await newScene(s.kind, { title: s.title });
    // The scene has mounted; give the AI pane a beat to switch to it, then ask.
    setTimeout(() => import('./ai.js').then((a) => a.askAi(s.prompt)), 400);
  } catch (err) { toast(err.message); }
}

/** Starters for the menu under "+", by kind. */
export function starterItems(close) {
  return STARTERS.map((s) => h('button', { class: 'menu-item', onclick: () => { close(); startFrom(s); } },
    h('span', { class: 'row' }, icon(s.icon), h('span', {}, h('b', {}, s.title), h('div', { class: 'muted small' }, s.about)))));
}

/** Ideas for the scene in front (the empty center): asking its AI right here, no new scene. */
export function ideasHere() {
  // Starting a world is offered everywhere: it's the way in to everything else.
  return STARTERS.filter((s) => s.kind === activeKind() || s.start).map((s) => h('button', { class: 'chip small', title: s.about, onclick: () => (s.start ? s.start() : import('./ai.js').then((a) => a.askAi(s.prompt))) }, s.title));
}
