/**
 * Contract name reserved for the companion producer owned by pi-subagents.
 * T3 deliberately does not ship a heuristic producer for this contract.
 */
export const PI_SUBAGENT_LINEAGE_CONTRACT = "t3.pi-subagent-lineage/v1" as const;

export const PI_SUBAGENT_LINEAGE_EXTERNAL_PRODUCER_GAP = {
  installedPiVersion: "0.80.10",
  requiredOwner: "pi-subagents",
  requiredEmissionPoints: ["spawn", "progress", "settlement"] as const,
  reason:
    "The installed pi-subagents manager owns native child session identity, but its standard tool results and public Pi event-bus messages do not expose that identity or lifecycle.",
  forbiddenFallbacks: [
    "display-name matching",
    "cwd matching",
    "timestamp-window scanning",
  ] as const,
} as const;
