/*
 * Best-effort ASK_EVENTS writer. Ask owns the pre-created private file; never create or
 * truncate it. Each append is one complete JSONL record, at most 16 KiB including LF.
 * Only obvious credentials are suppressed; this is not comprehensive redaction.
 */
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const LIMIT = 16 * 1024;

export function activityWriter(path = process.env.ASK_EVENTS) {
  let disabled = !path || !isAbsolute(path);
  const credentials = Object.entries(process.env)
    .filter(([key, value]) => /(?:api[_-]?key|token|secret|password|access[_-]?key)/i.test(key) && value.length >= 8)
    .map(([, value]) => value);
  const clean = (text) => {
    // Native strings are data, including tool names and tool output, never terminal controls.
    text = stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    for (const value of credentials) text = text.split(value).join('[redacted]');
    return text
      .replace(/(\b(?:Bearer|Basic)\s+)[^\s"'<>]+/gi, '$1[redacted]')
      .replace(/(\b(?:[\w-]*(?:api[_-]?key|token|secret|password|access[_-]?key)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
  };
  return (type, text, tool) => {
    if (disabled || !['message', 'reasoning', 'tool', 'tool_result'].includes(type) || typeof text !== 'string' || !text.trim()) return;
    let fd;
    try {
      const record = { type, text: clean(text) };
      if (typeof tool === 'string') record.tool = prefix(clean(tool), 256);
      const line = () => JSON.stringify(record) + '\n';
      let encoded = line();
      if (Buffer.byteLength(encoded) > LIMIT) {
        const full = record.text;
        let low = 0;
        let high = full.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          record.text = prefix(full, mid) + '…';
          if (Buffer.byteLength(line()) <= LIMIT) low = mid;
          else high = mid - 1;
        }
        record.text = prefix(full, low) + '…';
        encoded = line();
      }
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) { disabled = true; return; }
      const bytes = Buffer.from(encoded, 'utf8');
      if (writeSync(fd, bytes) !== bytes.length) disabled = true;
    } catch {
      disabled = true;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
  };
}

// A UTF-16 slice must not split an astral character when bounding the serialized UTF-8 line.
function prefix(text, end) {
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end] || '')) end--;
  return text.slice(0, end);
}
