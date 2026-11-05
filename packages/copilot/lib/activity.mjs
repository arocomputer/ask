export { activityWriter as activity } from './activity-writer.mjs';

/* Only explicit native arguments go through this, never a whole native event or reasoning. */
export function argumentsText(value) {
  try {
    return value === undefined ? '' : JSON.stringify(value);
  } catch {
    return '';
  }
}
