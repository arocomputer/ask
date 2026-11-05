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
 * `codex exec --json` items are snapshots, not text deltas. Emit only new text suffixes and
 * actual tool lifecycle events. Native reasoning.text is a summary; raw reasoning fields and
 * unrelated event payloads never cross this boundary. No final-answer-file fallback is needed.
 */
export function createActivity(path = process.env.ASK_EVENTS) {
  const emit = activitySink(path);
  if (!emit) return () => {};
  const items = new Map();
  const toolTypes = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call']);
  return (event) => {
    if (!event || !['item.started', 'item.updated', 'item.completed'].includes(event.type)) return;
    const item = event.item;
    if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') return;
    if (!['agent_message', 'reasoning'].includes(item.type) && !toolTypes.has(item.type)) return;
    const state = items.get(item.id) || { type: item.type, text: '', started: false, completed: false };
    if (state.type !== item.type || state.completed) return;
    items.set(item.id, state);
    if (item.type === 'agent_message' || item.type === 'reasoning') {
      if (typeof item.text === 'string' && item.text.startsWith(state.text)) {
        emit(item.type === 'reasoning' ? 'reasoning' : 'message', item.text.slice(state.text.length));
        state.text = item.text;
      }
    } else {
      const tool = item.type === 'mcp_tool_call' && typeof item.tool === 'string'
        ? (typeof item.server === 'string' ? `${item.server}.` : '') + item.tool
        : item.type === 'collab_tool_call' && typeof item.tool === 'string' ? item.tool : item.type;
      if (event.type === 'item.started' && !state.started) {
        state.started = true;
        const text = item.type === 'command_execution' ? item.command
          : item.type === 'web_search' ? item.query : tool;
        emit('tool', typeof text === 'string' && text ? text : tool, tool);
      }
      if (event.type === 'item.completed') {
        const status = ['completed', 'failed', 'declined'].includes(item.status) ? item.status : 'Completed';
        let text = status;
        if (item.type === 'command_execution') {
          if (Number.isInteger(item.exit_code)) text += ` (exit ${item.exit_code})`;
          if (typeof item.aggregated_output === 'string' && item.aggregated_output) text += `\n${item.aggregated_output}`;
        } else if (item.type === 'mcp_tool_call') {
          const output = textContent(item.result?.content);
          if (typeof item.error?.message === 'string') text += `\n${item.error.message}`;
          else if (output) text += `\n${output}`;
          else if (item.result?.structured_content != null) text += `\n${JSON.stringify(item.result.structured_content)}`;
        } else if (item.type === 'file_change' && Array.isArray(item.changes)) {
          for (const change of item.changes) {
            if (typeof change?.path === 'string' && ['add', 'delete', 'update'].includes(change.kind)) text += `\n${change.kind}: ${change.path}`;
          }
        } else if (item.type === 'web_search' && typeof item.query === 'string') {
          text += `\n${item.query}`;
        } else if (item.type === 'collab_tool_call' && item.agents_states && typeof item.agents_states === 'object') {
          for (const agent of Object.values(item.agents_states)) {
            if (typeof agent?.message === 'string') text += `\n${agent.message}`;
          }
        }
        emit('tool_result', text, tool);
      }
    }
    if (event.type === 'item.completed') state.completed = true;
  };
}

