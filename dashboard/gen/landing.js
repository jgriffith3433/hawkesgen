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
    h('button', { class: 'primary ld-google', onclick: () => start('signup') }, googleMark(), 'Sign in with Google'));
  const el = h('div', { id: 'landing', class: 'landing', role: 'dialog', 'aria-label': 'Welcome to Hawkes Gen', hidden: true },
    h('header', { class: 'ld-nav' },
      h('span', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), h('b', {}, 'Hawkes Gen')),
      h('span', { class: 'tl-spacer' }),
      h('button', { class: 'ghost small ld-close', onclick: () => hide() }, 'Back to the studio'),
      h('button', { class: 'primary small ld-signin', onclick: () => start('login') }, 'Sign in')),
    h('section', { class: 'ld-hero' },
      h('div', { class: 'ld-copy' },
        h('p', { class: 'ld-kicker' }, 'Hawkes Gen'),
        h('h1', {}, 'Make videos, pictures and sound with an AI beside you.'),
        h('p', { class: 'ld-sub' }, 'Edit on a timeline, direct shots in 3D, and generate images, voices, music and models.', h('br'), 'Tell the AI what you want; every price shows before you press.'),
        cta(),
        h('p', { class: 'ld-note' }, 'New accounts start with free credits. No card needed.'),
        h('button', { class: 'link small ld-look', onclick: () => { try { sessionStorage.setItem(LOOK_KEY, '1'); } catch { /* */ } hide(); } }, 'Look around first →')),
      sketch()),
    examples(),
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

const svg = (markup) => { const el = h('span', { class: 'ld-art', 'aria-hidden': 'true' }); el.innerHTML = markup; return el; };
const googleMark = () => svg('<svg viewBox="0 0 48 48" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.3 0 11.6-2.1 15.5-5.7l-7.5-5.8c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>');

/** Three example outputs, drawn here (no request): a picture, a clip, a voice line, each with the words that made it. */
const EXAMPLES = [
  { kind: 'Picture', prompt: '"A lighthouse at dusk, painted in oil"', price: 'Price shown before you press Make',
    art: '<svg viewBox="0 0 160 90"><defs><linearGradient id="exs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2f6e"/><stop offset="1" stop-color="#f2a65c"/></linearGradient></defs><rect width="160" height="90" fill="url(#exs)"/><circle cx="118" cy="30" r="9" fill="#ffe3a6"/><path d="M0 70 Q40 60 80 70 T160 68 V90 H0Z" fill="#12183a"/><path d="M62 70 L68 34 H76 L82 70Z" fill="#f3efe6"/><rect x="66" y="26" width="12" height="8" fill="#ffd36b"/><path d="M64 44 H80 M63.5 54 H80.5" stroke="#c0392b" stroke-width="4"/></svg>' },
  { kind: 'Clip', prompt: '"The camera pushes in on a rainy street"', price: 'Price shown before you press Make',
    art: '<svg viewBox="0 0 160 90"><rect width="160" height="90" fill="#10131f"/><g stroke="#6f86ff" stroke-width="1" opacity=".7"><path d="M20 0 L14 22 M50 8 L44 30 M90 0 L84 22 M120 12 L114 34 M144 2 L138 24 M70 40 L64 62 M30 50 L24 72 M110 48 L104 70"/></g><rect x="26" y="34" width="26" height="46" fill="#232a4d"/><rect x="62" y="22" width="34" height="58" fill="#2c3563"/><rect x="108" y="40" width="28" height="40" fill="#232a4d"/><g fill="#ffd36b"><rect x="70" y="30" width="6" height="8"/><rect x="82" y="46" width="6" height="8"/><rect x="34" y="44" width="5" height="7"/></g><path d="M0 80 H160 V90 H0Z" fill="#1b2140"/><path d="M62 52 L74 44 V60Z" fill="#fff" opacity="0"/></svg>' },
  { kind: 'Voice and music', prompt: '"A warm narrator, a slow synth bed"', price: 'Price shown before you press Make',
    art: '<svg viewBox="0 0 160 90"><rect width="160" height="90" fill="#0f2a33"/><g fill="#1fa3b8">' + Array.from({ length: 28 }, (_, i) => { const hgt = 8 + Math.abs(Math.sin(i * 0.7) * 34) + (i % 3) * 4; return `<rect x="${8 + i * 5.3}" y="${45 - hgt / 2}" width="3" height="${hgt}" rx="1.5"/>`; }).join('') + '</g></svg>' },
];
function examples() {
  return h('section', { class: 'ld-examples', 'aria-label': 'Examples of what Gen makes' },
    h('h2', {}, 'What it makes'),
    h('div', { class: 'ld-ex-grid' }, ...EXAMPLES.map((x) => h('figure', { class: 'ld-ex' },
      svg(x.art), h('figcaption', {}, h('b', {}, x.kind), h('span', { class: 'ld-ex-prompt' }, x.prompt), h('span', { class: 'ld-ex-price muted small' }, x.price))))));
}
