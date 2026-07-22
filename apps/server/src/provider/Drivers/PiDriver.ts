import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { checkPiProviderStatus, makePendingPiProvider } from "../Layers/PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { PiSettings } from "../pi/PiSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const REFRESH_INTERVAL = Duration.minutes(5);
const decodeSettings = Schema.decodeSync(PiSettings);
const MAINTENANCE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: "@earendil-works/pi-coding-agent",
  }),
);

export type PiDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService;

const stampIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const inheritedEnvironment = mergeProviderInstanceEnvironment(environment);
      const configuredAgentDir = effectiveConfig.agentDir?.trim();
      const processEnvironment = configuredAgentDir
        ? { ...inheritedEnvironment, PI_CODING_AGENT_DIR: configuredAgentDir }
        : inheritedEnvironment;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = stampIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const adapter = yield* makePiAdapter(effectiveConfig, {
        instanceId,
        environment: processEnvironment,
      });
      const textGeneration = yield* makePiTextGeneration(effectiveConfig, processEnvironment);
      const checkProvider = checkPiProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnvironment,
      ).pipe(
        Effect.map(stamp),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const settingsSource = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        maintenanceCapabilities: MAINTENANCE.resolve(),
        getSettings: settingsSource.getSettings,
        streamSettings: settingsSource.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingPiProvider(settings.provider).pipe(Effect.map(stamp)),
        checkProvider,
        refreshInterval: REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
