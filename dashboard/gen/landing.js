// The welcome for people who aren't signed in (J, 2026-10-30: "a landing type of experience ... basically be selling what
// it can do. Show 3 categories and highlight its strengths. The goal is to tell the user what the website is and have
// them sign up"). It covers the app until they sign in, sign up, or choose to look around first (for this visit); the
// bar's Sign in and the help menu's "What is Hawkes Gen?" bring it back. A small live sketch of the app (media, the
// frame, the timeline with its playhead, the AI's reply) shows what they're signing up for. Works the same on a phone.

import { $, h, bus, icon } from './lib.js';
import { state, needSignIn } from './account.js';

const LOOK_KEY = 'hg.landing.looked';

const CATEGORIES = [
  { icon: 'film', title: 'Edit', lead: 'Video, pictures and sound on one timeline.',
    points: ['Drag anything onto any track', 'Layers, words, fades and transitions', 'Export a video, a picture or a mix'] },
  { icon: 'cube', title: 'Direct', lead: 'Design the perfect shot in 3D.',
    points: ['Cast characters and block their moves', 'Place the camera, add props and screens', 'Gen films your stage into video'] },
  { icon: 'sparkle', title: 'Generate', lead: 'Every AI tool, in one place.',
    points: ['Images, video, voices, music, effects', '3D models and characters you can animate', 'Remove backgrounds, relight, upscale, animate'] },
];
const STRENGTHS = [
  { icon: 'sparkle', title: 'An AI that edits with you', text: 'Say "make it slow motion" or "add music that fits". It does the fiddly parts and every change can be undone.' },
  { icon: 'layers', title: 'Scenes that plug together', text: 'A 3D shot becomes a clip in your video, a mix plays under it. Change one and the others can update.' },
  { icon: 'move', title: 'Drag and drop, everywhere', text: 'Media onto tracks, characters onto stages. It tells you where things will land, and why when they can\'t.' },
  { icon: 'phone', title: 'On your phone too', text: 'The same studio fits your pocket: hold a tile and drag it onto the timeline.' },
];

export function initLanding() {
  bus.on('signedIn', () => hide());
  bus.on('ready', (user) => { if (!user && !looked()) show(); });
}
const looked = () => { try { return sessionStorage.getItem(LOOK_KEY) === '1'; } catch { return false; } };

/** Shows the welcome (`browsing`: someone signed in opened it from the help menu, so it only closes). */
export function show({ browsing = false } = {}) {
  let el = $('#landing');
  if (!el) { el = build(); document.body.append(el); }
  el.classList.toggle('browsing', browsing || Boolean(state.user));
  el.hidden = false;
  el.scrollTop = 0;
  document.body.classList.add('landing-open');
  void el.offsetWidth; // start the fade now (an animation frame never comes in a background tab)
  el.classList.add('in');
}
export function hide() {
  const el = $('#landing');
  if (!el || el.hidden) return;
  el.classList.remove('in');
  document.body.classList.remove('landing-open');
  setTimeout(() => { el.hidden = true; }, 220);
}

function start(mode) { needSignIn(() => hide(), mode); }

function build() {
  const cta = (big = false) => h('div', { class: `ld-cta${big ? ' big' : ''}` },
    h('button', { class: 'primary', onclick: () => start('signup') }, 'Start free'),
    h('button', { class: 'ghost', onclick: () => start('login') }, 'Sign in'));
  const el = h('div', { id: 'landing', class: 'landing', role: 'dialog', 'aria-label': 'Welcome to Hawkes Gen', hidden: true },
    h('header', { class: 'ld-nav' },
      h('span', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), h('b', {}, 'Hawkes Gen')),
      h('span', { class: 'tl-spacer' }),
      h('button', { class: 'ghost small ld-close', onclick: () => hide() }, 'Back to the studio'),
      h('button', { class: 'ghost small ld-signin', onclick: () => start('login') }, 'Sign in'),
      h('button', { class: 'primary small ld-signin', onclick: () => start('signup') }, 'Start free')),
    h('section', { class: 'ld-hero' },
      h('div', { class: 'ld-copy' },
        h('p', { class: 'ld-kicker' }, 'An AI studio for everything you make'),
        h('h1', {}, 'Make videos, pictures and sound, with an AI beside you.'),
        h('p', { class: 'ld-sub' }, 'Edit on a timeline, direct shots in 3D, and generate images, video, voices, music and 3D models, all in one place. Tell the AI what you want; it handles the details.'),
        cta(),
        h('p', { class: 'ld-note' }, 'Free credits to start. No card needed.'),
        h('button', { class: 'link small ld-look', onclick: () => { try { sessionStorage.setItem(LOOK_KEY, '1'); } catch { /* */ } hide(); } }, 'Look around first →')),
      sketch()),
    h('section', { class: 'ld-cats' },
      ...CATEGORIES.map((c) => h('article', { class: 'ld-cat' },
        h('span', { class: 'ld-cat-ico' }, icon(c.icon)), h('h2', {}, c.title), h('p', { class: 'ld-cat-lead' }, c.lead),
        h('ul', {}, ...c.points.map((p) => h('li', {}, p)))))),
    h('section', { class: 'ld-strengths' },
      h('h2', {}, 'Why it feels different'),
      h('div', { class: 'ld-grid' }, ...STRENGTHS.map((s) => h('div', { class: 'ld-str' }, h('span', { class: 'ld-str-ico' }, icon(s.icon)), h('div', {}, h('b', {}, s.title), h('p', {}, s.text)))))),
    h('section', { class: 'ld-end' }, h('h2', {}, 'Start making something.'), cta(true)),
    h('footer', { class: 'ld-foot' }, h('a', { href: '/legal#terms' }, 'Terms'), ' · ', h('a', { href: '/legal#privacy' }, 'Privacy'), ' · ', h('a', { href: '/legal#refunds' }, 'Refunds'), ' · ', h('a', { href: 'mailto:support@hawkesgen.ai' }, 'Contact')));
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.classList.contains('browsing')) hide(); });
  return el;
}

/** A little live drawing of the studio: media on the left, the frame in the middle, the AI on the right, the timeline below. */
function sketch() {
  return h('div', { class: 'ld-sketch', 'aria-hidden': 'true' },
    h('div', { class: 'sk-app' },
      h('div', { class: 'sk-left' }, ...['a', 'b', 'c', 'd'].map((k) => h('span', { class: `sk-tile t-${k}` }))),
      h('div', { class: 'sk-center' }, h('div', { class: 'sk-frame' }, h('span', { class: 'sk-sun' }), h('span', { class: 'sk-hill' }), h('span', { class: 'sk-title' }, 'NIGHT SHIFT'))),
      h('div', { class: 'sk-ai' },
        h('span', { class: 'sk-msg me' }, 'Add music that fits'),
        h('span', { class: 'sk-msg ai' }, 'Added a slow synth score under the voice ✓')),
      h('div', { class: 'sk-tl' },
        h('span', { class: 'sk-track' }, h('span', { class: 'sk-clip v1' }), h('span', { class: 'sk-clip v2' })),
        h('span', { class: 'sk-track' }, h('span', { class: 'sk-clip tx' })),
        h('span', { class: 'sk-track' }, h('span', { class: 'sk-clip au' })),
        h('span', { class: 'sk-playhead' }))));
}
