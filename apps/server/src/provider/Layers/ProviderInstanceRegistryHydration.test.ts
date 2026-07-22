import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  const settings = {
    providerInstances: {},
    providers: {
      codex: { enabled: false, binaryPath: "legacy-codex" },
    },
  } as unknown as ServerSettings;

  it("uses a legacy fixed provider config when one exists", () => {
    const defaultConfig = vi.fn(() => ({ binaryPath: "default-codex" }));
    const configMap = deriveProviderInstanceConfigMap(settings, [
      { driverKind: ProviderDriverKind.make("codex"), defaultConfig },
    ]);

    expect(configMap[ProviderInstanceId.make("codex")]?.config).toEqual({
      enabled: false,
      binaryPath: "legacy-codex",
    });
    expect(defaultConfig).not.toHaveBeenCalled();
  });

  it("uses driver.defaultConfig when no legacy fixed provider config exists", () => {
    const defaultConfig = vi.fn(() => ({ binaryPath: "pi", enabled: true }));
    const configMap = deriveProviderInstanceConfigMap(settings, [
      { driverKind: ProviderDriverKind.make("pi"), defaultConfig },
    ]);

    expect(configMap[ProviderInstanceId.make("pi")]).toEqual({
      driver: "pi",
      config: { binaryPath: "pi", enabled: true },
    });
    expect(defaultConfig).toHaveBeenCalledOnce();
  });

  it("keeps an explicit provider instance ahead of legacy and driver defaults", () => {
    const explicit = {
      driver: ProviderDriverKind.make("pi"),
      config: { binaryPath: "/opt/pi" },
    };
    const defaultConfig = vi.fn(() => ({ binaryPath: "pi" }));
    const configMap = deriveProviderInstanceConfigMap(
      {
        ...settings,
        providerInstances: {
          [ProviderInstanceId.make("pi")]: explicit,
        },
      },
      [{ driverKind: ProviderDriverKind.make("pi"), defaultConfig }],
    );

    expect(configMap[ProviderInstanceId.make("pi")]).toEqual(explicit);
    expect(defaultConfig).not.toHaveBeenCalled();
  });
});
