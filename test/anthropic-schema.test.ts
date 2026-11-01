// Structured output takes closed schemas only: the API path sends a schema as a format only when every object in it is
// closed (additionalProperties: false), and leaves open ones (the assistants' free-form ops) to the prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isClosedSchema } = await import('../src/providers/anthropic.ts');

test('closed schemas are sent as a format; any open object keeps it out', () => {
  assert.equal(isClosedSchema({ type: 'object', additionalProperties: false, properties: { say: { type: 'string' } } }), true);
  assert.equal(isClosedSchema({ type: 'object', additionalProperties: false, properties: { list: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {} } } } }), true);
  // The AI editor's answer: ops are free-form objects.
  assert.equal(isClosedSchema({ type: 'object', additionalProperties: false, properties: { say: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } } }), false);
  // A nested open doc (the character AI).
  assert.equal(isClosedSchema({ type: 'object', additionalProperties: false, properties: { doc: { type: 'object' } } }), false);
  assert.equal(isClosedSchema({ type: 'string', enum: ['a', 'b'] }), true);
});
