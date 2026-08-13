export const INTERACTIVE_THREAD_SOURCE_KINDS = Object.freeze([]);

export function validateThreadSourceFilter(value) {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || entry.length === 0)
    || new Set(value).size !== value.length) {
    throw new TypeError("sourceKinds must contain unique nonempty strings when supplied");
  }
  return value;
}
