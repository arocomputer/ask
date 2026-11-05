import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/*
 * ASK_EVENTS is an optional, pre-created append-only JSONL sink. Each UTF-8 record, including
 * its newline, fits in 16 KiB. Keep this helper local: packages are installed independently.
 * Credential suppression is deliberately best-effort, not comprehensive redaction.
 */
function activitySink(path) {
  let fd;
  try {
    if (!path || !isAbsolute(path)) return;
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    return;
  }
  return (type, text, tool) => {
    if (fd === undefined || typeof text !== 'string' || !text.length) return;
    try {
      const clean = (value) => stripVTControlCharacters(value)
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
        .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]')
        .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|cookie|private[_-]?key|aws[_-]?(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?id))["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}&]+)/gi, '$1[redacted]')
        .replace(/(--(?:api-key|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
        .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,})\b/g, '[redacted]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
      // Round-trip malformed surrogate input before measuring the actual UTF-8 encoding.
      text = Buffer.from(clean(text), 'utf8').toString('utf8');
      if (!text.length) return;
      const record = { type, text };
      if (typeof tool === 'string' && tool) record.tool = Array.from(clean(tool)).slice(0, 128).join('');
      const line = (end) => JSON.stringify({ ...record, text: text.slice(0, end).replace(/[\uD800-\uDBFF]$/, '') }) + '\n';
      let low = 0;
      let high = text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(line(mid), 'utf8') <= 16 * 1024) low = mid;
        else high = mid - 1;
      }
      const bytes = Buffer.from(line(low), 'utf8');
      // One append write per record; never repair or skip an existing partial tail.
      if (writeSync(fd, bytes) !== bytes.length) throw new Error('short activity write');
    } catch {
      try { closeSync(fd); } catch {}
      fd = undefined;
    }
  };
}

const textContent = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : '';

/*
 * Claude's stream_event deltas are repeated in assistant messages. Match those snapshots to
 * their streamed blocks, including separate subagent streams. Thinking/signature blocks are
 * intentionally omitted: this wire format does not identify summary-only reasoning reliably.
 */
export function createActivity(path = process.env.ASK_EVENTS) {
  const emit = activitySink(path);
  if (!emit) return () => {};
  const streams = new Map();
  const messages = new Map();
  const tools = new Map();
  const results = new Set();
  const startTool = (block) => {
    if (typeof block.id !== 'string' || typeof block.name !== 'string' || tools.has(block.id)) return;
    tools.set(block.id, block.name);
    emit('tool', block.name, block.name);
  };
  return (event) => {
    if (!event || typeof event !== 'object') return;
    const parent = typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : '';
    if (event.type === 'stream_event') {
      const e = event.event;
      if (!e || typeof e !== 'object') return;
      if (e.type === 'message_start' && typeof e.message?.id === 'string') {
        const key = JSON.stringify([parent, e.message.id]);
        const state = messages.get(key) || { blocks: new Map(), snapshots: new Set() };
        messages.set(key, state);
        streams.set(parent, state);
      }
      const state = streams.get(parent);
      if (!state || !Number.isInteger(e.index) || e.index < 0) return;
      if (e.type === 'content_block_start' && e.content_block && !state.blocks.has(e.index)) {
        const block = e.content_block;
        state.blocks.set(e.index, { type: block.type, text: '' });
        if (block.type === 'tool_use') startTool(block);
        if (block.type === 'text' && typeof block.text === 'string') {
          state.blocks.get(e.index).text = block.text;
          emit('message', block.text);
        }
      }
      const block = state.blocks.get(e.index);
      if (e.type === 'content_block_stop' && block) block.closed = true;
      if (e.type === 'content_block_delta' && block?.type === 'text' && !block.closed && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
        block.text += e.delta.text;
        emit('message', e.delta.text);
      }
    } else if (event.type === 'assistant' && typeof event.message?.id === 'string' && Array.isArray(event.message.content)) {
      const key = JSON.stringify([parent, event.message.id]);
      const state = messages.get(key) || { blocks: new Map(), snapshots: new Set() };
      messages.set(key, state);
      for (const block of event.message.content) {
        if (block?.type === 'tool_use') startTool(block);
        if (block?.type !== 'text' || typeof block.text !== 'string' || state.snapshots.has(block.text)) continue;
        state.snapshots.add(block.text);
        const blocks = [...state.blocks.values()].filter((b) => b.type === 'text' && b.text);
        if (blocks.some((b) => b.text === block.text)) continue;
        const streamed = blocks.filter((b) => block.text.startsWith(b.text)).sort((a, b) => b.text.length - a.text.length)[0];
        emit('message', streamed ? block.text.slice(streamed.text.length) : block.text);
      }
    } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || results.has(block.tool_use_id)) continue;
        if (typeof block.content !== 'string' && !Array.isArray(block.content)) continue;
        results.add(block.tool_use_id);
        const text = textContent(block.content);
        emit('tool_result', block.is_error ? `Error: ${text}` : text || 'Completed', tools.get(block.tool_use_id));
      }
    }
  };
}
