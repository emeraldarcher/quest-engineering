import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type ExecutionBindingInput,
	FAKE_ACCOUNT_CREDENTIAL_CANARY,
	FakeExecutionAuthority,
	FakeNetworkBoundary,
	FakeProviderAccountCell,
	fixturePaths,
} from "./proof.ts";

const fixtures = fixturePaths(join(import.meta.dir, "fixtures"));
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function setup() {
	const { authority, disk } = FakeExecutionAuthority.authenticated({
		workerId: "worker-a",
		providerAccountId: "provider-account-1",
		accountEnvironmentIncarnation: "account-cell-incarnation-1",
		credentialGeneration: 7,
	});
	const binding = (
		runId: string,
		physicalLineageId: string,
		runEnvironmentIncarnation: string,
		workspaceRoot: string,
	): ExecutionBindingInput => ({
		workerId: "worker-a",
		accountEnvironmentIncarnation: "account-cell-incarnation-1",
		credentialGeneration: authority.projection().credentialGeneration,
		runId,
		actionId: `${runId}-action`,
		attemptId: `${runId}-attempt`,
		physicalLineageId,
		runEnvironmentIncarnation,
		workspaceRoot,
	});
	return { authority, disk, binding };
}

describe("Claude account-cell feasibility fake proof", () => {
	test("broker filesystem and search see only the bound Run workspace", async () => {
		const { authority, binding } = setup();
		const runA = await authority.bind(
			binding("run-a", "lineage-a", "run-cell-a-1", fixtures.runAWorkspace),
		);

		expect(await runA.read("visible-a.txt")).toBe("run-a-visible\n");
		expect(await runA.search("run-a-visible")).toEqual(["visible-a.txt"]);
		expect(await runA.search(FAKE_ACCOUNT_CREDENTIAL_CANARY)).toEqual([]);
		await expect(runA.read(fixtures.accountCredential)).rejects.toThrow(
			"path escape",
		);
		await expect(runA.read("account-credential-link")).rejects.toThrow(
			"symlink escape",
		);
	});

	test("broker shell observes Run HOME/cwd and kernel policy denies account paths", async () => {
		if (process.platform !== "darwin") return;
		const { authority, binding } = setup();
		const runA = await authority.bind(
			binding("run-a", "lineage-a", "run-cell-a-1", fixtures.runAWorkspace),
		);

		const allowed = await runA.shellRead(
			join(fixtures.runAWorkspace, "visible-a.txt"),
		);
		expect(allowed.exitCode).toBe(0);
		expect(allowed.stdout).toBe("run-a-visible\n");
		expect(allowed.environmentNames).toEqual([
			"HOME",
			"LANG",
			"PATH",
			"TMPDIR",
		]);

		const denied = await runA.shellRead(fixtures.accountCredential);
		expect(denied.exitCode).not.toBe(0);
		expect(denied.stdout).not.toContain(FAKE_ACCOUNT_CREDENTIAL_CANARY);

		const deniedLink = await runA.shellRead(
			join(fixtures.runAWorkspace, "account-credential-link"),
		);
		expect(deniedLink.exitCode).not.toBe(0);
		expect(deniedLink.stdout).not.toContain(FAKE_ACCOUNT_CREDENTIAL_CANARY);
	});

	test("two concurrent broker calls retain exact Run and lineage routing", async () => {
		const { authority, binding } = setup();
		const [runA, runB] = await Promise.all([
			authority.bind(
				binding("run-a", "lineage-a", "run-cell-a-1", fixtures.runAWorkspace),
			),
			authority.bind(
				binding("run-b", "lineage-b", "run-cell-b-1", fixtures.runBWorkspace),
			),
		]);

		const [a, b] = await Promise.all([
			runA.read("visible-a.txt"),
			runB.read("visible-b.txt"),
		]);

		expect(a).toBe("run-a-visible\n");
		expect(b).toBe("run-b-visible\n");
		expect(runA.safeBinding()).toMatchObject({
			runId: "run-a",
			physicalLineageId: "lineage-a",
			credentialGeneration: 7,
		});
		expect(runB.safeBinding()).toMatchObject({
			runId: "run-b",
			physicalLineageId: "lineage-b",
			credentialGeneration: 7,
		});
		await expect(
			runA.read("../../run-b/workspace/visible-b.txt"),
		).rejects.toThrow("path escape");
	});

	test("native session matrix permits only exact binding-owned resume", async () => {
		const { authority, binding } = setup();
		const runA = await authority.bind(
			binding("run-a", "lineage-a", "run-cell-a-1", fixtures.runAWorkspace),
		);
		const runB = await authority.bind(
			binding("run-b", "lineage-b", "run-cell-b-1", fixtures.runBWorkspace),
		);

		authority.createNativeSession(runA, SESSION_A, "qe_pa1_run_a_lineage_a");
		authority.createNativeSession(runB, SESSION_B, "qe_pa1_run_b_lineage_b");

		expect(authority.resumeNativeSession(runA, SESSION_A).sessionId).toBe(
			SESSION_A,
		);
		expect(authority.resumeNativeSession(runB, SESSION_B).sessionId).toBe(
			SESSION_B,
		);
		expect(() => authority.resumeNativeSession(runA, SESSION_B)).toThrow(
			"does not belong",
		);
		expect(() => authority.resumeNativeSession(runB, SESSION_A)).toThrow(
			"does not belong",
		);
		expect(() => authority.continueLatest()).toThrow(
			"--continue/latest selection is prohibited",
		);
	});

	test("credential-generation rollover rejects bindings and sessions before process start", async () => {
		const { authority, binding } = setup();
		const runA = await authority.bind(
			binding("run-a", "lineage-a", "run-cell-a-1", fixtures.runAWorkspace),
		);
		authority.createNativeSession(runA, SESSION_A, "qe_pa1_run_a_lineage_a");

		authority.rolloverCredentialGeneration();

		expect(authority.projection().credentialGeneration).toBe(8);
		expect(() => authority.beginProviderProcess(runA)).toThrow("retired");
		expect(() => authority.resumeNativeSession(runA, SESSION_A)).toThrow(
			"retired",
		);
		expect(authority.projection().processStarts).toBe(0);
	});

	test("generation rotation during active work is refused until exact quiescence", async () => {
		const { authority, binding } = setup();
		const runA = await authority.bind(
			binding("run-a", "lineage-a", "run-cell-a-1", fixtures.runAWorkspace),
		);
		const releaseOld = authority.beginProviderProcess(runA);

		expect(() => authority.rolloverCredentialGeneration()).toThrow(
			"while a provider process runs",
		);
		expect(authority.projection()).toMatchObject({
			credentialGeneration: 7,
			activeProviderProcesses: 1,
			processStarts: 1,
		});

		releaseOld();
		authority.rolloverCredentialGeneration();
		const replacement = await authority.bind(
			binding("run-b", "lineage-b", "run-cell-b-1", fixtures.runBWorkspace),
		);
		expect(() => authority.beginProviderProcess(runA)).toThrow("retired");
		const releaseReplacement = authority.beginProviderProcess(replacement);
		releaseReplacement();

		expect(authority.projection()).toMatchObject({
			credentialGeneration: 8,
			activeProviderProcesses: 0,
			processStarts: 2,
		});
	});

	test("logout fences new work, waits for quiescence, then advances generation", async () => {
		const { authority, binding } = setup();
		const runA = await authority.bind(
			binding("run-a", "lineage-a", "run-cell-a-1", fixtures.runAWorkspace),
		);
		const release = authority.beginProviderProcess(runA);

		const logout = authority.requestLogout();
		expect(authority.projection().accountState).toBe("revocation_requested");
		await expect(
			authority.bind(
				binding("run-b", "lineage-b", "run-cell-b-1", fixtures.runBWorkspace),
			),
		).rejects.toThrow("fenced");

		release();
		await logout;

		expect(authority.projection()).toMatchObject({
			accountState: "disconnected",
			credentialGeneration: 8,
			bindingCount: 0,
			processStarts: 1,
		});
		expect(() => authority.beginProviderProcess(runA)).toThrow("retired");
	});

	test("Run-cell replacement rotates only the Run epoch and rejects old bindings", async () => {
		const { authority, binding } = setup();
		const oldRunA = await authority.bind(
			binding("run-a", "lineage-a", "run-cell-a-1", fixtures.runAWorkspace),
		);
		authority.createNativeSession(oldRunA, SESSION_A, "qe_pa1_run_a_lineage_a");

		authority.replaceRunEnvironment("run-a");
		const replacement = await authority.bind(
			binding("run-a", "lineage-a", "run-cell-a-2", fixtures.runAWorkspace),
		);

		expect(replacement.safeBinding()).toMatchObject({
			runId: "run-a",
			runRecoveryEpoch: 2,
			credentialGeneration: 7,
		});
		expect(() => oldRunA.safeBinding()).toThrow("retired");
		expect(() => authority.resumeNativeSession(replacement, SESSION_A)).toThrow(
			"does not belong",
		);
		expect(authority.projection().accountState).toBe("authenticated");
	});

	test("Worker and host reconstruction retain safe state without replay", async () => {
		const { authority, disk, binding } = setup();
		const runA = await authority.bind(
			binding("run-a", "lineage-a", "run-cell-a-1", fixtures.runAWorkspace),
		);
		authority.createNativeSession(runA, SESSION_A, "qe_pa1_run_a_lineage_a");
		const before = authority.projection();

		const workerAfterRestart = new FakeExecutionAuthority(disk);
		const hostAfterRestart = new FakeExecutionAuthority(disk);
		const serializedProjection = JSON.stringify(
			workerAfterRestart.projection(),
		);

		expect(workerAfterRestart.projection()).toEqual(before);
		expect(hostAfterRestart.projection()).toEqual(before);
		expect(serializedProjection).not.toContain(FAKE_ACCOUNT_CREDENTIAL_CANARY);
		expect(workerAfterRestart.projection().uncertainReplays).toBe(0);
		expect(
			workerAfterRestart.resumeNativeSession(runA, SESSION_A).sessionId,
		).toBe(SESSION_A);
	});

	test("Run cleanup retires only that Run and never disconnects the account", async () => {
		const { authority, binding } = setup();
		const runA = await authority.bind(
			binding("run-a", "lineage-a", "run-cell-a-1", fixtures.runAWorkspace),
		);
		const runB = await authority.bind(
			binding("run-b", "lineage-b", "run-cell-b-1", fixtures.runBWorkspace),
		);
		authority.createNativeSession(runA, SESSION_A, "qe_pa1_run_a_lineage_a");
		authority.createNativeSession(runB, SESSION_B, "qe_pa1_run_b_lineage_b");

		authority.cleanupRun("run-a");

		expect(authority.projection()).toMatchObject({
			accountState: "authenticated",
			credentialGeneration: 7,
			bindingCount: 1,
			nativeSessionCount: 1,
		});
		expect(() => runA.safeBinding()).toThrow("retired");
		expect(authority.resumeNativeSession(runB, SESSION_B).sessionId).toBe(
			SESSION_B,
		);
	});

	test("Run network has no route to account/control endpoints", () => {
		const network = new FakeNetworkBoundary();

		expect(network.accountRequestsBoundOperation("worker-bound-broker")).toBe(
			true,
		);
		expect(() => network.runConnect("account-cell-control")).toThrow(
			"unavailable",
		);
		expect(() => network.runConnect("worker-bound-broker")).toThrow(
			"unavailable",
		);
		expect(network.runRoutes).toEqual(["run-egress"]);
	});

	test("canonical credential mutation remains serialized across two consumers", async () => {
		const { cell } = FakeProviderAccountCell.authenticated({
			providerAccountId: "provider-account-1",
			workerId: "worker-a",
			environmentIncarnation: "account-cell-incarnation-1",
			credentialBytes: FAKE_ACCOUNT_CREDENTIAL_CANARY,
		});
		const reference = cell.reference();
		let releaseFirst = () => {};
		const firstMayFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const revisions: string[] = [];

		const first = cell.use(reference, async (provider) => {
			revisions.push(`a-enter-${provider.credentialRevision}`);
			provider.refresh("refresh-a");
			await firstMayFinish;
			revisions.push(`a-exit-${provider.credentialRevision}`);
		});
		const second = cell.use(reference, async (provider) => {
			revisions.push(`b-enter-${provider.credentialRevision}`);
			provider.refresh("refresh-b");
			revisions.push(`b-exit-${provider.credentialRevision}`);
		});

		await Bun.sleep(10);
		expect(revisions).toEqual(["a-enter-0"]);
		releaseFirst();
		await Promise.all([first, second]);

		expect(revisions).toEqual([
			"a-enter-0",
			"a-exit-1",
			"b-enter-1",
			"b-exit-2",
		]);
		expect(cell.evidence()).toEqual({
			credentialRevision: 2,
			mutationLog: ["refresh-a", "refresh-b"],
		});
	});
});
