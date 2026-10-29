import type { Tool } from './types.ts';
import { GenError } from '../util.ts';

/** Checks a job's params against its tool: fills defaults, converts types, rejects unknown or out-of-range values. */
export function validateParams(tool: Tool, raw: Record<string, unknown> = {}) {
  const out: Record<string, any> = {};
  const problems: string[] = [];
  for (const k of Object.keys(raw)) if (!(k in tool.params)) problems.push(`${tool.id} has no param "${k}" (it takes: ${Object.keys(tool.params).join(', ')})`);
  for (const [name, spec] of Object.entries(tool.params)) {
    let v: any = raw[name];
    if (v === undefined || v === null || v === '') {
      if (spec.required) problems.push(`${name} is required`);
      else if (spec.default !== undefined) out[name] = spec.default;
      continue;
    }
    switch (spec.type) {
      case 'number':
      case 'integer': {
        const n = Number(v);
        if (!Number.isFinite(n) || (spec.type === 'integer' && !Number.isInteger(n))) problems.push(`${name} must be ${spec.type === 'integer' ? 'a whole number' : 'a number'}`);
        else if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) problems.push(`${name} must be between ${spec.min ?? '-∞'} and ${spec.max ?? '∞'}`);
        else out[name] = n;
        break;
      }
      case 'boolean':
        if (typeof v === 'string') v = v === 'true' || v === '1';
        out[name] = Boolean(v);
        break;
      case 'enum':
        if (!spec.values?.includes(String(v))) problems.push(`${name} must be one of ${spec.values?.join(', ')}`);
        else out[name] = String(v);
        break;
      case 'json':
        if (typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            // A json param that also takes a plain string (playtest.run's build: "blob:<sha>", a URL, or an object).
            if (spec.orString) {
              out[name] = v;
              break;
            }
            problems.push(`${name} must be JSON`);
            break;
          }
        }
        out[name] = v;
        break;
      default:
        out[name] = String(v);
    }
  }
  if (problems.length) throw new GenError(`Bad params for ${tool.id}: ${problems.join('; ')}`);
  return out;
}
