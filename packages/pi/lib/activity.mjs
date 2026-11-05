/*
 * Pi 1.5.0 json-event.js/agent-core events: text_end is the complete visible block,
 * tool_execution_* marks execution, unlike toolcall_* argument generation. Emit text
 * once per block (not deltas plus snapshots). Raw thinking, signatures, result details
 * and images are excluded: Pi does not distinguish public reasoning summaries.
 */
import { activityWriter } from './activity-writer.mjs';

export function activity() {
  const emit = activityWriter();
  const blocks = new Set();
  const tools = new Set();
  return (event) => {
    if (event.type === 'message_start' && event.message?.role === 'assistant') blocks.clear();
    if (event.type === 'message_update') {
      const part = event.assistantMessageEvent;
      if (part?.type === 'text_end' && Number.isInteger(part.contentIndex) && part.contentIndex >= 0 && typeof part.content === 'string' && !blocks.has(part.contentIndex)) {
        blocks.add(part.contentIndex);
        emit('message', part.content);
      }
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (Array.isArray(event.message.content)) event.message.content.forEach((part, index) => {
        if (part?.type === 'text' && !blocks.has(index)) emit('message', part.text);
      });
      blocks.clear();
    }
    if (['tool_execution_start', 'tool_execution_end'].includes(event.type) && typeof event.toolName === 'string' && typeof event.toolCallId === 'string') {
      const key = JSON.stringify([event.type, event.toolCallId]);
      if (tools.has(key)) return;
      tools.add(key);
      if (event.type === 'tool_execution_start') {
        // Arguments are complete here, so credential assignments can be suppressed together.
        emit('tool', `Started${event.args && typeof event.args === 'object' ? ': ' + JSON.stringify(event.args) : ''}`, event.toolName);
      } else {
        const content = event.result?.content;
        const text = Array.isArray(content) ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
        emit('tool_result', `${event.isError ? 'Failed' : 'Completed'}${text.trim() ? ': ' + text : ''}`, event.toolName);
      }
    }
  };
}
