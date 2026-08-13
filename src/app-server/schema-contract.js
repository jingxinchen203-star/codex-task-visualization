import { readFile } from "node:fs/promises";
import { join } from "node:path";

function pointerSegment(reference) {
  const match = typeof reference === "string" && reference.match(/^#\/definitions\/([^/]+)$/);
  if (!match || /~(?![01])/u.test(match[1])) return null;
  return match[1].replaceAll("~1", "/").replaceAll("~0", "~");
}

export function extractThreadSourceKinds(schema) {
  const definitionName = pointerSegment(schema?.properties?.sourceKinds?.items?.$ref);
  const definition = definitionName && schema?.definitions?.[definitionName];
  const sourceKinds = definition?.enum;
  const valid = definition?.type === "string"
    && Array.isArray(sourceKinds)
    && sourceKinds.length > 0
    && sourceKinds.every((value) => typeof value === "string" && value.length > 0)
    && new Set(sourceKinds).size === sourceKinds.length;
  if (!valid) throw new Error("sourceKinds schema definition is missing or invalid");
  return [...sourceKinds];
}

export async function readThreadSourceKinds(schemaDirectory) {
  const raw = await readFile(join(schemaDirectory, "v2", "ThreadListParams.json"), "utf8");
  return extractThreadSourceKinds(JSON.parse(raw));
}
