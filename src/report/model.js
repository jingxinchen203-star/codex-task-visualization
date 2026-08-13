export const GATE_IDS = Object.freeze([
  "windows_inventory", "secure_injection", "app_server_identity",
  "approval_lifecycle", "double_write_control", "dispatch_recovery", "local_api_security",
]);
export const EXECUTION_GATE_IDS = Object.freeze([
  "secure_injection", "app_server_identity", "approval_lifecycle",
  "double_write_control", "dispatch_recovery", "local_api_security",
]);
const passed = (gates, id) => gates.some((gate) => gate.id === id && gate.status === "pass");
export function evaluatePhases(gates) {
  const standalonePhase1 = passed(gates, "app_server_identity") ? "go" : "go-with-readonly-degradation";
  const injectedPhase1 = passed(gates, "secure_injection") ? "go" : "no-go";
  const phase2 = EXECUTION_GATE_IDS.every((id) => passed(gates, id)) ? "go" : "no-go";
  return { standalonePhase1, injectedPhase1, phase2, phase3: "blocked-by-git-gate" };
}
