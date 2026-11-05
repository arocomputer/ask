/*
 * Best-effort ASK_EVENTS writer, copied into each independently installed package. Keep the
 * copies aligned; packages/test/activity-writer.mjs exercises each without runtime sharing.
 * Ask owns the absolute, pre-created private regular file. Never create or truncate it.
 * Credential suppression is incomplete, especially for secrets split across native chunks.
 */
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const LIMIT = 16 * 1024;

export function activityWriter(path = process.env.ASK_EVENTS) {
  let disabled = typeof path !== 'string' || !isAbsolute(path);
  const credentials = Object.entries(process.env)
    .filter(([key, value]) => /(?:api[_-]?key|token|secret|password|access[_-]?key)/i.test(key) && value.length >= 8)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
  const clean = (text) => {
    // Remove string controls (including unfinished ones) before stripping remaining VT codes.
    text = stripVTControlCharacters(text
      .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
      .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, ''))
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
    for (const value of credentials) text = text.split(value).join('[redacted]');
    text = text
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
      .replace(/\b(Bearer|Basic)\s+[^\s"',;<>]+/gi, '$1 [redacted]')
      .replace(/(\b[\w-]{0,64}(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|private[_-]?key|access[_-]?key)[\w-]{0,64}["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi, '$1[redacted]')
      .replace(/(--(?:api-key|access-token|refresh-token|token|password|secret)\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi, '$1[redacted]')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+)\b/g, '[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
    // Normalize malformed surrogates before measuring the UTF-8 record.
    return Buffer.from(text, 'utf8').toString('utf8');
  };
  return (type, text, tool) => {
    if (disabled || !['message', 'reasoning', 'tool', 'tool_result'].includes(type) || typeof text !== 'string' || !text.length) return;
    let fd;
    try {
      const record = { type, text: clean(text) };
      if (!record.text) return;
      if (typeof tool === 'string' && tool) record.tool = prefix(clean(tool), 128);
      const line = () => Buffer.from(JSON.stringify(record) + '\n', 'utf8');
      let bytes = line();
      if (bytes.length > LIMIT) {
        const full = record.text;
        let low = 0;
        let high = full.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          record.text = prefix(full, mid) + '…';
          if (line().length <= LIMIT) low = mid;
          else high = mid - 1;
        }
        record.text = prefix(full, low) + '…';
        bytes = line();
      }
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
        disabled = true;
        return;
      }
      // One append per record. A short/failed write may leave a partial tail: stop, never repair
      // or retry it. Reopen and validate each time so path/permission changes are noticed.
      if (writeSync(fd, bytes) !== bytes.length) disabled = true;
    } catch {
      disabled = true;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { disabled = true; } }
    }
  };
}

// Bound UTF-16 fields without splitting an astral character.
function prefix(text, end) {
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end] || '')) end--;
  return text.slice(0, end);
}
