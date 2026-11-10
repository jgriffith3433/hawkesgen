// Undo/redo stack for a document: each step keeps a JSON snapshot and an optional label of what undoing reverses
// (e.g. "AI added 3 clips"). Pure: no DOM. The timeline editor (project.js) and its tests use this.

/**
 * @param {{ limit?: number }} [opts]
 * @returns {{
 *   remember: (doc: unknown, label?: string | null) => void,
 *   undo: (doc: unknown) => { doc: unknown, label: string | null } | null,
 *   redo: (doc: unknown) => { doc: unknown, label: string | null } | null,
 *   canUndo: () => boolean,
 *   canRedo: () => boolean,
 *   undoLabel: () => string | null,
 *   redoLabel: () => string | null,
 *   clear: () => void,
 * }}
 */
export function createHistory({ limit = 120 } = {}) {
  const undo = [];
  const redo = [];
  const push = (stack, doc, label) => {
    stack.push({ snap: JSON.stringify(doc), label: label || null });
    if (stack.length > limit) stack.shift();
  };
  return {
    remember(doc, label) {
      push(undo, doc, label);
      redo.length = 0;
    },
    undo(doc) {
      if (!undo.length) return null;
      const entry = undo.pop();
      push(redo, doc, entry.label);
      return { doc: JSON.parse(entry.snap), label: entry.label };
    },
    redo(doc) {
      if (!redo.length) return null;
      const entry = redo.pop();
      push(undo, doc, entry.label);
      return { doc: JSON.parse(entry.snap), label: entry.label };
    },
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    undoLabel: () => undo[undo.length - 1]?.label ?? null,
    redoLabel: () => redo[redo.length - 1]?.label ?? null,
    clear() { undo.length = 0; redo.length = 0; },
  };
}

/** One short label for an AI editor turn from its applyOps results (ok ones only). */
export function aiTurnLabel(results) {
  const ok = (results ?? []).filter((r) => r && r.ok);
  if (!ok.length) return 'AI edit';
  const adds = ok.filter((r) => r.op === 'add' || r.op === 'text' || r.op === 'generate');
  const dels = ok.filter((r) => r.op === 'delete' || r.op === 'deleteRange');
  if (adds.length && adds.length === ok.length) {
    return adds.length === 1 ? 'AI added a clip' : `AI added ${adds.length} clips`;
  }
  if (dels.length && dels.length === ok.length) {
    return dels.length === 1 ? 'AI deleted a clip' : `AI deleted ${dels.length} clips`;
  }
  if (ok.length === 1) {
    const one = {
      add: 'AI added a clip', text: 'AI added text', generate: 'AI started making something',
      trim: 'AI trimmed a clip', split: 'AI split a clip', move: 'AI moved a clip',
      delete: 'AI deleted a clip', deleteRange: 'AI cut a stretch out', set: 'AI changed a clip',
      track: 'AI changed the tracks', settings: 'AI changed the scene',
    };
    return one[ok[0].op] ?? 'AI edit';
  }
  return `AI made ${ok.length} edits`;
}
