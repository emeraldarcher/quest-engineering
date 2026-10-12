import { join } from "node:path";
import {
	FakeProviderAccountCell,
	FakeRunWorkspaceBroker,
	runDarwinNamespaceShell,
} from "../provider-credential-context/proof.ts";

export const FAKE_ACCOUNT_CREDENTIAL_CANARY =
	"QE_FAKE_ACCOUNT_CELL_CREDENTIAL_CANARY_8f42d19a";

export interface ExecutionBindingInput {
	workerId: string;
	accountEnvironmentIncarnation: string;
	credentialGeneration: number;
	runId: string;
	actionId: string;
	attemptId: string;
	physicalLineageId: string;
	runEnvironmentIncarnation: string;
	workspaceRoot: string;
}

interface BindingRecord extends ExecutionBindingInput {
	bindingId: string;
	runRecoveryEpoch: number;
	retired: boolean;
}

interface NativeSessionRecord {
	sessionId: string;
	projectDirectoryName: string;
	bindingId: string;
	workerId: string;
	accountEnvironmentIncarnation: string;
	credentialGeneration: number;
	runId: string;
	physicalLineageId: string;
	runRecoveryEpoch: number;
	retired: boolean;
}

interface SafeAuthorityDisk {
	workerId: string;
	providerAccountId: string;
	accountEnvironmentIncarnation: string;
	credentialGeneration: number;
	accountState: "authenticated" | "revocation_requested" | "disconnected";
	runRecoveryEpochs: Map<string, number>;
	bindings: Map<string, BindingRecord>;
	nativeSessions: Map<string, NativeSessionRecord>;
	processStarts: number;
	uncertainReplays: number;
}

export interface SafeAuthorityProjection {
	workerId: string;
	providerAccountId: string;
	accountEnvironmentIncarnation: string;
	credentialGeneration: number;
	accountState: "authenticated" | "revocation_requested" | "disconnected";
	bindingCount: number;
	nativeSessionCount: number;
	activeProviderProcesses: number;
	processStarts: number;
	uncertainReplays: number;
}

export class FakeBoundRunBridge {
	constructor(
		private readonly authority: FakeExecutionAuthority,
		private readonly bindingId: string,
	) {}

	async read(path: string): Promise<string> {
		const binding = this.authority.currentBinding(this.bindingId);
		const broker = await FakeRunWorkspaceBroker.open(binding.workspaceRoot);
		return broker.read(path);
	}

	async search(needle: string): Promise<string[]> {
		const binding = this.authority.currentBinding(this.bindingId);
		const broker = await FakeRunWorkspaceBroker.open(binding.workspaceRoot);
		return broker.search(needle);
	}

	async shellRead(targetPath: string) {
		const binding = this.authority.currentBinding(this.bindingId);
		return runDarwinNamespaceShell({
			workspaceRoot: binding.workspaceRoot,
			targetPath,
		});
	}

	safeBinding(): {
		bindingId: string;
		runId: string;
		physicalLineageId: string;
		credentialGeneration: number;
		runRecoveryEpoch: number;
	} {
		const binding = this.authority.currentBinding(this.bindingId);
		return {
			bindingId: binding.bindingId,
			runId: binding.runId,
			physicalLineageId: binding.physicalLineageId,
			credentialGeneration: binding.credentialGeneration,
			runRecoveryEpoch: binding.runRecoveryEpoch,
		};
	}

	bindingKeyForProof(): string {
		return this.bindingId;
	}
}

/**
 * Deterministic Worker-side authority model. The Mod receives a bridge already
 * bound to one record; no operation accepts a Run, account, generation, or
 * lineage identifier from model input.
 */
export class FakeExecutionAuthority {
	private nextBinding = 1;
	private activeProviderBinding: string | undefined;
	private idleWaiters: Array<() => void> = [];

	constructor(private readonly disk: SafeAuthorityDisk) {
		for (const bindingId of disk.bindings.keys()) {
			const suffix = Number(bindingId.replace(/^binding-/, ""));
			if (Number.isSafeInteger(suffix))
				this.nextBinding = Math.max(this.nextBinding, suffix + 1);
		}
	}

	static authenticated(input: {
		workerId: string;
		providerAccountId: string;
		accountEnvironmentIncarnation: string;
		credentialGeneration: number;
	}): { authority: FakeExecutionAuthority; disk: SafeAuthorityDisk } {
		const disk: SafeAuthorityDisk = {
			...input,
			accountState: "authenticated",
			runRecoveryEpochs: new Map(),
			bindings: new Map(),
			nativeSessions: new Map(),
			processStarts: 0,
			uncertainReplays: 0,
		};
		return { authority: new FakeExecutionAuthority(disk), disk };
	}

	async bind(input: ExecutionBindingInput): Promise<FakeBoundRunBridge> {
		this.assertAccountContext(input);
		if (this.disk.accountState !== "authenticated")
			throw new Error("ProviderAccount is fenced for new bindings.");
		const runRecoveryEpoch = this.disk.runRecoveryEpochs.get(input.runId) ?? 1;
		this.disk.runRecoveryEpochs.set(input.runId, runRecoveryEpoch);
		const bindingId = `binding-${this.nextBinding++}`;
		this.disk.bindings.set(bindingId, {
			...input,
			bindingId,
			runRecoveryEpoch,
			retired: false,
		});
		return new FakeBoundRunBridge(this, bindingId);
	}

	currentBinding(bindingId: string): BindingRecord {
		const binding = this.disk.bindings.get(bindingId);
		if (!binding || binding.retired)
			throw new Error("Execution binding is retired.");
		this.assertAccountContext(binding);
		if (this.disk.accountState !== "authenticated")
			throw new Error("ProviderAccount is not available.");
		const currentRunEpoch = this.disk.runRecoveryEpochs.get(binding.runId) ?? 0;
		if (binding.runRecoveryEpoch !== currentRunEpoch)
			throw new Error("Execution binding has a stale Run recovery epoch.");
		return binding;
	}

	createNativeSession(
		bridge: FakeBoundRunBridge,
		sessionId: string,
		projectDirectoryName: string,
	): NativeSessionRecord {
		assertUuid(sessionId);
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectDirectoryName))
			throw new Error("Native project directory name is invalid.");
		if (this.disk.nativeSessions.has(sessionId))
			throw new Error("Native session ID already exists.");
		const binding = this.currentBinding(bridge.bindingKeyForProof());
		const session: NativeSessionRecord = {
			sessionId,
			projectDirectoryName,
			bindingId: binding.bindingId,
			workerId: binding.workerId,
			accountEnvironmentIncarnation: binding.accountEnvironmentIncarnation,
			credentialGeneration: binding.credentialGeneration,
			runId: binding.runId,
			physicalLineageId: binding.physicalLineageId,
			runRecoveryEpoch: binding.runRecoveryEpoch,
			retired: false,
		};
		this.disk.nativeSessions.set(sessionId, session);
		return { ...session };
	}

	resumeNativeSession(
		bridge: FakeBoundRunBridge,
		sessionId: string,
	): NativeSessionRecord {
		const binding = this.currentBinding(bridge.bindingKeyForProof());
		const session = this.disk.nativeSessions.get(sessionId);
		if (!session || session.retired)
			throw new Error("NativeSessionRef is not active.");
		if (
			session.bindingId !== binding.bindingId ||
			session.workerId !== binding.workerId ||
			session.accountEnvironmentIncarnation !==
				binding.accountEnvironmentIncarnation ||
			session.credentialGeneration !== binding.credentialGeneration ||
			session.runId !== binding.runId ||
			session.physicalLineageId !== binding.physicalLineageId ||
			session.runRecoveryEpoch !== binding.runRecoveryEpoch
		)
			throw new Error("NativeSessionRef does not belong to this binding.");
		return { ...session };
	}

	continueLatest(): never {
		throw new Error("Heuristic --continue/latest selection is prohibited.");
	}

	beginProviderProcess(bridge: FakeBoundRunBridge): () => void {
		const binding = this.currentBinding(bridge.bindingKeyForProof());
		if (this.activeProviderBinding !== undefined)
			throw new Error(
				"ProviderAccount already has an active provider process.",
			);
		this.activeProviderBinding = binding.bindingId;
		this.disk.processStarts += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.activeProviderBinding === binding.bindingId)
				this.activeProviderBinding = undefined;
			const waiters = this.idleWaiters;
			this.idleWaiters = [];
			for (const wake of waiters) wake();
		};
	}

	async requestLogout(): Promise<void> {
		if (this.disk.accountState !== "authenticated")
			throw new Error("ProviderAccount cannot begin logout from this state.");
		this.disk.accountState = "revocation_requested";
		if (this.activeProviderBinding !== undefined)
			await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
		if (this.activeProviderBinding !== undefined)
			throw new Error("Provider process did not quiesce.");
		this.disk.credentialGeneration += 1;
		this.disk.accountState = "disconnected";
		for (const binding of this.disk.bindings.values()) binding.retired = true;
	}

	rolloverCredentialGeneration(): void {
		if (this.activeProviderBinding !== undefined)
			throw new Error(
				"Cannot replace an account while a provider process runs.",
			);
		this.disk.credentialGeneration += 1;
		for (const binding of this.disk.bindings.values()) binding.retired = true;
	}

	replaceRunEnvironment(runId: string): void {
		const nextEpoch = (this.disk.runRecoveryEpochs.get(runId) ?? 0) + 1;
		this.disk.runRecoveryEpochs.set(runId, nextEpoch);
		for (const binding of this.disk.bindings.values()) {
			if (binding.runId === runId) binding.retired = true;
		}
	}

	cleanupRun(runId: string): void {
		for (const binding of this.disk.bindings.values()) {
			if (binding.runId === runId) binding.retired = true;
		}
		for (const session of this.disk.nativeSessions.values()) {
			if (session.runId === runId) session.retired = true;
		}
	}

	projection(): SafeAuthorityProjection {
		return {
			workerId: this.disk.workerId,
			providerAccountId: this.disk.providerAccountId,
			accountEnvironmentIncarnation: this.disk.accountEnvironmentIncarnation,
			credentialGeneration: this.disk.credentialGeneration,
			accountState: this.disk.accountState,
			bindingCount: [...this.disk.bindings.values()].filter(
				(binding) => !binding.retired,
			).length,
			activeProviderProcesses: this.activeProviderBinding === undefined ? 0 : 1,
			nativeSessionCount: [...this.disk.nativeSessions.values()].filter(
				(session) => !session.retired,
			).length,
			processStarts: this.disk.processStarts,
			uncertainReplays: this.disk.uncertainReplays,
		};
	}

	private assertAccountContext(input: {
		workerId: string;
		accountEnvironmentIncarnation: string;
		credentialGeneration: number;
	}): void {
		if (
			input.workerId !== this.disk.workerId ||
			input.accountEnvironmentIncarnation !==
				this.disk.accountEnvironmentIncarnation ||
			input.credentialGeneration !== this.disk.credentialGeneration
		)
			throw new Error("ProviderAccount context is stale or non-local.");
	}
}

export class FakeNetworkBoundary {
	readonly accountToWorkerRoute = "private-account-egress";
	readonly runRoutes = ["run-egress"] as const;

	runConnect(endpoint: string): never {
		throw new Error(`Run route to ${endpoint} is unavailable.`);
	}

	accountRequestsBoundOperation(endpoint: string): boolean {
		if (endpoint !== "worker-bound-broker")
			throw new Error("Account process may use only the bound Worker broker.");
		return true;
	}
}

export function fixturePaths(root: string) {
	return {
		accountCredential: join(
			root,
			"account-cell",
			"claude-config",
			".credentials.json",
		),
		runAWorkspace: join(root, "run-a", "workspace"),
		runBWorkspace: join(root, "run-b", "workspace"),
	};
}

export { FakeProviderAccountCell };

function assertUuid(value: string): void {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		)
	)
		throw new Error("Native session ID must be an exact UUID.");
}
