// What the AI pane shows (dashboard/gen/ai.js drawMessages): the conversation, or one of its empty "hello" notes.
//
// 2026-11-02: in a world, character, place, prop or story scene the pane checked the video project's conversation
// before drawing, so with no video conversation on this device it showed the video hello ("What are we making?") over
// the scene's own conversation: the AI answered (200, a reply in "say") and nothing appeared, not even the question.
// Which conversation is on show decides, and only that one.

/**
 * director: the Director is open. scene: an image/audio/character/world/... scene's own conversation is on show.
 * count: how many messages the conversation on show has.
 * Returns 'director-hello', 'scene-hello', 'project-hello' or 'messages'.
 */
export function aiView({ director, scene, count }) {
  if (count > 0) return 'messages';
  if (director) return 'director-hello';
  return scene ? 'scene-hello' : 'project-hello';
}
