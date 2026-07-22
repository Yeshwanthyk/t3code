import {
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  applyPiSubagentLineageTransition,
  decodePiSubagentLineageManifest,
  type PiSubagentLineageManifest,
} from "./PiSubagentLineage.ts";
import {
  projectPiSubagentLineageTransition,
  type PiSubagentLineageProjectionContext,
} from "./PiSubagentLineageProjection.ts";

export interface PiSubagentLineageIngestionScope {
  readonly providerInstanceId: ProviderInstanceId;
  readonly parentSessionId: string;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
}

export type PiSubagentLineageIngestionResult =
  | {
      readonly kind: "applied";
      readonly manifest: PiSubagentLineageManifest;
      readonly events: ReadonlyArray<ProviderRuntimeEvent>;
    }
  | {
      readonly kind: "unchanged";
      readonly manifest: PiSubagentLineageManifest;
      readonly events: readonly [];
    }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * Fail-closed boundary for an external producer that knows the real child
 * session identity. This class never discovers lineage from titles, paths,
 * cwd, tool text, or timestamps.
 */
export class PiSubagentLineageIngestion {
  readonly #scope: PiSubagentLineageIngestionScope;
  readonly #projection: PiSubagentLineageProjectionContext;
  readonly #manifests = new Map<string, PiSubagentLineageManifest>();

  constructor(scope: PiSubagentLineageIngestionScope) {
    this.#scope = scope;
    this.#projection = {
      providerInstanceId: scope.providerInstanceId,
      threadId: scope.threadId,
      ...(scope.turnId === undefined ? {} : { turnId: scope.turnId }),
    };
  }

  ingest(value: unknown): PiSubagentLineageIngestionResult {
    const decoded = decodePiSubagentLineageManifest(value);
    if (!decoded.ok) return { kind: "rejected", reason: decoded.reason };

    const candidate = decoded.manifest;
    if (
      candidate.parentProviderInstanceId !== this.#scope.providerInstanceId ||
      candidate.parentSessionId !== this.#scope.parentSessionId
    ) {
      return { kind: "rejected", reason: "lineage manifest is outside the bound parent scope" };
    }

    const previous = this.#manifests.get(candidate.runId);
    const transition = applyPiSubagentLineageTransition(previous, candidate);
    if (transition.kind === "rejected") {
      return { kind: "rejected", reason: transition.reason };
    }
    if (transition.kind === "unchanged") {
      return { kind: "unchanged", manifest: transition.manifest, events: [] };
    }

    this.#manifests.set(candidate.runId, candidate);
    return {
      kind: "applied",
      manifest: candidate,
      events: projectPiSubagentLineageTransition(this.#projection, previous, candidate),
    };
  }

  get(runId: string): PiSubagentLineageManifest | undefined {
    return this.#manifests.get(runId);
  }

  list(): ReadonlyArray<PiSubagentLineageManifest> {
    return [...this.#manifests.values()];
  }
}
