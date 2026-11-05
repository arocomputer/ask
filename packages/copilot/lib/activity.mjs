/*
 * Best-effort ASK_EVENTS writer. Ask supplies an absolute, pre-created private regular file;
 * never create or truncate it, including across retries. Each append is one UTF-8 JSON line of
 * at most 16 KiB, newline included. Failure disables activity for this invocation only.
 * Kept inside each independently installable package; no shared runtime dependency.
 */
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Terminal escapes, controls and bidi overrides are untrusted display data. Redaction catches
// common credential forms only: arbitrary secrets and credentials split across chunks can escape it.
function clean(value, limit) {
  if (typeof value !== 'string') return '';
  return Buffer.from(value.slice(0, 64 * 1024), 'utf8').toString('utf8')
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/(\b[\w-]{0,64}(?:token|password|passwd|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .slice(0, limit).replace(/[\ud800-\udbff]$/, '');
}

/* Only explicit native arguments go through this, never a whole native event or reasoning. */
export function argumentsText(value) {
  try {
    return value === undefined ? '' : JSON.stringify(value);
  } catch {
    return '';
  }
}

export function activity(path) {
  let disabled = !path || !isAbsolute(path);
  return (type, text, tool) => {
    if (disabled) return;
    let fd;
    try {
      const event = { type, text: clean(text, 64 * 1024) };
      if (!event.text) return;
      if (typeof tool === 'string' && tool) event.tool = clean(tool, 128);
      const encode = () => Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
      let line = encode();
      if (line.length > 16 * 1024) {
        // Search by code point: JSON escaping and multibyte UTF-8 count toward the wire limit.
        const chars = Array.from(event.text);
        let low = 0;
        let high = chars.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          event.text = chars.slice(0, mid).join('') + '…';
          if (encode().length <= 16 * 1024) low = mid;
          else high = mid - 1;
        }
        event.text = chars.slice(0, low).join('') + '…';
        line = encode();
      }
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
        disabled = true;
        return;
      }
      // One append per event. Never retry a short write: it could leave an incomplete line.
      if (writeSync(fd, line) !== line.length) disabled = true;
    } catch {
      disabled = true;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { disabled = true; }
      }
    }
  };
}
