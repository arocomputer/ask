/*
 * OpenCode v1.2.9 run.ts and v2.2.5's bundled CLI emit completed text parts and
 * tool_use only on completion/error, not execution starts. Do not invent starts or
 * enable --thinking: these streams do not identify public reasoning summaries.
 */
import { activityWriter } from './activity-writer.mjs';

export function activity() {
  const emit = activityWriter();
  const seen = new Set();
  return (event) => {
    const part = event.part;
    if (!part || typeof part !== 'object') return;
    if (event.type === 'text' && !part.synthetic && typeof part.text === 'string') {
      if (typeof part.id === 'string') {
        const key = JSON.stringify(['text', part.messageID, part.id]);
        if (seen.has(key)) return;
        seen.add(key);
      }
      emit('message', part.text);
    }
    if (event.type === 'tool_use' && typeof part.tool === 'string' && ['completed', 'error'].includes(part.state?.status)) {
      const id = part.callID ?? part.id;
      if (typeof id === 'string') {
        const key = JSON.stringify(['tool', part.messageID, id]);
        if (seen.has(key)) return;
        seen.add(key);
      }
      const state = part.state;
      const detail = state.status === 'error' ? state.error : state.output;
      emit('tool_result', `${state.status === 'error' ? 'Failed' : 'Completed'}${typeof detail === 'string' && detail.trim() ? ': ' + detail : ''}`, part.tool);
    }
  };
}
