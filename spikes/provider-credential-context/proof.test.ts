import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	FAKE_CREDENTIAL_CANARY,
	FakeProviderAccountCell,
	FakeRunWorkspaceBroker,
	runDarwinNamespaceShell,
} from "./proof.ts";

const fixtures = join(import.meta.dir, "fixtures");
const accountCredential = join(
	fixtures,
	"account-environment",
	".credentials.json",
);
const runWorkspace = join(fixtures, "run-environment", "workspace");

describe("provider credential context fake proof", () => {
	test("workspace filesystem and search capabilities cannot leave the Run namespace", async () => {
		const broker = await FakeRunWorkspaceBroker.open(runWorkspace);

		expect(await broker.read("visible.txt")).toBe("workspace-visible\n");
		expect(await broker.search("workspace-visible")).toEqual(["visible.txt"]);
		expect(await broker.search(FAKE_CREDENTIAL_CANARY)).toEqual([]);
		await expect(broker.read(accountCredential)).rejects.toThrow("path escape");
		await expect(broker.read("credential-link")).rejects.toThrow(
			"symlink escape",
		);
	});

	test("terminal.shell can read the Run workspace but kernel policy denies known credential paths", async () => {
		if (process.platform !== "darwin") return;

		const allowed = await runDarwinNamespaceShell({
			workspaceRoot: runWorkspace,
			targetPath: join(runWorkspace, "visible.txt"),
		});
		expect(allowed.exitCode).toBe(0);
		expect(allowed.stdout).toBe("workspace-visible\n");

		const denied = await runDarwinNamespaceShell({
			workspaceRoot: runWorkspace,
			targetPath: accountCredential,
		});
		expect(denied.exitCode).not.toBe(0);
		expect(denied.stdout).not.toContain(FAKE_CREDENTIAL_CANARY);
		expect(denied.environmentNames).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);

		const deniedSymlink = await runDarwinNamespaceShell({
			workspaceRoot: runWorkspace,
			targetPath: join(runWorkspace, "credential-link"),
		});
		expect(deniedSymlink.exitCode).not.toBe(0);
		expect(deniedSymlink.stdout).not.toContain(FAKE_CREDENTIAL_CANARY);
	});

	test("two concurrent consumers serialize refresh against one canonical state", async () => {
		const { cell } = FakeProviderAccountCell.authenticated({
			providerAccountId: "provider-account-1",
			workerId: "worker-a",
			environmentIncarnation: "account-cell-1",
			credentialBytes: FAKE_CREDENTIAL_CANARY,
		});
		const reference = cell.reference();
		let releaseFirst = () => {};
		const firstMayFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const events: string[] = [];

		const first = cell.use(reference, async (provider) => {
			events.push(`run-a-enter-r${provider.credentialRevision}`);
			provider.refresh("refresh-a");
			await firstMayFinish;
			events.push(`run-a-exit-r${provider.credentialRevision}`);
		});
		const second = cell.use(reference, async (provider) => {
			events.push(`run-b-enter-r${provider.credentialRevision}`);
			provider.refresh("refresh-b");
			events.push(`run-b-exit-r${provider.credentialRevision}`);
		});

		await Bun.sleep(10);
		expect(events).toEqual(["run-a-enter-r0"]);
		releaseFirst();
		await Promise.all([first, second]);

		expect(events).toEqual([
			"run-a-enter-r0",
			"run-a-exit-r1",
			"run-b-enter-r1",
			"run-b-exit-r2",
		]);
		expect(cell.evidence()).toEqual({
			credentialRevision: 2,
			mutationLog: ["refresh-a", "refresh-b"],
		});
	});

	test("account replacement fences stale consumers without credential hashing", async () => {
		const { cell } = FakeProviderAccountCell.authenticated({
			providerAccountId: "provider-account-1",
			workerId: "worker-a",
			environmentIncarnation: "account-cell-1",
			credentialBytes: FAKE_CREDENTIAL_CANARY,
		});
		const stale = cell.reference();

		await cell.replaceAuthenticatedAccount(`${FAKE_CREDENTIAL_CANARY}-next`);

		await expect(cell.use(stale, async () => undefined)).rejects.toThrow(
			"stale",
		);
		expect(cell.reference().credentialGeneration).toBe(2);
		expect(cell.status()).toMatchObject({
			state: "authenticated",
			authMethod: "claude.ai",
			credentialGeneration: 2,
		});
	});

	test("Worker, Product, and host-process reconstruction retain only safe identity projections", async () => {
		const { cell, disk } = FakeProviderAccountCell.authenticated({
			providerAccountId: "provider-account-1",
			workerId: "worker-a",
			environmentIncarnation: "account-cell-1",
			credentialBytes: FAKE_CREDENTIAL_CANARY,
		});
		await cell.use(cell.reference(), async (provider) => {
			provider.refresh("refresh-before-restart");
		});

		const workerAfterRestart = new FakeProviderAccountCell(disk);
		const productProjection = JSON.stringify(workerAfterRestart.status());
		const productAfterRestart = JSON.parse(productProjection);
		const hostProcessAfterRestart = new FakeProviderAccountCell(disk);

		expect(productProjection).not.toContain(FAKE_CREDENTIAL_CANARY);
		expect(productAfterRestart).toEqual(workerAfterRestart.status());
		expect(hostProcessAfterRestart.status()).toEqual({
			...cell.status(),
			credentialRevision: 1,
		});
		await hostProcessAfterRestart.use(
			hostProcessAfterRestart.reference(),
			async (provider) => {
				expect(provider.credentialRevision).toBe(1);
			},
		);
	});

	test("disconnect rotates generation and makes new use ineligible", async () => {
		const { cell } = FakeProviderAccountCell.authenticated({
			providerAccountId: "provider-account-1",
			workerId: "worker-a",
			environmentIncarnation: "account-cell-1",
			credentialBytes: FAKE_CREDENTIAL_CANARY,
		});
		const stale = cell.reference();

		await cell.disconnect();

		expect(cell.status()).toMatchObject({
			state: "authentication_required",
			authMethod: "none",
			credentialGeneration: 2,
		});
		await expect(cell.use(stale, async () => undefined)).rejects.toThrow(
			"stale",
		);
		await expect(
			cell.use(cell.reference(), async () => undefined),
		).rejects.toThrow("not ready");
	});
});
