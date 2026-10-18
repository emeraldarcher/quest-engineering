import { expect, test } from "bun:test";
import {
  assertTrustedSetupLaunchAuthority,
  CLAUDE_LOGIN_INTERACTION_IDENTITY,
  CLAUDE_SUBSCRIPTION_SETUP_LAUNCHER_IDENTITY,
  ClaudeSubscriptionSetupLauncher,
  setupLaunchAuthority,
  validateSetupLaunchSpec,
} from "../src/execution-environment/provider-account-setup-launcher.ts";
import { SBX_CLAUDE_EXECUTABLE } from "../src/execution-environment/sbx-profile.ts";
import type { EnvironmentPathMap } from "../src/execution-environment/types.ts";
import {
  PHYSICAL_ACCEPTANCE_FIXTURE_EXECUTABLE,
  PHYSICAL_ACCEPTANCE_SETUP_LAUNCHER_IDENTITY,
  PhysicalAcceptanceSetupLauncher,
} from "./support/provider-account-setup-launcher.ts";

const paths: EnvironmentPathMap = {
  workspace: "/qe/workspaces/default",
  state: "/qe/state",
  control: "/qe/control",
  home: "/home/agent",
  cache: "/home/agent/.cache",
  temp: "/tmp/qe",
};
const secret = "QE_FAKE_CLAUDE_LOGIN_INTERACTION_SECRET_unit";

test("production setup launcher is one exact versioned shell-free Claude policy", () => {
  const launcher = new ClaudeSubscriptionSetupLauncher();
  const spec = launcher.specification({ providerKey: "anthropic", paths });
  expect(launcher.identity).toBe(CLAUDE_SUBSCRIPTION_SETUP_LAUNCHER_IDENTITY);
  expect(spec).toMatchObject({
    launcherIdentity: "claude-code-2.1.292-subscription-login-v1",
    providerKey: "anthropic",
    interactionRecognizerIdentity: "claude-code-2.1.292-auth-login-stdout-v1",
    command: {
      executable: SBX_CLAUDE_EXECUTABLE,
      args: ["auth", "login"],
      cwd: "/qe/state/claude/empty-cwd",
    },
  });
  expect(spec.command.environment.PATH).toBe("/usr/bin:/bin");
  expect(spec.command.environment.BROWSER).toBe("/bin/false");
  expect(spec.command.args).not.toContain("-c");
  expect(Object.isFrozen(spec)).toBe(true);
});

test("physical fixture policy has exact test-only executable and the production recognizer", () => {
  const launcher = new PhysicalAcceptanceSetupLauncher("fragmented", secret);
  const spec = launcher.specification({ providerKey: "anthropic", paths });
  expect(launcher.identity).toBe(PHYSICAL_ACCEPTANCE_SETUP_LAUNCHER_IDENTITY);
  expect(spec.command.executable).toBe(PHYSICAL_ACCEPTANCE_FIXTURE_EXECUTABLE);
  expect(spec.interactionRecognizerIdentity).toBe(
    CLAUDE_LOGIN_INTERACTION_IDENTITY,
  );
  expect(spec.command.args.slice(0, 2)).toEqual(["-u", "-c"]);
  expect(spec.command.args.at(-1)).toBe("fragmented");
  expect(spec.command.cwd).toBe("/qe/state");
});

test("durable launcher authority rejects production/fixture/version/spec mismatches", () => {
  const production = new ClaudeSubscriptionSetupLauncher();
  const fixture = new PhysicalAcceptanceSetupLauncher("fragmented", secret);
  const productionAuthority = setupLaunchAuthority(
    production,
    production.specification({ providerKey: "anthropic", paths }),
    paths,
  );
  const fixtureAuthority = setupLaunchAuthority(
    fixture,
    fixture.specification({ providerKey: "anthropic", paths }),
    paths,
  );
  expect(() =>
    assertTrustedSetupLaunchAuthority(productionAuthority, fixtureAuthority),
  ).toThrow("current trusted launcher policy");
  expect(() =>
    assertTrustedSetupLaunchAuthority(fixtureAuthority, productionAuthority),
  ).toThrow("current trusted launcher policy");

  const nextVersion = new PhysicalAcceptanceSetupLauncher(
    "fragmented",
    secret,
    "qe-physical-claude-login-fixture-v2",
  );
  const nextVersionAuthority = setupLaunchAuthority(
    nextVersion,
    nextVersion.specification({ providerKey: "anthropic", paths }),
    paths,
  );
  expect(() =>
    assertTrustedSetupLaunchAuthority(fixtureAuthority, nextVersionAuthority),
  ).toThrow("current trusted launcher policy");

  const silent = new PhysicalAcceptanceSetupLauncher("silent", secret);
  const silentAuthority = setupLaunchAuthority(
    silent,
    silent.specification({ providerKey: "anthropic", paths }),
    paths,
  );
  expect(() =>
    assertTrustedSetupLaunchAuthority(fixtureAuthority, silentAuthority),
  ).toThrow("current trusted launcher policy");
});

test("launch specs reject extra fields and arbitrary executable substitution", () => {
  const launcher = new ClaudeSubscriptionSetupLauncher();
  const spec = launcher.specification({ providerKey: "anthropic", paths });
  expect(() =>
    validateSetupLaunchSpec({ ...spec, test_mode: true } as never, paths),
  ).toThrow("incompatible launch specification");
  for (const executable of ["/bin/sh", "/usr/bin/env", "/tmp/arbitrary"]) {
    expect(() =>
      setupLaunchAuthority(
        launcher,
        {
          ...spec,
          command: { ...spec.command, executable },
        },
        paths,
      ),
    ).toThrow("conflicts with its trusted launcher");
  }
});

test("normal Worker composition has no fixture or externally selectable launcher path", async () => {
  const sourceRoot = new URL("../src/", import.meta.url);
  const [main, config, worker, codec, types] = await Promise.all(
    [
      "main.ts",
      "config.ts",
      "worker.ts",
      "protocol/codec.ts",
      "protocol/types.ts",
    ].map((name) => Bun.file(new URL(name, sourceRoot)).text()),
  );
  const production = [main, config, worker, codec, types].join("\n");
  expect(production).not.toContain(PHYSICAL_ACCEPTANCE_SETUP_LAUNCHER_IDENTITY);
  expect(production).not.toContain("provider-account-login-fixture.py");
  expect(production).not.toMatch(
    /fake_executable|launcher_path|test_mode|fixture_behavior|QE_PROVIDER_ACCOUNT_FAKE_LAUNCHER/,
  );
  expect(worker).toContain("new ClaudeSubscriptionSetupLauncher()");
  expect(main).not.toContain("providerAccountEnvironments");
});
