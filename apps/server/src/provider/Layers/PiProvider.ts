import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderCapabilities,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { PiSettings } from "../pi/PiSettings.ts";
import { makePiSessionRuntime, type PiNativeModel } from "../pi/PiSessionRuntime.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const VERSION_TIMEOUT_MS = 4_000;
const INVENTORY_TIMEOUT_MS = 20_000;

export const PI_PROVIDER_CAPABILITIES: ServerProviderCapabilities = {
  allowedRuntimeModes: ["full-access"],
  resumeReplay: true,
  imageInput: true,
  inSessionModelSwitching: true,
  thinkingLevelSwitching: true,
  steering: true,
  followUpQueue: false,
  extensionUiRequests: true,
  approvals: true,
  userInput: true,
  subagentLineage: false,
  workflowArtifacts: true,
  rollback: false,
  fork: false,
};

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

function modelCapabilities(model: PiNativeModel): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: model.reasoning
      ? [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({
              id,
              label: id === "xhigh" ? "Extra High" : id,
            })),
          },
        ]
      : [],
  });
}

export function piServerModel(model: PiNativeModel): ServerProviderModel {
  return {
    slug: `${model.provider}/${model.id}`,
    name: model.name,
    subProvider: model.provider,
    isCustom: false,
    capabilities: modelCapabilities(model),
  };
}

const withPiCapabilities = (draft: ServerProviderDraft): ServerProviderDraft => ({
  ...draft,
  capabilities: PI_PROVIDER_CAPABILITIES,
});

export const makePendingPiProvider = Effect.fn("makePendingPiProvider")(function* (
  settings: PiSettings,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return withPiCapabilities(
    buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Pi CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi is disabled in T3 Code settings.",
          },
    }),
  );
});

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return yield* makePendingPiProvider(settings);

  const versionResult = yield* Effect.gen(function* () {
    const resolved = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        shell: resolved.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(VERSION_TIMEOUT_MS), Effect.exit);

  if (versionResult._tag === "Failure") {
    const cause = versionResult.cause;
    return withPiCapabilities(
      buildServerProvider({
        driver: PROVIDER,
        presentation: PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: [],
        probe: {
          installed: !isCommandMissingCause(cause),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(cause)
            ? `Pi CLI not found at '${settings.binaryPath}'.`
            : "Pi CLI version probe failed.",
        },
      }),
    );
  }
  const collected = versionResult.value;
  if (Option.isNone(collected)) {
    return withPiCapabilities(
      buildServerProvider({
        driver: PROVIDER,
        presentation: PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: [],
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Pi CLI version probe timed out.",
        },
      }),
    );
  }
  const versionOutput = collected.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);

  const inventory = yield* Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* makePiSessionRuntime({
        binaryPath: settings.binaryPath,
        cwd,
        environment,
      });
      const [models, commands] = yield* Effect.all([
        runtime.getAvailableModels(),
        runtime.getCommands(),
      ]);
      return { models, commands };
    }),
  ).pipe(Effect.timeoutOption(INVENTORY_TIMEOUT_MS), Effect.exit);

  if (inventory._tag === "Failure" || Option.isNone(inventory.value)) {
    return withPiCapabilities(
      buildServerProvider({
        driver: PROVIDER,
        presentation: PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: [],
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Pi RPC inventory probe failed.",
        },
      }),
    );
  }

  const discovered = inventory.value.value;
  const slashCommands: ReadonlyArray<ServerProviderSlashCommand> = discovered.commands.map(
    (command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
    }),
  );
  return withPiCapabilities(
    buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: discovered.models.map(piServerModel),
      slashCommands,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
      },
    }),
  );
});
