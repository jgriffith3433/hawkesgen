// The AI pane draws the conversation on show (dashboard/gen/aiview.js). 2026-11-02: in a world scene the AI answered
// but the pane showed the video editor's empty hello, because it looked at the video conversation instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiView } from '../dashboard/gen/aiview.js';

test("a scene's conversation shows, whatever the video project's conversation holds", () => {
  assert.equal(aiView({ director: false, scene: true, count: 3 }), 'messages');
});
test('each empty conversation gets its own hello', () => {
  assert.equal(aiView({ director: false, scene: true, count: 0 }), 'scene-hello');
  assert.equal(aiView({ director: false, scene: false, count: 0 }), 'project-hello');
  assert.equal(aiView({ director: true, scene: false, count: 0 }), 'director-hello');
});
test('the video conversation and the director show their messages', () => {
  assert.equal(aiView({ director: false, scene: false, count: 1 }), 'messages');
  assert.equal(aiView({ director: true, scene: false, count: 2 }), 'messages');
});
