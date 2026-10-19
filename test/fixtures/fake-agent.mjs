// Stand-in for Cursor's `agent -p --output-format json`. Prints one result and exits.
const result = process.env.FAKE_AGENT_RESULT ?? '{"ok":true}';
process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: 's', duration_ms: 1 })}\n`);
