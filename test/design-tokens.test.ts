import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function stripRootBlocks(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const m = css.slice(i).match(/:root\s*\{/);
    if (!m || m.index == null) { out += css.slice(i); break; }
    out += css.slice(i, i + m.index);
    let j = i + m.index + m[0].length - 1;
    let depth = 0;
    while (j < css.length) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') {
        depth--;
        if (depth === 0) { j++; break; }
      }
      j++;
    }
    i = j;
  }
  return out.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rootBlock(css: string): string {
  const m = css.match(/:root\s*\{/);
  if (!m || m.index == null) return '';
  let j = m.index + m[0].length - 1;
  let depth = 0;
  while (j < css.length) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(m.index, j + 1);
    }
    j++;
  }
  return '';
}

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
  const L1 = luminance(parseHex(a));
  const L2 = luminance(parseHex(b));
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

function tokenHex(root: string, name: string): string {
  const m = root.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
  assert.ok(m, `token ${name} must be a hex colour in :root`);
  return m![1];
}

test('design tokens: gen.css and style.css define custom properties for colours, type scale, spacing, radii, shadows, focus ring and icons', () => {
  const genCss = read('dashboard/gen/gen.css');
  const adminCss = read('dashboard/style.css');
  const requiredTokens = [
    '--bg', '--panel', '--panel-2', '--panel-3', '--surface-overlay', '--surface-scrim',
    '--line', '--line-2', '--border', '--text', '--text-soft', '--text-inv', '--ink', '--on-primary', '--muted',
    '--accent', '--accent-ink', '--accent-2', '--accent-soft',
    '--danger', '--danger-soft', '--bad', '--warn', '--warn-soft', '--ok', '--ok-soft', '--chip',
    '--font-sans', '--font-mono',
    '--text-2xs', '--text-label', '--text-xs', '--text-sm', '--text-base', '--text-md', '--text-lg', '--text-xl', '--text-2xl', '--text-3xl',
    '--leading-tight', '--leading-snug', '--leading-base', '--leading-relaxed',
    '--weight-normal', '--weight-medium', '--weight-semibold', '--weight-bold',
    '--space-0', '--space-px', '--space-0-5', '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8', '--space-12',
    '--radius-hair', '--radius-xs', '--radius-sm', '--radius-md', '--radius', '--radius-lg', '--radius-xl', '--radius-2xl', '--radius-full',
    '--shadow-sm', '--shadow-md', '--shadow', '--shadow-lg', '--shadow-sheet',
    '--focus-border', '--focus-ring', '--focus-outline',
  ];
  for (const token of requiredTokens) {
    assert.match(genCss, new RegExp(`${token}\\s*:`), `gen.css defines ${token}`);
    assert.match(adminCss, new RegExp(`${token}\\s*:`), `style.css defines ${token}`);
  }
  for (const iconToken of ['--icon-xs', '--icon-sm', '--icon-md', '--icon-lg', '--icon-xl', '--icon-2xl', '--icon-stroke']) {
    assert.match(genCss, new RegExp(`${iconToken}\\s*:`), `gen.css defines ${iconToken}`);
    assert.match(adminCss, new RegExp(`${iconToken}\\s*:`), `style.css defines ${iconToken}`);
  }
  assert.match(genCss, /--icon-md:\s*16px/);
  assert.match(genCss, /--icon-lg:\s*20px/);
});

test('unified components: buttons (primary, secondary, ghost, danger), inputs, chips, cards and focus ring use design tokens', () => {
  for (const file of ['dashboard/gen/gen.css', 'dashboard/style.css']) {
    const css = read(file);
    assert.match(css, /\.primary,\s*button\.primary,\s*a\.btn\.primary\s*\{[^}]*background:\s*var\(--text\)/, `${file}: primary button`);
    assert.match(css, /\.secondary,\s*button\.secondary,\s*a\.btn\.secondary\s*\{[^}]*background:\s*var\(--panel-3\)/, `${file}: secondary button`);
    assert.match(css, /\.ghost,\s*button\.ghost,\s*a\.btn\.ghost\s*\{[^}]*background:\s*transparent/, `${file}: ghost button`);
    assert.match(css, /\.danger,\s*button\.danger,\s*a\.btn\.danger\s*\{[^}]*color:\s*var\(--danger\)/, `${file}: danger button`);
    assert.match(css, /input,\s*select,\s*textarea\s*\{[^}]*border-radius:\s*var\(--radius-md\)/, `${file}: unified inputs`);
    assert.match(css, /input:focus,\s*select:focus,\s*textarea:focus[^{]*\{[^}]*border-color:\s*var\(--focus-border\);\s*box-shadow:\s*var\(--focus-ring\)/, `${file}: input focus ring`);
    assert.match(css, /\.chip[^{]*\{[^}]*border-radius:\s*var\(--radius-full\)/, `${file}: unified chip`);
    assert.match(css, /\.card\s*\{[^}]*border-radius:\s*var\(--radius\)/, `${file}: unified card`);
    assert.match(css, /:where\(a, button, input, select, textarea, summary, \[tabindex\]:not\(\[tabindex="-1"\]\)\):focus-visible/, `${file}: focus ring on focusable elements`);
  }
});

test('no hard-coded hex, radius, shadow or spacing px outside :root in landing/editor/library/admin stylesheets', () => {
  const files = ['dashboard/gen/gen.css', 'dashboard/gen/worlds.css', 'dashboard/style.css'];
  for (const file of files) {
    const body = stripRootBlocks(read(file));
    const hexMatches = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.deepEqual(hexMatches, [], `${file}: hard-coded hex outside :root`);

    const rad = [...body.matchAll(/border-radius\s*:\s*([^;]+);/g)]
      .map((m) => m[1].trim())
      .filter((v) => /\d+px/.test(v.replace(/var\([^)]+\)/g, '').replace(/calc\([^)]+\)/g, '')));
    assert.deepEqual(rad, [], `${file}: hard-coded border-radius px outside :root`);

    const shad = [...body.matchAll(/box-shadow\s*:\s*([^;]+);/g)]
      .map((m) => m[1].trim())
      .filter((v) => /\d+px/.test(v.replace(/var\([^)]+\)/g, '').replace(/calc\([^)]+\)/g, '')));
    assert.deepEqual(shad, [], `${file}: hard-coded box-shadow px outside :root`);

    const spaceProps = /(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?\s*:\s*([^;]+);/g;
    const space = [...body.matchAll(spaceProps)]
      .map((m) => m[1].trim())
      .filter((v) => /\d+px/.test(v.replace(/var\([^)]+\)/g, '').replace(/calc\([^)]+\)/g, '')));
    assert.deepEqual(space, [], `${file}: hard-coded spacing px outside :root`);
  }
  // Bench / legal keep the earlier hex ban.
  for (const file of ['dashboard/bench.js', 'dashboard/gen/legal.html']) {
    const body = stripRootBlocks(read(file));
    const hexMatches = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.deepEqual(hexMatches, [], `${file} should use CSS custom properties instead of hard-coded hex colors`);
  }
});

test('text token pairs meet WCAG AA contrast (4.5:1)', () => {
  const root = rootBlock(read('dashboard/gen/gen.css'));
  const pairs: [string, string, string][] = [
    ['--text', '--bg', 'body text on page'],
    ['--text', '--panel', 'body text on panel'],
    ['--text', '--panel-2', 'body text on raised panel'],
    ['--text-soft', '--bg', 'soft text on page'],
    ['--muted', '--bg', 'muted text on page'],
    ['--muted', '--panel', 'muted text on panel'],
    ['--text-inv', '--text', 'primary button label'],
    ['--on-primary', '--canvas-bg', 'on-primary on canvas'],
    ['--danger', '--bg', 'danger on page'],
    ['--ok', '--bg', 'ok on page'],
    ['--accent-2', '--bg', 'accent-2 on page'],
  ];
  for (const [fg, bg, label] of pairs) {
    const ratio = contrast(tokenHex(root, fg), tokenHex(root, bg));
    assert.ok(ratio >= 4.5, `${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 (need ≥ 4.5:1)`);
  }
});

test('icon set: lib.js uses a single stroke icon family and editor toolbars share 16px / 20px sizing', () => {
  const libJs = read('dashboard/gen/lib.js');
  assert.match(libJs, /const svg = \(d, extra = ''\) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1\.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" \$\{extra\}>\$\{d\}<\/svg>`;/);
  assert.match(libJs, /export function installButtonVariants/);
  assert.match(libJs, /export function applyButtonVariant/);
  const iconBlock = libJs.slice(libJs.indexOf('export const ICON = {'), libJs.indexOf('export const icon ='));
  assert.ok(iconBlock.length > 200, 'located ICON table in lib.js');
  assert.doesNotMatch(iconBlock, /fill="currentColor"/, 'all icons in ICON use stroke paths, never filled shapes');

  const genCss = read('dashboard/gen/gen.css');
  assert.match(genCss, /\.bar\s+\.ico,\s*\.bar\s+\.ico-wrap,[\s\S]*?\.tl-bar\s+\.ico,\s*\.tl-bar\s+\.ico-wrap,[\s\S]*?width:\s*var\(--icon-md\);\s*height:\s*var\(--icon-md\);/);
  assert.match(genCss, /\.tb\s+\.ico\s*\{\s*width:\s*var\(--icon-md\);\s*height:\s*var\(--icon-md\);/);
  assert.match(genCss, /\.play\s+\.ico,\s*\.play\s+\.ico-wrap\s*\{\s*width:\s*var\(--icon-md\);\s*height:\s*var\(--icon-md\);\s*\}/);
});

test('landing, editor, library and admin pages load Inter and the shared stylesheet /gen/gen.css', () => {
  for (const page of ['dashboard/gen/index.html', 'dashboard/gen/legal.html', 'dashboard/index.html', 'src/adminpage.ts']) {
    const text = read(page);
    assert.match(text, /fonts\.googleapis\.com\/css2\?family=Inter/, `${page} loads Inter`);
    assert.match(text, /\/gen\/gen\.css/, `${page} loads /gen/gen.css`);
  }
  assert.match(read('dashboard/gen/gen.js'), /installButtonVariants\(\)/);
  assert.match(read('dashboard/app.js'), /installButtonVariants\(\)/);
});
