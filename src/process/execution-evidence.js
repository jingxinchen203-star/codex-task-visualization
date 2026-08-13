import { codedError } from "./security-policy.js";

function requireDigest(value, operation, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/iu.test(value)) {
    throw codedError("EIDENTITYMISSING", `${operation} did not report ${label}`);
  }
  return value;
}

export function validateExecutionEvidence(result, operation) {
  if (result.identityStable === false) {
    throw codedError("EIDENTITYCHANGED", `${operation} execution identity changed`);
  }
  if (result.identityStable !== true) {
    throw codedError("EIDENTITYMISSING", `${operation} did not prove an exact execution identity`);
  }
  if (result.sourceStable === false) {
    throw codedError("ESOURCECHANGED", `${operation} source identity changed`);
  }
  if (result.sourceStable !== true) {
    throw codedError("EIDENTITYMISSING", `${operation} did not prove stable source identity`);
  }

  const executionDigest = requireDigest(result.execution?.digest, operation, "an execution digest");
  const nativeSha256 = requireDigest(
    result.execution?.files?.find(({ role }) => role === "native")?.sha256,
    operation,
    "native execution evidence",
  );
  const contextDigest = requireDigest(result.executionContext?.contextDigest, operation, "an execution context digest");
  requireDigest(result.executionContext?.environmentDigest, operation, "a controlled environment digest");

  const binding = result.binding;
  if (binding?.kind !== "private-staged-snapshot" || binding.exact !== true || !Array.isArray(binding.files) || binding.files.length === 0) {
    throw codedError("EIDENTITYMISSING", `${operation} did not retain an exact private staged binding`);
  }
  const executionByRole = new Map();
  for (const file of result.execution.files ?? []) {
    if (typeof file?.role !== "string" || executionByRole.has(file.role)) {
      throw codedError("EIDENTITYINCONSISTENT", `${operation} reported duplicate or invalid execution roles`);
    }
    executionByRole.set(file.role, file.sha256);
  }
  const boundRoles = new Set();
  for (const file of binding.files) {
    if (typeof file?.role !== "string" || boundRoles.has(file.role)) {
      throw codedError("EIDENTITYINCONSISTENT", `${operation} reported duplicate or invalid binding roles`);
    }
    boundRoles.add(file.role);
    const before = requireDigest(file.beforeSha256, operation, `a before digest for ${file.role}`);
    const after = requireDigest(file.afterSha256, operation, `an after digest for ${file.role}`);
    if (before !== after || executionByRole.get(file.role) !== before) {
      throw codedError("EIDENTITYINCONSISTENT", `${operation} binding does not match execution role ${file.role}`);
    }
  }
  if (!boundRoles.has("native") || executionByRole.get("native") !== nativeSha256) {
    throw codedError("EIDENTITYINCONSISTENT", `${operation} did not bind the reported native executable`);
  }
  return { executionDigest, nativeSha256, contextDigest };
}
