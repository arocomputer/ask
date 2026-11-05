import { activityWriter } from './activity-writer.mjs';

const textContent = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : '';

/*
 * `codex exec --json` items are snapshots, not text deltas. Emit only new text suffixes and
 * actual tool lifecycle events. Native reasoning.text is a summary; raw reasoning fields and
 * unrelated event payloads never cross this boundary. No final-answer-file fallback is needed.
 */
export function createActivity(path = process.env.ASK_EVENTS) {
  if (!path) return () => {};
  const emit = activityWriter(path);
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

