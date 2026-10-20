// Stand-in for `copilot -p ... --output-format json`: prints the SDK-style JSONL events.
const out = (type, data) => console.log(JSON.stringify({ type, data }));
out('session.start', {});
out('assistant.message_delta', { deltaContent: '{"ok"' });
out('assistant.message', { content: '{"ok":true}', toolRequests: [] });
out('assistant.usage', { model: 'gpt-5.4' });
out('session.idle', {});
