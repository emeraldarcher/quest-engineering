import { join, resolve } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { AntigravityHarness } from "../src/harnesses/antigravity/adapter.ts";
import { FakeHarness } from "../src/harnesses/fake/adapter.ts";
import { PiHarness } from "../src/harnesses/pi/adapter.ts";
import type { TerminalSessionBackend } from "../src/session-host/types.ts";
import { harnessConformance } from "./harness-conformance.ts";

harnessConformance("Fake", () => new FakeHarness({ change_set: true }));

harnessConformance(
  "Antigravity",
  () =>
    new AntigravityHarness({} as TerminalSessionBackend, {} as WorkerConfig, {
      runNativeCommand: async (args) => ({
        exitCode: 0,
        stdout:
          args[0] === "--version"
            ? "1.2.2\n"
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
  return new PiHarness({} as TerminalSessionBackend, {} as WorkerConfig, {
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
          reasoningCapability: {
            kind: "enumerated",
            values: ["off", "high"],
          },
        },
      ],
    }),
  });
});
