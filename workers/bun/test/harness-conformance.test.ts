import { join, resolve } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import type { SbxRunExecutionManager } from "../src/execution-environment/sbx-run.ts";
import { AntigravityHarness } from "../src/harnesses/antigravity/adapter.ts";
import { FakeHarness } from "../src/harnesses/fake/adapter.ts";
import { PiHarness } from "../src/harnesses/pi/adapter.ts";
import type {
  SessionBackendReadiness,
  TerminalSessionBackend,
} from "../src/session-host/types.ts";
import { harnessConformance } from "./harness-conformance.ts";

harnessConformance("Fake", () => new FakeHarness({ change_set: true }));

harnessConformance(
  "Antigravity",
  () =>
    new AntigravityHarness(readyHost("antigravity"), {} as WorkerConfig, {
      executionManager: {
        discoverAntigravity: async () => ({
          installed: true,
          authenticated: true,
          compatible: true,
          version: "1.2.7",
          models: [
            {
              provider: "antigravity",
              model: "gemini-test-high",
              displayName: "Gemini Test (High)",
              accountAvailability: "verified_available",
              reasoningCapability: { kind: "enumerated", values: ["high"] },
            },
          ],
          capabilities: ["native.mcp"],
          missingCapabilities: [],
          diagnostics: [],
        }),
      } as unknown as SbxRunExecutionManager,
      runNativeCommand: async (args) => ({
        exitCode: 0,
        stdout:
          args[0] === "--version"
            ? "1.2.2\n"
            : args[0] === "--help"
              ? "--conversation --effort --log-file --model --prompt-interactive\n"
              : args[0] === "models"
                ? "gemini-test-high\tGemini Test (High)\n"
                : `qe stdio enabled ${process.execPath} ${resolve(import.meta.dir, "..", "src", "harnesses", "control", "mcp-server.ts")}\n`,
        stderr: "",
      }),
    }),
);

harnessConformance("Pi", () => {
  const extension = join(
    import.meta.dir,
    "..",
    "src",
    "harnesses",
    "pi",
    "step-result-extension.ts",
  );
  return new PiHarness(readyHost("pi"), {} as WorkerConfig, {
    integrationPath: extension,
    resultExtensionPath: extension,
    permissionExtensionPath: extension,
    assistanceExtensionPath: extension,
    discoverModels: async () => ({
      authenticated: true,
      diagnostics: [],
      models: [
        {
          provider: "openai-codex",
          model: "scoped-test-model",
          displayName: "Scoped Test Model",
          accountAvailability: "unknown",
          reasoningCapability: {
            kind: "enumerated",
            values: ["off", "high"],
          },
        },
      ],
    }),
  });
});

function readyHost(harnessKind: string): TerminalSessionBackend {
  const readiness: SessionBackendReadiness = {
    backendKind: "herdr",
    harnessKind,
    status: "ready",
    ready: true,
    capabilities: [],
    missingCapabilities: [],
    diagnostics: [],
    provenance: { endpointGeneration: 1, testedProtocol: 22 },
  };
  return { readiness: async () => readiness } as TerminalSessionBackend;
}
