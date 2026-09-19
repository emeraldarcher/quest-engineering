import { expect, test } from "bun:test";
import {
  DEFAULT_SBX_VERSION_POLICY,
  inspectSbxReadiness,
} from "../src/execution-environment/sbx-readiness.ts";
import { FakeSbxClient, fakeSbxState } from "./sbx-support.ts";

test("SBX readiness accepts the tested version and required global safeguards", async () => {
  const readiness = await inspectSbxReadiness(
    new FakeSbxClient(fakeSbxState()),
  );
  expect(readiness).toMatchObject({
    backendKind: "sbx",
    status: "ready",
    ready: true,
  });
  expect(readiness.diagnostics).toEqual([]);
});

test("SBX readiness reports a stopped daemon as unavailable", async () => {
  const state = fakeSbxState();
  state.version.serverState = "stopped";
  delete state.version.serverVersion;
  delete state.version.serverRevision;
  delete state.version.apiVersion;
  const readiness = await inspectSbxReadiness(new FakeSbxClient(state));
  expect(readiness.status).toBe("unavailable");
  expect(readiness.ready).toBe(false);
  expect(readiness.diagnostics).toContainEqual(
    expect.objectContaining({ code: "backend_unavailable" }),
  );
});

test("SBX readiness rejects older and explicitly known-bad revisions", async () => {
  const older = fakeSbxState();
  older.version.clientVersion = "v0.42.9";
  expect(await inspectSbxReadiness(new FakeSbxClient(older))).toMatchObject({
    status: "incompatible",
    ready: false,
  });

  const olderApi = fakeSbxState();
  olderApi.version.apiVersion = "0.30.9";
  expect(await inspectSbxReadiness(new FakeSbxClient(olderApi))).toMatchObject({
    status: "incompatible",
    ready: false,
  });

  const knownBad = fakeSbxState();
  const policy = {
    ...DEFAULT_SBX_VERSION_POLICY,
    knownBadVersions: {
      [`${knownBad.version.clientVersion}@${knownBad.version.clientRevision}`]:
        "test quarantine",
    },
  };
  const readiness = await inspectSbxReadiness(
    new FakeSbxClient(knownBad),
    policy,
  );
  expect(readiness.status).toBe("incompatible");
  expect(readiness.diagnostics).toContainEqual(
    expect.objectContaining({ code: "known_bad_native_version" }),
  );
});

test("SBX readiness permits newer semantic versions with an explicit warning", async () => {
  const state = fakeSbxState();
  state.version.clientVersion = "v0.44.0";
  state.version.clientRevision = "newer-revision";
  state.version.serverVersion = "v0.44.0";
  state.version.serverRevision = "newer-revision";
  const readiness = await inspectSbxReadiness(new FakeSbxClient(state));
  expect(readiness).toMatchObject({ status: "ready", ready: true });
  expect(readiness.diagnostics).toContainEqual(
    expect.objectContaining({ code: "newer_than_tested_but_compatible" }),
  );
});

test("SBX readiness fails closed for policy, SSH, or MCP exposure", async () => {
  const missingPolicy = fakeSbxState();
  missingPolicy.rules = [];
  expect(
    await inspectSbxReadiness(new FakeSbxClient(missingPolicy)),
  ).toMatchObject({ status: "unavailable", ready: false });

  const ssh = fakeSbxState();
  ssh.sshForwarding = true;
  const sshReadiness = await inspectSbxReadiness(new FakeSbxClient(ssh));
  expect(sshReadiness.diagnostics).toContainEqual(
    expect.objectContaining({ code: "ssh_agent_forwarding_enabled" }),
  );

  const mcp = fakeSbxState();
  mcp.mcpServerCount = 1;
  const mcpReadiness = await inspectSbxReadiness(new FakeSbxClient(mcp));
  expect(mcpReadiness.diagnostics).toContainEqual(
    expect.objectContaining({ code: "ambient_mcp_registered" }),
  );
});
