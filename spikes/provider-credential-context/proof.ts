import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const FAKE_CREDENTIAL_CANARY =
	"QE_FAKE_CLAUDE_CREDENTIAL_DO_NOT_USE_7c11f6f9";

export interface ProviderCredentialContextRef {
	providerAccountId: string;
	provider: "anthropic";
	harness: "claude_code_mod";
	workerId: string;
	credentialGeneration: number;
	environmentIncarnation: string;
	environmentPolicy: "claude-subscription-explicit-environment-v2";
}

export interface SafeProviderAccountStatus {
	providerAccountId: string;
	provider: "anthropic";
	workerId: string;
	credentialGeneration: number;
	state: "authenticated" | "authentication_required";
	authMethod: "claude.ai" | "none";
	environmentIncarnation: string;
	credentialRevision: number;
}

interface FakeCredentialDisk {
	providerAccountId: string;
	workerId: string;
	environmentIncarnation: string;
	generation: number;
	state: "authenticated" | "authentication_required";
	authMethod: "claude.ai" | "none";
	/** Fake secret bytes stand in for provider-owned state inside the account cell. */
	credentialBytes: string;
	credentialRevision: number;
	mutationLog: string[];
}

interface FakeOfficialProviderRuntime {
	readonly credentialRevision: number;
	refresh(label: string): void;
}

/**
 * Deterministic account-cell model. Only the simulated unmodified provider
 * runtime receives the private mutation surface. A Run receives only a fenced
 * reference and never this object or FakeCredentialDisk.
 */
export class FakeProviderAccountCell {
	private lockTail: Promise<void> = Promise.resolve();

	constructor(private readonly disk: FakeCredentialDisk) {}

	static authenticated(input: {
		providerAccountId: string;
		workerId: string;
		environmentIncarnation: string;
		credentialBytes: string;
	}): { cell: FakeProviderAccountCell; disk: FakeCredentialDisk } {
		const disk: FakeCredentialDisk = {
			...input,
			generation: 1,
			state: "authenticated",
			authMethod: "claude.ai",
			credentialRevision: 0,
			mutationLog: [],
		};
		return { cell: new FakeProviderAccountCell(disk), disk };
	}

	reference(): ProviderCredentialContextRef {
		return {
			providerAccountId: this.disk.providerAccountId,
			provider: "anthropic",
			harness: "claude_code_mod",
			workerId: this.disk.workerId,
			credentialGeneration: this.disk.generation,
			environmentIncarnation: this.disk.environmentIncarnation,
			environmentPolicy: "claude-subscription-explicit-environment-v2",
		};
	}

	status(): SafeProviderAccountStatus {
		return {
			providerAccountId: this.disk.providerAccountId,
			provider: "anthropic",
			workerId: this.disk.workerId,
			credentialGeneration: this.disk.generation,
			state: this.disk.state,
			authMethod: this.disk.authMethod,
			environmentIncarnation: this.disk.environmentIncarnation,
			credentialRevision: this.disk.credentialRevision,
		};
	}

	async use<T>(
		reference: ProviderCredentialContextRef,
		operation: (provider: FakeOfficialProviderRuntime) => Promise<T>,
	): Promise<T> {
		return this.exclusive(async () => {
			this.assertCurrent(reference);
			if (
				this.disk.state !== "authenticated" ||
				this.disk.authMethod !== "claude.ai"
			)
				throw new Error("Provider account authentication is not ready.");
			const thisCell = this;
			const provider: FakeOfficialProviderRuntime = {
				get credentialRevision() {
					return thisCell.disk.credentialRevision;
				},
				refresh: (label: string) => {
					if (!/^[a-z0-9-]{1,64}$/.test(label))
						throw new Error("Fake refresh label is invalid.");
					this.disk.credentialBytes = `${this.disk.credentialBytes}:${label}`;
					this.disk.credentialRevision += 1;
					this.disk.mutationLog.push(label);
				},
			};
			return operation(provider);
		});
	}

	async replaceAuthenticatedAccount(
		fakeCredentialBytes: string,
	): Promise<void> {
		await this.exclusive(async () => {
			this.disk.credentialBytes = fakeCredentialBytes;
			this.disk.credentialRevision += 1;
			this.disk.generation += 1;
			this.disk.state = "authenticated";
			this.disk.authMethod = "claude.ai";
			this.disk.mutationLog.push("replace-account");
		});
	}

	async disconnect(): Promise<void> {
		await this.exclusive(async () => {
			this.disk.credentialBytes = "";
			this.disk.credentialRevision += 1;
			this.disk.generation += 1;
			this.disk.state = "authentication_required";
			this.disk.authMethod = "none";
			this.disk.mutationLog.push("disconnect");
		});
	}

	/** Safe test evidence; intentionally excludes fake credential bytes. */
	evidence(): { credentialRevision: number; mutationLog: string[] } {
		return {
			credentialRevision: this.disk.credentialRevision,
			mutationLog: [...this.disk.mutationLog],
		};
	}

	private assertCurrent(reference: ProviderCredentialContextRef): void {
		if (
			reference.providerAccountId !== this.disk.providerAccountId ||
			reference.provider !== "anthropic" ||
			reference.harness !== "claude_code_mod" ||
			reference.workerId !== this.disk.workerId ||
			reference.credentialGeneration !== this.disk.generation ||
			reference.environmentIncarnation !== this.disk.environmentIncarnation ||
			reference.environmentPolicy !==
				"claude-subscription-explicit-environment-v2"
		)
			throw new Error("Provider credential context reference is stale.");
	}

	private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		let release = () => {};
		const predecessor = this.lockTail;
		this.lockTail = new Promise<void>((resolveLock) => {
			release = resolveLock;
		});
		await predecessor;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

/**
 * Model-visible workspace tools are rooted in the Run namespace. This broker
 * has no account-cell capability and rejects lexical and symlink escapes.
 */
export class FakeRunWorkspaceBroker {
	private constructor(private readonly workspaceRoot: string) {}

	static async open(workspaceRoot: string): Promise<FakeRunWorkspaceBroker> {
		return new FakeRunWorkspaceBroker(await realpath(workspaceRoot));
	}

	async read(path: string): Promise<string> {
		const target = await this.containedRealPath(path);
		return readFile(target, "utf8");
	}

	async search(needle: string): Promise<string[]> {
		const matches: string[] = [];
		await this.searchDirectory(this.workspaceRoot, needle, matches);
		return matches.sort();
	}

	private async containedRealPath(path: string): Promise<string> {
		const candidate = resolve(this.workspaceRoot, path);
		if (!contains(this.workspaceRoot, candidate))
			throw new Error("Workspace capability rejected a path escape.");
		const physical = await realpath(candidate);
		if (!contains(this.workspaceRoot, physical))
			throw new Error("Workspace capability rejected a symlink escape.");
		return physical;
	}

	private async searchDirectory(
		directory: string,
		needle: string,
		matches: string[],
	): Promise<void> {
		for (const entry of await readdir(directory)) {
			const path = resolve(directory, entry);
			const metadata = await lstat(path);
			if (metadata.isSymbolicLink()) continue;
			if (metadata.isDirectory()) {
				await this.searchDirectory(path, needle, matches);
				continue;
			}
			if (!metadata.isFile()) continue;
			if ((await readFile(path, "utf8")).includes(needle))
				matches.push(relative(this.workspaceRoot, path));
		}
	}
}

export async function runDarwinNamespaceShell(input: {
	workspaceRoot: string;
	targetPath: string;
}): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	environmentNames: string[];
}> {
	if (process.platform !== "darwin")
		throw new Error(
			"The retained physical shell proof requires macOS sandbox-exec.",
		);
	const workspaceRoot = await realpath(input.workspaceRoot);
	const profile = [
		"(version 1)",
		"(deny default)",
		'(import "system.sb")',
		"(allow process*)",
		"(allow file-read-metadata)",
		`(allow file-read* ${[
			workspaceRoot,
			"/bin",
			"/usr/bin",
			"/usr/lib",
			"/System/Library",
			"/private/var/select",
		]
			.map((path) => `(subpath ${sandboxString(path)})`)
			.join(" ")})`,
	].join(" ");
	const environment = {
		HOME: workspaceRoot,
		LANG: "C.UTF-8",
		PATH: "/usr/bin:/bin",
		TMPDIR: workspaceRoot,
	};
	const child = Bun.spawn({
		cmd: [
			"/usr/bin/sandbox-exec",
			"-p",
			profile,
			"/bin/sh",
			"-c",
			'cat "$1"',
			"qe-proof",
			resolve(input.targetPath),
		],
		cwd: workspaceRoot,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return {
		exitCode,
		stdout,
		stderr,
		environmentNames: Object.keys(environment).sort(),
	};
}

function contains(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function sandboxString(value: string): string {
	return JSON.stringify(value);
}
