// The built-in `first-five` scenario of playtest.run: a cold player's first five minutes in any web game, played with
// only what is on screen (real clicks, taps and keys; no teleporting, no contract, no ?playtest hint, no setup).
// Hawkes Studio asks for it and judges the result (hawkesstudio docs/playtest.md "First five minutes", src/ftue.ts).
//
// It writes into result.events (t = seconds from page open):
//   { type:'milestone', detail:'gameplay' | 'first-input-accepted' | 'first-success' | 'tutorial-step:<x>' }
//   { type:'tap' }                      one per click or tap needed before gameplay
//   { type:'wall', detail: JSON {kind:'terms'|'sign-in'|'menu'|'loading'|'ad'|'other', label, seconds} }
//   { type:'dev-ui', detail: JSON {what, shot} }   developer panels or debug controls a public player can see
// and result.metrics['ftue.wordsMinuteOne'] (words visible on screen in the first 60 s: each distinct line of text
// counted once, so a menu that stays up isn't counted twice).
import { sleep } from '../util.ts';

export type WallKind = 'terms' | 'sign-in' | 'menu' | 'loading' | 'ad' | 'other';

export interface Clickable { i: number; text: string; x: number; y: number; tag: string; type: string; checked: boolean; }
export interface Scan {
  lines: string[];            // visible text, one entry per line
  clickables: Clickable[];    // visible things a person can press, with their center
  canvasShare: number;        // the biggest visible canvas as a share of the viewport (0..1)
  hasPassword: boolean;       // a visible password or e-mail field
  loadingBar: boolean;        // a visible progress bar
  dev: { what: string }[];    // developer panels and debug controls
  sig: { text: string; px: number[] }; // what the screen looks like now: text and a few canvas samples
}

export interface Wall { kind: WallKind; label: string; }
export interface Step { wall: Wall | null; act: { kind: 'click'; target: Clickable } | { kind: 'tap-middle' } | { kind: 'wait' } | null; }

const TERMS = /\b(terms|privacy|cookies?|consent|eula|age|gdpr|i agree|licen[cs]e)\b/i;
const SIGNIN = /\b(sign ?in|log ?in|sign ?up|register|create (an )?account|continue with (google|apple|facebook|email)|enter your email)\b/i;
const GUEST = /\b(guest|skip|not now|maybe later|no thanks|without (an )?account|offline|later)\b/i;
const START = /^(\W*)(play|start|new game|begin|continue|resume|tap to start|click to start|press start|enter|let'?s go|go|next|ok|okay|got it|done|close|solo|single ?player|play now|start game|start playing)\b/i;
const ACCEPT = /^(\W*)(accept|agree|i agree|i accept|allow|ok|okay|yes|confirm|continue|got it|i am 1[38]\+?|enter)\b/i;
const AD = /\b(advert|sponsored|watch (an )?ad|ad break|skip ad|ads? by|ad ends in)\b/i;
const LOADING = /\b(loading|please wait|preparing|downloading|initiali[sz]ing)\b|\b\d{1,3}\s?%/i;
const TUTORIAL = /^(press|tap|click|hold|use|swipe|drag|move|jump|touch|try|collect|walk|run|aim|shoot|hit|pick up|grab|talk|open)\b/i;
const SUCCESS = /(\+\s?\d+|\bscore\b|\bcoins?\b|collected|level up|you (win|won|did it)|nice|great job|well done|success|complete[d]?|quest|achievement|unlocked|perfect|combo)/i;

const wordsOf = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []);
const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);

/** Runs in the page: what a person sees and could press right now. No state kept. */
export function scanPage(): Scan {
  const vw = innerWidth, vh = innerHeight;
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05 || e.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  };
  const lines = ((document.body?.innerText as string) || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out: any[] = [];
  document.querySelectorAll('button, a[href], [role=button], [role=link], input[type=button], input[type=submit], input[type=checkbox], input[type=radio], summary, [onclick], label, [class*=btn], [class*=button], [tabindex="0"]').forEach((el) => {
    if (!shown(el)) return;
    const r = el.getBoundingClientRect();
    const input = el as HTMLInputElement;
    const own = (el.getAttribute('aria-label') || input.value || (el as HTMLElement).innerText || el.textContent || '').trim();
    const label = el.tagName === 'INPUT' ? ((input.labels && input.labels[0]?.innerText) || el.parentElement?.innerText || el.getAttribute('aria-label') || '').trim() : own;
    out.push({ i: out.length, text: label.replace(/\s+/g, ' ').slice(0, 120), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase(), type: input.type || '', checked: Boolean(input.checked), area: r.width * r.height });
  });
  // A label wrapping a checkbox is the same control: keep the box.
  const clickables = out.filter((c) => !(c.tag === 'label' && out.some((o) => o.tag === 'input' && o.text === c.text)));
  let canvasShare = 0;
  const px: number[] = [];
  document.querySelectorAll('canvas').forEach((c) => {
    if (!shown(c)) return;
    const r = c.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    canvasShare = Math.max(canvasShare, (w * h) / (vw * vh));
    if (px.length < 64) {
      try {
        const s = document.createElement('canvas');
        s.width = 8; s.height = 8;
        const g = s.getContext('2d')!;
        g.drawImage(c, 0, 0, 8, 8);
        const d = g.getImageData(0, 0, 8, 8).data;
        for (let k = 0; k < d.length; k += 16) px.push(d[k], d[k + 1], d[k + 2]);
      } catch { /* a canvas that can't be read */ }
    }
  });
  const dev: { what: string }[] = [];
  const seen = new Set<string>();
  document.querySelectorAll('.lil-gui, .dg.ac, .tp-dfw, #stats, .stats, .debug, #debug, [class*=debug], [id*=debug], [class*=cheat], [id*=cheat], [class*=devtools], [id*=devtools], [data-dev], button, a[href], [role=button], summary').forEach((el) => {
    if (!shown(el)) return;
    const idc = `${(el as HTMLElement).id} ${typeof (el as any).className === 'string' ? (el as any).className : ''}`;
    const text = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const hit = /lil-gui|dg ac|tp-dfw|\bstats\b/i.test(idc) ? `${idc.trim().split(/\s+/)[0]} panel` : DEV_TEST(idc) ? `${text || idc.trim().split(/\s+/)[0]}` : DEV_TEST(text) && el.tagName !== 'A' ? text : '';
    if (hit && !seen.has(hit.toLowerCase())) { seen.add(hit.toLowerCase()); dev.push({ what: hit }); }
  });
  function DEV_TEST(s: string) { return /(\bdebug\b|\bdev(eloper)? (tools|menu|panel|mode)\b|\bdev only\b|\bcheats?\b|god ?mode|no ?clip|teleport|skip level|unlock all|free coins|add coins|show hitboxes)/i.test(s); }
  return {
    lines,
    clickables,
    canvasShare,
    hasPassword: Boolean(Array.from(document.querySelectorAll('input[type=password], input[type=email]')).some(shown)),
    loadingBar: Boolean(Array.from(document.querySelectorAll('progress, [role=progressbar], [class*=progress], [id*=progress]')).some(shown)),
    dev,
    sig: { text: lines.join('|').slice(0, 4000), px },
  };
}

/** What is in the way, and what a person would do about it. Pure: tested without a browser. */
export function decide(scan: Scan, afterGameplay = false): Step {
  const text = scan.lines.join(' ');
  const press = (re: RegExp) => scan.clickables.find((c) => c.tag !== 'label' && c.type !== 'checkbox' && re.test(c.text));
  const unchecked = scan.clickables.find((c) => c.type === 'checkbox' && !c.checked && (TERMS.test(c.text) || TERMS.test(text)));
  const label = (s: string) => clean(s) || 'screen';

  // Terms, age gate, cookie banner: tick the box, then accept.
  if (TERMS.test(text) && (unchecked || press(ACCEPT)) && !(scan.canvasShare > 0.6 && !unchecked && !/\b(accept|agree)\b/i.test(text))) {
    if (unchecked) return { wall: { kind: 'terms', label: label(unchecked.text) }, act: { kind: 'click', target: unchecked } };
    const b = press(ACCEPT)!;
    return { wall: { kind: 'terms', label: label(b.text) }, act: { kind: 'click', target: b } };
  }
  // An ad: wait it out, or skip it when it can be skipped.
  if (AD.test(text)) {
    const skip = press(/\b(skip|close|continue)\b/i);
    return { wall: { kind: 'ad', label: label(scan.lines.find((l) => AD.test(l)) ?? 'ad') }, act: skip ? { kind: 'click', target: skip } : { kind: 'wait' } };
  }
  // Sign-in: the way past that needs no account (guest, skip), else it stays a wall.
  if (scan.hasPassword || (SIGNIN.test(text) && scan.clickables.some((c) => SIGNIN.test(c.text)))) {
    const guest = press(GUEST) ?? press(/^(\W*)(play|continue|start)\b.*\b(guest|anonymous|without)\b/i);
    return { wall: { kind: 'sign-in', label: label(scan.clickables.find((c) => SIGNIN.test(c.text))?.text ?? 'sign in') }, act: guest ? { kind: 'click', target: guest } : { kind: 'wait' } };
  }
  // Loading: nothing to press.
  if (scan.loadingBar || (LOADING.test(text) && scan.lines.join(' ').length < 400 && !scan.clickables.some((c) => START.test(c.text)))) {
    return { wall: { kind: 'loading', label: label(scan.lines.find((l) => LOADING.test(l)) ?? 'loading') }, act: { kind: 'wait' } };
  }
  // A menu: the button that starts the game.
  const start = press(START);
  if (start && !(afterGameplay && scan.canvasShare > 0.6 && scan.lines.length < 6)) {
    return { wall: { kind: 'menu', label: label(start.text) }, act: { kind: 'click', target: start } };
  }
  // Nothing readable and nothing to press, but no game drawn yet: probably a canvas menu (tap the middle) or still loading.
  if (!scan.lines.length && !scan.clickables.length && scan.canvasShare < 0.3) return { wall: { kind: 'loading', label: 'blank screen' }, act: { kind: 'wait' } };
  return { wall: null, act: null };
}

/** Is a screen something a player is playing (no wall, a game drawn or a page that moved on)? */
export function isGameplay(scan: Scan, step: Step, clicked: number) {
  if (step.wall) return false;
  if (scan.canvasShare >= 0.3) return true;
  return clicked > 0 && scan.lines.length > 0;
}

const keyFrom = (line: string): string | null => {
  const m = line.match(/\b(press|hit|tap)\s+(?:the\s+)?(space(?:bar)?|enter|escape|esc|e|f|w|a|s|d|q|r|up|down|left|right|arrow \w+|wasd)\b/i);
  if (!m) return null;
  const k = m[2].toLowerCase();
  if (k.startsWith('space')) return 'Space';
  if (k === 'enter') return 'Enter';
  if (k === 'esc' || k === 'escape') return 'Escape';
  if (k === 'wasd') return 'KeyW';
  if (/^arrow /.test(k)) return `Arrow${k[6].toUpperCase()}${k.slice(7)}`;
  if (['up', 'down', 'left', 'right'].includes(k)) return `Arrow${k[0].toUpperCase()}${k.slice(1)}`;
  return `Key${k.toUpperCase()}`;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const distance = (a: number[], b: number[]) => (a.length && a.length === b.length ? a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length : 0);

export interface FirstFiveOptions {
  seconds: number;           // how long to play (300)
  mobile: boolean;
  milestones: boolean;
  T: () => number;           // seconds since the page opened
  killed: () => string;
  /** Takes a screenshot; returns its index in the run's shots (or -1). */
  shot: (reason: string) => Promise<number>;
  ctx: { step(s: string): void; signal: AbortSignal };
  ev: <R>(f: any, arg?: any, ms?: number) => Promise<R>;
  page: any;
}

export interface FirstFiveResult {
  outcome: string;
  events: { t: number; type: string; detail?: string }[];
  metrics: Record<string, number>;
  log: string[];
  /** Dev-UI events whose `shot` is an index into the run's shots until the assets exist. */
  devShots: { event: number; shot: number }[];
}

/** Plays the first minutes. Never throws for a page that misbehaves: it says what it saw. */
export async function playFirstFive(o: FirstFiveOptions): Promise<FirstFiveResult> {
  const { page, T, ev } = o;
  const vp = page.viewportSize() ?? { width: o.mobile ? 390 : 1280, height: o.mobile ? 844 : 720 };
  const events: FirstFiveResult['events'] = [];
  const log: string[] = [];
  const devShots: FirstFiveResult['devShots'] = [];
  const metrics: Record<string, number> = { 'ftue.taps': 0, 'ftue.wallSeconds': 0, 'ftue.walls': 0 };
  const round = (n: number) => Math.round(n * 10) / 10;
  const milestone = (detail: string) => { if (o.milestones) events.push({ t: round(T()), type: 'milestone', detail }); };
  const act = (work: Promise<unknown>) => Promise.race([work, sleep(8000)]).catch(() => {});

  const press = async (x: number, y: number) => act(o.mobile ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
  const key = async (k: string) => { await act(page.keyboard.down(k)); await sleep(180); await act(page.keyboard.up(k)); };

  let clicks = 0;            // taps and clicks before gameplay
  let gameplayAt: number | null = null;
  let firstInput = false, firstSuccess = false;
  const seenLines = new Set<string>();
  let words60 = 0, maxWords = 0;
  const tutorial = new Set<string>();
  const devSeen = new Set<string>();
  let wall: { kind: WallKind; label: string; since: number } | null = null;
  const endWall = () => {
    if (!wall) return;
    const seconds = round(T() - wall.since);
    events.push({ t: round(T()), type: 'wall', detail: JSON.stringify({ kind: wall.kind, label: wall.label, seconds }) });
    metrics['ftue.wallSeconds'] = round(metrics['ftue.wallSeconds'] + seconds);
    metrics['ftue.walls']++;
    wall = null;
  };
  const clickedLabels = new Map<string, number>();
  let keyI = 0;
  let lastSig: Scan['sig'] | null = null;
  let nextShot = 20;

  const end = T() + o.seconds;
  await o.shot('first-screen');
  o.ctx.step('first five: playing like a new player');
  while (T() < end) {
    if (o.killed()) throw Object.assign(new Error(o.killed()), { name: 'Stuck' });
    if (o.ctx.signal.aborted) throw new Error('cancelled');
    let scan: Scan;
    try { scan = await ev<Scan>(scanPage, undefined, 10_000); } catch (e: any) { log.push(`scan failed: ${String(e.message).slice(0, 120)}`); await sleep(1000); continue; }
    const t = T();

    // Words on screen: first minute, each distinct line once.
    let now = 0;
    for (const l of scan.lines) {
      const n = wordsOf(l).length;
      now += n;
      if (t <= 60 && !seenLines.has(l)) { seenLines.add(l); words60 += n; }
    }
    maxWords = Math.max(maxWords, now);

    // Developer panels the public can see.
    for (const d of scan.dev) {
      const k = d.what.toLowerCase();
      if (devSeen.has(k)) continue;
      devSeen.add(k);
      const shot = await o.shot('dev-ui');
      events.push({ t: round(t), type: 'dev-ui', detail: JSON.stringify({ what: d.what, shot: shot >= 0 ? String(shot) : null }) });
      if (shot >= 0) devShots.push({ event: events.length - 1, shot });
    }

    const step = decide(scan, gameplayAt != null);
    const playing = isGameplay(scan, step, clicks);

    // Walls: a run of the same wall is one wall with the seconds it cost.
    if (gameplayAt == null) {
      if (step.wall && (!wall || wall.kind !== step.wall.kind)) { endWall(); wall = { ...step.wall, since: t }; }
      else if (!step.wall && wall) endWall();
    }

    if (gameplayAt == null && playing) {
      endWall();
      gameplayAt = round(t);
      events.push({ t: gameplayAt, type: 'milestone', detail: 'gameplay' });
      metrics['ftue.secondsToGameplay'] = gameplayAt;
      metrics['ftue.tapsBeforeGameplay'] = clicks;
      await o.shot('gameplay');
      lastSig = scan.sig;
      await sleep(600);
      continue;
    }

    if (gameplayAt == null) {
      // Pre-gameplay: do what the screen asks, one press at a time.
      if (step.act?.kind === 'click') {
        const c = step.act.target;
        const k = `${c.text}@${c.x},${c.y}`;
        const times = (clickedLabels.get(k) ?? 0) + 1;
        clickedLabels.set(k, times);
        if (times <= 3) {
          await press(c.x, c.y);
          clicks++;
          events.push({ t: round(T()), type: 'tap' });
        }
        await sleep(900);
        if (nextShot <= T() || step.wall?.kind === 'sign-in') { nextShot = T() + 20; await o.shot(`wall:${step.wall?.kind ?? 'screen'}`); }
        continue;
      }
      if (!step.wall && !scan.clickables.length && scan.canvasShare >= 0.05) {
        // A canvas menu (nothing in the page to read): a person taps the middle.
        await press(vp.width / 2, vp.height / 2);
        clicks++;
        events.push({ t: round(T()), type: 'tap' });
        await sleep(1200);
        continue;
      }
      if (nextShot <= T()) { nextShot = T() + 20; await o.shot(`wall:${step.wall?.kind ?? 'screen'}`); }
      await sleep(1200);
      continue;
    }

    // Gameplay: tutorial prompts, then input a player would give, and watch for it being accepted.
    for (const l of scan.lines) {
      if (tutorial.size < 12 && TUTORIAL.test(l) && l.length < 90) {
        const id = slug(l);
        if (id && !tutorial.has(id)) { tutorial.add(id); milestone(`tutorial-step:${id}`); }
      }
    }
    const hint = scan.lines.map(keyFrom).find(Boolean) as string | undefined;
    const before = scan.sig;
    const idle = lastSig ? distance(lastSig.px, before.px) : 0;
    const wasText = before.text;
    const keys = hint ? [hint] : ['KeyD', 'KeyW', 'Space', 'KeyA', 'ArrowRight', 'KeyS', 'Enter', 'KeyE', 'ArrowUp', 'ArrowLeft'];
    if (o.mobile) {
      const x = vp.width * (0.25 + Math.random() * 0.5), y = vp.height * (0.35 + Math.random() * 0.4);
      const btn = scan.clickables.find((c) => /\b(next|continue|ok|got it|tap|go)\b/i.test(c.text));
      await press(btn?.x ?? x, btn?.y ?? y);
    } else if (hint || keyI % 4 !== 3) {
      await key(keys[keyI++ % keys.length]);
    } else {
      keyI++;
      await press(vp.width * (0.3 + Math.random() * 0.4), vp.height * (0.3 + Math.random() * 0.4));
    }
    await sleep(500);
    let after: Scan;
    try { after = await ev<Scan>(scanPage, undefined, 10_000); } catch { continue; }
    lastSig = after.sig;
    if (!firstInput && (after.sig.text !== wasText || distance(before.px, after.sig.px) > Math.max(6, idle * 1.6))) {
      firstInput = true;
      milestone('first-input-accepted');
      if (o.milestones) metrics['ftue.secondsToFirstInput'] = round(T());
    }
    if (!firstSuccess && firstInput) {
      const added = after.lines.filter((l) => !before.text.includes(l)).join(' ');
      const nums = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
      const grew = nums(after.sig.text).reduce((a, b) => a + b, 0) > nums(before.text).reduce((a, b) => a + b, 0) && SUCCESS.test(after.sig.text);
      if (SUCCESS.test(added) || grew) {
        firstSuccess = true;
        milestone('first-success');
        if (o.milestones) metrics['ftue.secondsToFirstSuccess'] = round(T());
        await o.shot('first-success');
      }
    }
    if (nextShot <= T()) { nextShot = T() + 20; await o.shot('playing'); }
    await sleep(700);
  }
  endWall();
  metrics['ftue.wordsMinuteOne'] = words60;
  metrics['ftue.maxWordsOnScreen'] = maxWords;
  if (gameplayAt == null) log.push(`no gameplay reached in ${o.seconds} s`);
  if (gameplayAt != null && !firstInput) log.push('the game never visibly answered input');
  await o.shot('end');
  return { outcome: gameplayAt == null ? 'blocked' : 'done', events, metrics, log, devShots };
}
