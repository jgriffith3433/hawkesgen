import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function stripRootBlocks(css: string): string {
  return css.replace(/:root\s*\{[^}]*\}/g, '');
}

test('design tokens: gen.css and style.css define custom properties for colours, type scale, spacing, radii, shadows, focus ring and icons', () => {
  const genCss = read('dashboard/gen/gen.css');
  const adminCss = read('dashboard/style.css');
  const requiredTokens = [
    // Colours
    '--bg', '--panel', '--panel-2', '--panel-3', '--surface-overlay', '--surface-scrim',
    '--line', '--line-2', '--border', '--text', '--text-soft', '--text-inv', '--ink', '--on-primary', '--muted',
    '--accent', '--accent-ink', '--accent-2', '--accent-soft',
    '--danger', '--danger-soft', '--bad', '--warn', '--warn-soft', '--ok', '--ok-soft', '--chip',
    // Type scale
    '--font-sans', '--font-mono',
    '--text-2xs', '--text-xs', '--text-sm', '--text-base', '--text-md', '--text-lg', '--text-xl', '--text-2xl', '--text-3xl',
    '--leading-tight', '--leading-snug', '--leading-base', '--leading-relaxed',
    '--weight-normal', '--weight-medium', '--weight-semibold', '--weight-bold',
    // Spacing
    '--space-0', '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7', '--space-8', '--space-10', '--space-12',
    // Radii
    '--radius-xs', '--radius-sm', '--radius-md', '--radius', '--radius-lg', '--radius-xl', '--radius-2xl', '--radius-full',
    // Shadows
    '--shadow-sm', '--shadow-md', '--shadow', '--shadow-lg',
    // Focus ring
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
  }
});

test('no hard-coded hex colors outside :root token declarations across gen.css, worlds.css, style.css, bench.js and legal.html', () => {
  for (const file of ['dashboard/gen/gen.css', 'dashboard/gen/worlds.css', 'dashboard/style.css', 'dashboard/bench.js', 'dashboard/gen/legal.html']) {
    const body = stripRootBlocks(read(file));
    const hexMatches = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.deepEqual(hexMatches, [], `${file} should use CSS custom properties instead of hard-coded hex colors`);
  }
});

test('icon set: lib.js uses a single stroke icon family and editor toolbars share consistent 16px (--icon-md) sizing', () => {
  const libJs = read('dashboard/gen/lib.js');
  assert.match(libJs, /const svg = \(d, extra = ''\) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1\.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" \$\{extra\}>\$\{d\}<\/svg>`;/);
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
});
