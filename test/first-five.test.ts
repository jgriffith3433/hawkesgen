// The first-five scenario: the decisions on what is on screen (no browser), a scripted player through a terms wall, a
// menu and a game with a debug button (a fake page), and the fixture page itself when Playwright is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decide, isGameplay, playFirstFive, type Scan, type Clickable } from '../src/tools/firstfive.ts';

const btn = (text: string, o: Partial<Clickable> = {}): Clickable => ({ i: 0, text, x: 100, y: 100, tag: 'button', type: '', checked: false, ...o });
const scan = (o: Partial<Scan> = {}): Scan => ({ lines: [], clickables: [], canvasShare: 0, hasPassword: false, loadingBar: false, dev: [], sig: { text: '', px: [] }, ...o });

test('decide: terms first the box, then Accept; a menu presses Play; sign-in without a guest way stays a wall', () => {
  const terms = scan({ lines: ['Please read our Terms of Service'], clickables: [btn('I agree to the terms', { tag: 'input', type: 'checkbox' }), btn('Accept')] });
  const a = decide(terms);
  assert.equal(a.wall?.kind, 'terms');
  assert.equal((a.act as any).target.type, 'checkbox');
  terms.clickables[0].checked = true;
  assert.equal((decide(terms).act as any).target.text, 'Accept');

  const menu = decide(scan({ lines: ['Fixture Run', 'Play'], clickables: [btn('Play')] }));
  assert.equal(menu.wall?.kind, 'menu');

  const signin = decide(scan({ lines: ['Sign in to continue'], clickables: [btn('Sign in with Google')], hasPassword: false }));
  assert.equal(signin.wall?.kind, 'sign-in');
  assert.equal(signin.act?.kind, 'wait');
  const guest = decide(scan({ lines: ['Sign in to continue'], clickables: [btn('Sign in with Google'), btn('Play as guest')] }));
  assert.equal((guest.act as any).target.text, 'Play as guest');

  assert.equal(decide(scan({ lines: ['Loading 42%'] })).wall?.kind, 'loading');
  assert.equal(decide(scan({ lines: ['Watch an ad to continue'] })).wall?.kind, 'ad');
  assert.equal(decide(scan({ lines: ['Score 0'], canvasShare: 0.9 })).wall, null);
});

test('isGameplay: a big canvas with nothing in the way is gameplay; a wall never is', () => {
  const g = scan({ canvasShare: 0.9, lines: ['Score 0'] });
  assert.ok(isGameplay(g, decide(g), 1));
  const w = scan({ lines: ['Loading'], canvasShare: 0.9 });
  assert.ok(!isGameplay(w, decide(w), 1));
});

/** A page that is a state machine: terms -> menu -> game, with a debug button once playing. */
function fakePage(mobile: boolean) {
  const st = { stage: 'terms', agreed: false, score: 0, tick: 0, taps: 0 };
  const view = (): Scan => {
    if (st.stage === 'terms') return scan({ lines: ['Before you play', 'Please read our Terms of Service and Privacy Policy.', 'I agree to the terms'], clickables: [btn('I agree to the terms', { tag: 'input', type: 'checkbox', checked: st.agreed, x: 50, y: 50 }), btn('Accept', { x: 60, y: 90 })] });
    if (st.stage === 'menu') return scan({ lines: ['Fixture Run', 'Play'], clickables: [btn('Play', { x: 80, y: 80 })] });
    return scan({ lines: ['Press Space to jump', `Score ${st.score}`], canvasShare: 0.95, dev: [{ what: 'Debug panel' }], sig: { text: `Press Space to jump|Score ${st.score}`, px: [st.tick % 2, 0, 0] } });
  };
  const click = (x: number, y: number) => {
    st.taps++;
    if (st.stage === 'terms') { if (x === 50) st.agreed = true; else if (st.agreed) st.stage = 'menu'; }
    else if (st.stage === 'menu') st.stage = 'game';
    else st.score += 10;
  };
  const page = {
    viewportSize: () => (mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 }),
    mouse: { click: async (x: number, y: number) => click(x, y) },
    touchscreen: { tap: async (x: number, y: number) => click(x, y) },
    keyboard: { down: async (k: string) => { if (st.stage === 'game' && k === 'Space') st.score += 10; }, up: async () => {} },
  };
  const ev = async () => { st.tick++; return view(); };
  return { page, ev, st };
}

for (const mobile of [false, true]) {
  test(`playFirstFive (${mobile ? 'phone' : 'desktop'}): terms wall, menu, gameplay, input, a debug panel, and the words`, async () => {
    const f = fakePage(mobile);
    const t0 = Date.now();
    const shots: string[] = [];
    const r = await playFirstFive({
      seconds: 8, mobile, milestones: true, T: () => Math.round((Date.now() - t0) / 100) / 10, killed: () => '',
      shot: async (reason) => { shots.push(reason); return shots.length - 1; },
      ctx: { step() {}, signal: new AbortController().signal }, ev: f.ev as any, page: f.page,
    });
    assert.equal(r.outcome, 'done');
    const kinds = r.events.map((e) => e.type);
    const walls = r.events.filter((e) => e.type === 'wall').map((e) => JSON.parse(e.detail!));
    assert.deepEqual(walls.map((w) => w.kind), ['terms', 'menu']);
    assert.ok(walls.every((w) => typeof w.seconds === 'number' && w.seconds >= 0 && w.label));
    assert.equal(kinds.filter((k) => k === 'tap').length, 3, 'checkbox, Accept, Play');
    const ms = r.events.filter((e) => e.type === 'milestone').map((e) => e.detail);
    assert.ok(ms.includes('gameplay'));
    assert.ok(ms.includes('first-input-accepted'));
    assert.ok(ms.includes('tutorial-step:press-space-to-jump'));
    // gameplay comes after the walls, the input after gameplay
    const at = (d: string) => r.events.find((e) => e.detail === d)!.t;
    assert.ok(at('gameplay') >= at('first-input-accepted') - 5 && at('first-input-accepted') >= at('gameplay'));
    const dev = r.events.find((e) => e.type === 'dev-ui')!;
    assert.equal(JSON.parse(dev.detail!).what, 'Debug panel');
    assert.equal(r.devShots.length, 1);
    assert.ok(r.metrics['ftue.wordsMinuteOne'] >= 12, `words ${r.metrics['ftue.wordsMinuteOne']}`);
    assert.equal(r.metrics['ftue.tapsBeforeGameplay'], 3);
  });
}

test('playFirstFive: a sign-in wall nobody can pass ends blocked, with the wall and its cost', async () => {
  const t0 = Date.now();
  const page = { viewportSize: () => ({ width: 1280, height: 720 }), mouse: { click: async () => {} }, touchscreen: { tap: async () => {} }, keyboard: { down: async () => {}, up: async () => {} } };
  const r = await playFirstFive({
    seconds: 3, mobile: false, milestones: true, T: () => (Date.now() - t0) / 1000, killed: () => '', shot: async () => -1,
    ctx: { step() {}, signal: new AbortController().signal }, page,
    ev: (async () => scan({ lines: ['Sign in to play'], clickables: [btn('Continue with Google')] })) as any,
  });
  assert.equal(r.outcome, 'blocked');
  const w = JSON.parse(r.events.find((e) => e.type === 'wall')!.detail!);
  assert.equal(w.kind, 'sign-in');
  assert.ok(w.seconds >= 2);
  assert.ok(!r.events.some((e) => e.type === 'milestone' && e.detail === 'gameplay'));
});

test('the fixture page has a terms wall and a menu in front of its game', () => {
  const html = fs.readFileSync('test/fixtures/first-five.html', 'utf8');
  assert.match(html, /I agree to the terms/);
  assert.match(html, /id="play"/);
  assert.match(html, /Debug panel/);
});

test('the fixture page played in a real browser (when Playwright is installed)', { skip: await (async () => { try { await import('playwright'); return false; } catch { return 'no playwright'; } })() }, async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true }).catch(() => null);
  if (!browser) return;
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto('file://' + process.cwd() + '/test/fixtures/first-five.html');
  const t0 = Date.now();
  const r = await playFirstFive({
    seconds: 12, mobile: false, milestones: true, T: () => (Date.now() - t0) / 1000, killed: () => '', shot: async () => -1,
    ctx: { step() {}, signal: new AbortController().signal }, page, ev: (f: any, a?: any) => page.evaluate(f, a),
  });
  await browser.close();
  assert.equal(r.outcome, 'done');
  assert.deepEqual(r.events.filter((e) => e.type === 'wall').map((e) => JSON.parse(e.detail!).kind), ['terms', 'menu']);
  assert.ok(r.events.some((e) => e.detail === 'first-input-accepted'));
  assert.ok(r.events.some((e) => e.type === 'dev-ui'));
});
