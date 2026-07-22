import {
  resolveServerProviderCapabilities,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";

export function allowedRuntimeModesForProvider(
  provider: Pick<ServerProvider, "capabilities"> | null | undefined,
): ReadonlyArray<RuntimeMode> {
  return resolveServerProviderCapabilities(provider?.capabilities).allowedRuntimeModes;
}

export function compatibleRuntimeMode(
  current: RuntimeMode,
  allowed: ReadonlyArray<RuntimeMode>,
): RuntimeMode | null {
  if (allowed.includes(current)) return current;
  return allowed[0] ?? null;
}
