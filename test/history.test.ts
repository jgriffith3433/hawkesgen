// Undo/redo of an AI editor turn: one labelled step for a multi-op applyOps batch (dashboard/gen/history.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, aiTurnLabel } from '../dashboard/gen/history.js';
import { applyOps, newDoc } from '../src/timeline.ts';

test('aiTurnLabel: three add ops say "AI added 3 clips"', () => {
  assert.equal(aiTurnLabel([
    { op: 'add', ok: true },
    { op: 'text', ok: true },
    { op: 'generate', ok: true },
  ]), 'AI added 3 clips');
  assert.equal(aiTurnLabel([{ op: 'add', ok: true }]), 'AI added a clip');
  assert.equal(aiTurnLabel([{ op: 'trim', ok: true }, { op: 'move', ok: true }]), 'AI made 2 edits');
  assert.equal(aiTurnLabel([{ op: 'add', ok: false, error: 'no' }]), 'AI edit');
});

test('undo/redo of a multi-op AI turn restores the doc exactly and keeps the label', () => {
  const hist = createHistory();
  const before = newDoc('Cut', 'video');
  const { doc: after, results } = applyOps(before, [
    { op: 'text', text: 'One', start: 0, end: 2 },
    { op: 'text', text: 'Two', start: 2, end: 4 },
    { op: 'text', text: 'Three', start: 4, end: 6 },
  ], undefined, 'video');
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(after.clips.length, 3);

  const label = aiTurnLabel(results);
  assert.equal(label, 'AI added 3 clips');
  hist.remember(before, label);
  assert.equal(hist.canUndo(), true);
  assert.equal(hist.undoLabel(), 'AI added 3 clips');

  // Ctrl+Z: back to the empty timeline in one step.
  const undone = hist.undo(after);
  assert.ok(undone);
  assert.equal(undone.label, 'AI added 3 clips');
  assert.deepEqual(undone.doc, before);
  assert.equal(hist.canRedo(), true);
  assert.equal(hist.redoLabel(), 'AI added 3 clips');

  // Redo: the three clips come back together.
  const redone = hist.redo(undone.doc);
  assert.ok(redone);
  assert.equal(redone.doc.clips.length, 3);
  assert.deepEqual(redone.doc.clips.map((c: { text?: string }) => c.text), ['One', 'Two', 'Three']);
  assert.equal(hist.undoLabel(), 'AI added 3 clips');
});
