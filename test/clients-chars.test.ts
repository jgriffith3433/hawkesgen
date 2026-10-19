// The client sources products copy or reference must not contain raw invisible line breaks or spaces. U+2028/U+2029
// inside a C# literal end the line (CS1010 "Newline in constant"), which broke every Unity build that uses
// com.hawkes.analytics; in older JS they end a string literal too. Write them as escapes ('\u2028').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENTS = path.join(ROOT, 'clients');
const SOURCES = /\.(cs|js|mjs|cjs|ts|mts|jslib|py)$/;
const BAD: Record<string, string> = {
  '\u2028': 'U+2028 line separator',
  '\u2029': 'U+2029 paragraph separator',
  '\u0085': 'U+0085 next line',
  '\u200b': 'U+200B zero-width space',
  '\u00a0': 'U+00A0 no-break space',
  '\ufeff': 'U+FEFF byte order mark (inside the file)',
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (SOURCES.test(e.name)) out.push(p);
  }
  return out;
}

test('client sources have no raw U+2028/U+2029 or other invisible characters', () => {
  const files = sources(CLIENTS);
  assert.ok(files.some((f) => f.endsWith('HawkesAnalytics.cs')), 'the scan finds the Unity sources');
  const problems: string[] = [];
  for (const file of files) {
    // A BOM at the very start is how some editors save C#; only one later in the file is a problem.
    const text = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
    text.split('\n').forEach((line, i) => {
      for (const [ch, name] of Object.entries(BAD)) {
        if (line.includes(ch)) problems.push(`${path.relative(ROOT, file)}:${i + 1}: raw ${name}`);
      }
    });
  }
  assert.deepEqual(problems, [], 'write these as escapes (e.g. \'\\u2028\')');
});
