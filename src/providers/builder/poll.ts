// Reading server/builder/poll.ps1's answer: {"started","exit","error","length","text"} as one line of JSON.
//
// poll.ps1 now sends the log chunk as base64 ("b64"), so Unity's log can't break the JSON. An older poll.ps1 (a build
// that was already running when Gen updated) sends it as "text", and PowerShell's JSON writer can leave raw control
// characters from the Unity log in it (the Build Report table), which JSON.parse rejects.

/** Drops the control characters JSON forbids inside strings (U+0000–U+001F except \t, \n, \r), and turns raw \t, \n,
 *  \r inside string literals into their escapes. Outside strings they're whitespace and stay. */
export function cleanPollJson(raw: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const code = c.charCodeAt(0);
    if (inString) {
      if (c === '\\') { out += c + (raw[++i] ?? ''); continue; }
      if (c === '"') inString = false;
      else if (code < 0x20) {
        if (c === '\t') out += '\\t';
        else if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        continue;
      }
      out += c;
    } else {
      if (c === '"') inString = true;
      out += c;
    }
  }
  return out;
}

export type PollAnswer = { started?: boolean; exit: number | null; error: string | null; length: number; text: string };

/** Parses a poll answer, cleaning it if it needs it. Throws if it still can't be read. Decodes "b64" chunks with the
 *  given decoder (streaming, so a UTF-8 character split across two chunks comes out whole). */
export function parsePoll(raw: string, decoder = new TextDecoder()): PollAnswer {
  const s = raw.trim();
  let p: any;
  try {
    p = JSON.parse(s);
  } catch {
    p = JSON.parse(cleanPollJson(s));
  }
  if (!p || typeof p !== 'object') throw new Error('the poll answer is not a JSON object');
  const text = typeof p.b64 === 'string' && p.b64 ? decoder.decode(Buffer.from(p.b64, 'base64'), { stream: true }) : String(p.text ?? '');
  return { started: p.started, exit: p.exit ?? null, error: p.error ?? null, length: Number(p.length) || 0, text };
}

/** Where an unreadable answer says the chunk ends ("length" comes before the log text), so the poll can skip it. */
export function pollLengthOf(raw: string): number | null {
  const m = raw.match(/"length"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}
