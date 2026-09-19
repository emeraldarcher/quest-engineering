import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionBackendReadiness } from "../types.ts";
import {
  HerdrApiError,
  type HerdrControlClient,
  HerdrSocketClient,
} from "./client.ts";
import {
  evaluateHerdrCompatibility,
  HERDR_MIN_ENDPOINT_GENERATION,
  type HerdrCompatibilityEvidence,
  incompatibleHerdrReadiness,
  readinessDetail,
  unavailableHerdrReadiness,
} from "./compatibility.ts";
import {
  assertMatchingOwnership,
  canonicalSessionDirectory,
  claimOwnerMarker,
  HERDR_OWNERSHIP_SOURCE,
  HERDR_OWNERSHIP_TOKEN,
  type HerdrSessionOwnershipRecord,
  ownerMarkerPath,
  ownershipConflict,
  readOwnershipRecord,
  writeOwnershipRecord,
} from "./ownership.ts";

const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const SERVER_START_RECONCILIATION_MS = [
  10, 20, 40, 80, 160, 320, 640, 1_280, 2_560, 5_000, 5_000,
] as const;

interface StartedServer {
  exited: Promise<number>;
}
const startedServers = new Map<string, StartedServer>();
const infrastructureEnsures = new Map<
  string,
  Promise<HerdrInfrastructureIdentity>
>();

export interface HerdrConnection {
  client: HerdrControlClient;
  sessionName: string;
  sessionIncarnation: string;
  protocol: number;
  version?: string;
  readiness: SessionBackendReadiness;
}

export interface HerdrInfrastructureIdentity {
  sessionName: string;
  sessionDirectory: string;
  sessionIncarnation: string;
  serverGeneration: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ListedSession {
  name: string;
  running: boolean;
  sessionDirectory: string;
  socketPath: string;
}

type CommandRunner = (args: string[]) => Promise<CommandResult>;
type ClientFactory = (
  socketPath: string,
  onUnavailable: () => void,
) => HerdrControlClient;
type ServerStarter = (sessionName: string) => StartedServer;

interface ProviderDependencies {
  workerId: string;
  dataRoot: string;
  runCommand?: CommandRunner;
  createClient?: ClientFactory;
  startServer?: ServerStarter;
  now?: () => string;
  randomUUID?: () => string;
}

export function validateHerdrSessionName(value: string): string {
  const name = value.trim();
  if (!SESSION_NAME.test(name) || Buffer.byteLength(name, "utf8") > 64) {
    throw new HerdrApiError(
      "invalid_session",
      "Herdr session must be 1-64 ASCII letters, digits, '.', '_' or '-'.",
    );
  }
  if (name === "default")
    throw new HerdrApiError(
      "invalid_session",
      "The shared Herdr default session is forbidden.",
    );
  return name;
}

/**
 * Owns one Worker-scoped named Herdr session. Infrastructure ensure is explicit
 * and potentially mutating; readiness remains observation-only.
 */
export class LocalHerdrConnectionProvider {
  readonly sessionName: string;
  private cached:
    | {
        generation: string;
        probeGeneration: number;
        evidence: HerdrCompatibilityEvidence;
        ownershipWorkspaceId: string | null;
      }
    | undefined;
  private compatibilityProbeGeneration = 0;
  private currentOwnership: HerdrSessionOwnershipRecord | undefined;
  private ensureOperation: Promise<HerdrInfrastructureIdentity> | undefined;
  private readonly workerId: string;
  private readonly ownershipPath: string;
  private readonly runCommand: CommandRunner;
  private readonly createClient: ClientFactory;
  private readonly startNamedServer: ServerStarter;
  private readonly now: () => string;
  private readonly randomUUID: () => string;

  constructor(sessionName: string, dependencies: ProviderDependencies) {
    this.sessionName = validateHerdrSessionName(sessionName);
    this.workerId = dependencies.workerId;
    this.ownershipPath = join(
      dependencies.dataRoot,
      "herdr-session-ownership.json",
    );
    this.runCommand = dependencies.runCommand ?? runHerdrCommand;
    this.createClient =
      dependencies.createClient ??
      ((socketPath, onUnavailable) =>
        new HerdrSocketClient(socketPath, 30_000, onUnavailable));
    this.startNamedServer = dependencies.startServer ?? startHerdrServer;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  }

  sessionIncarnation(): string | null {
    return this.currentOwnership?.sessionIncarnation ?? null;
  }

  /** May create/start infrastructure, but never creates a QE execution agent. */
  ensureInfrastructure(): Promise<HerdrInfrastructureIdentity> {
    if (this.ensureOperation) return this.ensureOperation;
    const key = `${this.ownershipPath}:${this.sessionName}`;
    const shared = infrastructureEnsures.get(key);
    const base = shared ?? this.ensureInfrastructureOnce();
    if (!shared) {
      infrastructureEnsures.set(key, base);
      void base.then(
        () => {
          if (infrastructureEnsures.get(key) === base)
            infrastructureEnsures.delete(key);
        },
        () => {
          if (infrastructureEnsures.get(key) === base)
            infrastructureEnsures.delete(key);
        },
      );
    }
    const operation = (
      shared
        ? base.then(async (identity) => {
            await this.adoptSharedInfrastructure(identity);
            return identity;
          })
        : base
    ).finally(() => {
      if (this.ensureOperation === operation) this.ensureOperation = undefined;
    });
    this.ensureOperation = operation;
    return operation;
  }

  /** Observation-only: never creates or starts a Herdr session. */
  async readiness(harnessKind: string): Promise<SessionBackendReadiness> {
    try {
      const observed = await this.observeOwnedSession();
      if (!observed.session.running)
        return unavailableHerdrReadiness(
          harnessKind,
          `QE-owned Herdr session '${this.sessionName}' is stopped.`,
        );
      const status = await this.status();
      assertStatusMatchesSession(status, observed.session);
      const result = await this.readinessFromStatus(
        harnessKind,
        status,
        observed.ownership,
      );
      if (result.ready) await this.verifyLiveOwnership(observed.ownership);
      return result;
    } catch (error) {
      return readinessForError(harnessKind, error);
    }
  }

  /** Connection establishment owns recovery of missing/stopped infrastructure. */
  async connect(harnessKind: string): Promise<HerdrConnection> {
    let observed: Awaited<ReturnType<typeof this.observeOwnedSession>>;
    try {
      observed = await this.observeOwnedSession();
    } catch (error) {
      if (
        !(error instanceof HerdrApiError) ||
        error.code !== "backend_unavailable"
      )
        throw error;
      await this.ensureInfrastructure();
      observed = await this.observeOwnedSession();
    }
    if (!observed.session.running) {
      const infrastructure = await this.ensureInfrastructure();
      observed = await this.observeOwnedSession();
      if (
        infrastructure.sessionIncarnation !==
        observed.ownership.sessionIncarnation
      )
        throw ownershipConflict(
          `Herdr session '${this.sessionName}' changed physical incarnation while connecting.`,
        );
    }
    const status = await this.status();
    assertStatusMatchesSession(status, observed.session);
    const readiness = await this.readinessFromStatus(
      harnessKind,
      status,
      observed.ownership,
    );
    if (!readiness.ready) throwForReadiness(readiness);
    const socket = requiredString(status.socket, "status.socket");
    const currentServerGeneration = requiredString(
      readiness.provenance.serverGeneration,
      "readiness.server_generation",
    );
    const cacheGeneration = `${observed.ownership.sessionIncarnation}:${currentServerGeneration}`;
    const cachedOwnershipWorkspaceId =
      this.cached?.generation === cacheGeneration
        ? this.cached.ownershipWorkspaceId
        : null;
    const ownershipWorkspaceId =
      cachedOwnershipWorkspaceId ??
      (await this.ensureLiveOwnership(observed.ownership));
    if (
      this.cached?.generation === cacheGeneration &&
      this.cached.ownershipWorkspaceId !== ownershipWorkspaceId
    )
      this.cached = {
        ...this.cached,
        ownershipWorkspaceId,
      };
    if (
      observed.ownership.serverGeneration !== currentServerGeneration ||
      observed.ownership.ownershipWorkspaceId !== ownershipWorkspaceId
    ) {
      observed = {
        ...observed,
        ownership: {
          ...observed.ownership,
          state: "active",
          ownershipWorkspaceId,
          serverGeneration: currentServerGeneration,
          updatedAt: this.now(),
        },
      };
      await writeOwnershipRecord(this.ownershipPath, observed.ownership);
      this.currentOwnership = observed.ownership;
    }
    const protocol = requiredInteger(status.protocol, "status.protocol");
    const probeGeneration =
      this.cached?.generation === cacheGeneration
        ? this.cached.probeGeneration
        : this.compatibilityProbeGeneration;
    return {
      client: this.createClient(socket, () =>
        this.invalidateThrough(probeGeneration),
      ),
      sessionName: this.sessionName,
      sessionIncarnation: observed.ownership.sessionIncarnation,
      protocol,
      ...(typeof status.version === "string"
        ? { version: status.version }
        : {}),
      readiness,
    };
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private invalidateThrough(probeGeneration: number): void {
    if (!this.cached || this.cached.probeGeneration <= probeGeneration)
      this.cached = undefined;
  }

  private async ensureInfrastructureOnce(): Promise<HerdrInfrastructureIdentity> {
    const schema = await this.schema();
    assertSessionLifecycleContract(schema);
    const sessions = await this.listSessions();
    const existing = this.onlyNamedSession(sessions);
    let primary = await readOwnershipRecord(
      this.ownershipPath,
      "QE Worker Herdr ownership record",
    );
    if (
      primary &&
      (primary.workerId !== this.workerId ||
        primary.sessionName !== this.sessionName)
    )
      throw ownershipConflict(
        `The QE Worker ownership record belongs to Worker '${primary.workerId}' and session '${primary.sessionName}', not Worker '${this.workerId}' and session '${this.sessionName}'.`,
      );

    let session: ListedSession;
    if (!existing) {
      const timestamp = this.now();
      primary = {
        version: 1,
        state: "claiming",
        workerId: this.workerId,
        sessionName: this.sessionName,
        sessionIncarnation: this.randomUUID(),
        sessionDirectory: null,
        sessionDirectoryIdentity: null,
        ownershipWorkspaceId: null,
        serverGeneration: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      // The primary record is the ownership authority and records claim intent
      // before the physical named server can appear.
      await writeOwnershipRecord(this.ownershipPath, primary);
      session = await this.startAndReconcile();
      const directory = await canonicalSessionDirectory(
        session.sessionDirectory,
      );
      primary = {
        ...primary,
        sessionDirectory: directory.path,
        sessionDirectoryIdentity: directory.identity,
        updatedAt: this.now(),
      };
      await writeOwnershipRecord(this.ownershipPath, primary);
      primary = await claimOwnerMarker(directory.path, primary, true);
      await writeOwnershipRecord(this.ownershipPath, primary);
    } else {
      const directory = await canonicalSessionDirectory(
        existing.sessionDirectory,
      );
      const marker = await readOwnershipRecord(
        ownerMarkerPath(directory.path),
        "Herdr owner marker",
      );
      primary = assertMatchingOwnership(primary, marker, {
        workerId: this.workerId,
        sessionName: this.sessionName,
        sessionDirectory: directory.path,
        sessionDirectoryIdentity: directory.identity,
      });
      if (!marker) await claimOwnerMarker(directory.path, primary);
      session = existing.running ? existing : await this.startAndReconcile();
    }

    const directory = await canonicalSessionDirectory(session.sessionDirectory);
    if (
      primary.sessionDirectory !== directory.path ||
      primary.sessionDirectoryIdentity !== directory.identity
    )
      throw ownershipConflict(
        `Herdr session directory identity changed while ensuring '${this.sessionName}'.`,
      );

    const status = await this.status();
    const sharedReadiness = await this.readinessFromStatus(
      "worker-infrastructure",
      status,
      primary,
    );
    if (!sharedReadiness.ready) throwForReadiness(sharedReadiness);

    this.currentOwnership = primary;
    const ownershipWorkspaceId = await this.ensureLiveOwnership(primary);
    const serverTransportGeneration = requiredString(
      sharedReadiness.provenance.serverGeneration,
      "readiness.server_generation",
    );
    const active: HerdrSessionOwnershipRecord = {
      ...primary,
      state: "active",
      ownershipWorkspaceId,
      serverGeneration: serverTransportGeneration,
      updatedAt: this.now(),
    };
    await writeOwnershipRecord(this.ownershipPath, active);
    this.currentOwnership = active;
    return {
      sessionName: active.sessionName,
      sessionDirectory: directory.path,
      sessionIncarnation: active.sessionIncarnation,
      serverGeneration: serverTransportGeneration,
    };
  }

  private async adoptSharedInfrastructure(
    identity: HerdrInfrastructureIdentity,
  ): Promise<void> {
    const primary = await readOwnershipRecord(
      this.ownershipPath,
      "QE Worker Herdr ownership record",
    );
    if (
      !primary ||
      primary.state !== "active" ||
      primary.workerId !== this.workerId ||
      primary.sessionName !== identity.sessionName ||
      primary.sessionIncarnation !== identity.sessionIncarnation ||
      primary.sessionDirectory !== identity.sessionDirectory
    )
      throw ownershipConflict(
        `Concurrent ensure produced ownership that does not belong to Worker '${this.workerId}'.`,
      );
    this.currentOwnership = primary;
  }

  private async observeOwnedSession(): Promise<{
    session: ListedSession;
    ownership: HerdrSessionOwnershipRecord;
  }> {
    const session = this.onlyNamedSession(await this.listSessions());
    if (!session)
      throw new HerdrApiError(
        "backend_unavailable",
        `QE-owned Herdr session '${this.sessionName}' does not exist.`,
        "backend.session_lifecycle",
      );
    const directory = await canonicalSessionDirectory(session.sessionDirectory);
    const [primary, marker] = await Promise.all([
      readOwnershipRecord(
        this.ownershipPath,
        "QE Worker Herdr ownership record",
      ),
      readOwnershipRecord(
        ownerMarkerPath(directory.path),
        "Herdr owner marker",
      ),
    ]);
    const ownership = assertMatchingOwnership(primary, marker, {
      workerId: this.workerId,
      sessionName: this.sessionName,
      sessionDirectory: directory.path,
      sessionDirectoryIdentity: directory.identity,
    });
    if (!marker || ownership.state !== "active")
      throw new HerdrApiError(
        "backend_unavailable",
        `Herdr session '${this.sessionName}' ownership ensure is incomplete.`,
        "backend.session_lifecycle",
      );
    this.currentOwnership = ownership;
    return { session, ownership };
  }

  private async readinessFromStatus(
    harnessKind: string,
    status: Record<string, unknown>,
    ownership: HerdrSessionOwnershipRecord,
  ): Promise<SessionBackendReadiness> {
    if (status.running !== true)
      return unavailableHerdrReadiness(
        harnessKind,
        `Herdr session '${this.sessionName}' is not running.`,
      );
    if (status.session !== this.sessionName)
      return incompatibleHerdrReadiness(
        harnessKind,
        "backend.named_session",
        "Herdr resolved an unexpected named session.",
        withSessionIncarnation(provenance(status), ownership),
      );
    if (status.compatible !== true)
      return incompatibleHerdrReadiness(
        harnessKind,
        "backend.wire_compatibility",
        "Herdr did not report compatible client/server wire behavior.",
        withSessionIncarnation(provenance(status), ownership),
        "wire_incompatible",
      );
    if (status.endpoint_compatible !== true)
      return incompatibleHerdrReadiness(
        harnessKind,
        "backend.endpoint_compatibility",
        "Herdr did not report a compatible endpoint API.",
        withSessionIncarnation(provenance(status), ownership),
        "wire_incompatible",
      );
    const endpointGeneration = provenance(status).endpointGeneration;
    if (
      endpointGeneration === undefined ||
      endpointGeneration < HERDR_MIN_ENDPOINT_GENERATION
    )
      return incompatibleHerdrReadiness(
        harnessKind,
        "backend.endpoint_generation_1",
        `Herdr endpoint generation ${String(endpointGeneration ?? "unknown")} does not meet QE's generation ${HERDR_MIN_ENDPOINT_GENERATION} compatibility floor.`,
        withSessionIncarnation(provenance(status), ownership),
        "endpoint_generation_unsupported",
      );
    const socket = requiredString(status.socket, "status.socket");
    const transportGeneration = serverGeneration(socket, status);
    const cacheGeneration = `${ownership.sessionIncarnation}:${transportGeneration}`;
    if (this.cached?.generation === cacheGeneration) {
      const readiness = evaluateHerdrCompatibility(
        harnessKind,
        this.cached.evidence,
      );
      return appendSessionIncarnation(readiness, ownership);
    }

    const probeGeneration = ++this.compatibilityProbeGeneration;
    let client: HerdrControlClient | null = null;
    try {
      const schema = await this.schema();
      client = this.createClient(socket, () =>
        this.invalidateThrough(probeGeneration),
      );
      const [ping, snapshot, integrations] = await Promise.all([
        client.ping(),
        client.snapshot(),
        client.integrations(),
      ]);
      const ownershipWorkspaceId = assertWorkspaceOwnership(
        snapshot,
        ownership,
      );
      const evidence: HerdrCompatibilityEvidence = {
        status,
        schema,
        ping,
        snapshot,
        integrations,
        serverGeneration: transportGeneration,
      };
      const result = evaluateHerdrCompatibility(harnessKind, evidence);
      if (
        result.ready &&
        (!this.cached || this.cached.probeGeneration <= probeGeneration)
      )
        this.cached = {
          generation: cacheGeneration,
          probeGeneration,
          evidence,
          ownershipWorkspaceId,
        };
      return appendSessionIncarnation(result, ownership);
    } catch (error) {
      const newer =
        this.cached?.generation === cacheGeneration &&
        this.cached.probeGeneration > probeGeneration
          ? this.cached
          : null;
      if (newer)
        return appendSessionIncarnation(
          evaluateHerdrCompatibility(harnessKind, newer.evidence),
          ownership,
        );
      this.invalidateThrough(probeGeneration);
      return readinessForError(
        harnessKind,
        error,
        withSessionIncarnation(provenance(status), ownership),
      );
    } finally {
      client?.disconnect();
    }
  }

  private async ensureLiveOwnership(
    ownership: HerdrSessionOwnershipRecord,
  ): Promise<string> {
    const status = await this.status();
    const socket = requiredString(status.socket, "status.socket");
    const probeGeneration =
      this.cached?.probeGeneration ?? this.compatibilityProbeGeneration;
    const client = this.createClient(socket, () =>
      this.invalidateThrough(probeGeneration),
    );
    try {
      const snapshot = await client.snapshot();
      const matching = assertWorkspaceOwnership(snapshot, ownership);
      if (matching) return matching;
      const workspace =
        snapshot.workspaces.find(
          (item) => item.workspaceId === ownership.ownershipWorkspaceId,
        ) ??
        [...snapshot.workspaces].sort((left, right) =>
          left.workspaceId.localeCompare(right.workspaceId),
        )[0];
      const ownershipWorkspace =
        workspace ??
        (await client.createWorkspace({
          cwd: dirname(this.ownershipPath),
          label: "QE Worker infrastructure",
          env: {},
        }));
      await client.reportWorkspaceMetadata({
        workspaceId: ownershipWorkspace.workspaceId,
        source: HERDR_OWNERSHIP_SOURCE,
        tokens: workspaceOwnershipTokens(ownership),
      });
      const verified = assertWorkspaceOwnership(
        await client.snapshot(),
        ownership,
      );
      if (verified !== ownershipWorkspace.workspaceId)
        throw new HerdrApiError(
          "backend_incompatible",
          "Herdr did not retain the QE Worker ownership metadata it accepted.",
          "session.ownership_metadata",
        );
      return verified;
    } finally {
      client.disconnect();
    }
  }

  private async verifyLiveOwnership(
    ownership: HerdrSessionOwnershipRecord,
  ): Promise<string | null> {
    const socket = requiredString(
      (await this.status()).socket,
      "status.socket",
    );
    const probeGeneration =
      this.cached?.probeGeneration ?? this.compatibilityProbeGeneration;
    const client = this.createClient(socket, () =>
      this.invalidateThrough(probeGeneration),
    );
    try {
      // Durable ownership plus the session marker is authoritative. Live
      // workspace metadata is additive corroboration, but any conflict still
      // fails an explicit readiness observation closed.
      return assertWorkspaceOwnership(await client.snapshot(), ownership);
    } finally {
      client.disconnect();
    }
  }

  private async startAndReconcile(): Promise<ListedSession> {
    const server = this.startServer();
    for (const delay of SERVER_START_RECONCILIATION_MS) {
      const session = this.onlyNamedSession(await this.listSessions());
      if (session?.running) {
        const status = await this.status();
        if (status.running === true) return session;
      }
      const outcome = await Promise.race([
        server.exited.then((exitCode) => ({ exitCode })),
        Bun.sleep(delay).then(() => null),
      ]);
      if (outcome) {
        const afterExit = this.onlyNamedSession(await this.listSessions());
        if (afterExit?.running) return afterExit;
        throw new HerdrApiError(
          outcome.exitCode === 2
            ? "backend_incompatible"
            : "backend_unavailable",
          `Herdr session '${this.sessionName}' server exited with status ${outcome.exitCode} before becoming ready.`,
          "backend.session_lifecycle",
        );
      }
    }
    throw new HerdrApiError(
      "backend_unavailable",
      `Herdr session '${this.sessionName}' did not become ready during bounded startup reconciliation.`,
      "backend.session_lifecycle",
    );
  }

  private startServer(): StartedServer {
    const key = `${this.ownershipPath}:${this.sessionName}`;
    const existing = startedServers.get(key);
    if (existing) return existing;
    let server: StartedServer;
    try {
      server = this.startNamedServer(this.sessionName);
    } catch (error) {
      if (error instanceof HerdrApiError) throw error;
      throw new HerdrApiError(
        "backend_unavailable",
        `Could not start Herdr session '${this.sessionName}': ${error instanceof Error ? error.message : String(error)}`,
        "backend.session_lifecycle",
      );
    }
    startedServers.set(key, server);
    void server.exited.finally(() => {
      if (startedServers.get(key) === server) startedServers.delete(key);
    });
    return server;
  }

  private onlyNamedSession(sessions: ListedSession[]): ListedSession | null {
    const matching = sessions.filter((item) => item.name === this.sessionName);
    if (matching.length > 1)
      throw ownershipConflict(
        `Herdr reported multiple sessions named '${this.sessionName}'.`,
      );
    return matching[0] ?? null;
  }

  private async listSessions(): Promise<ListedSession[]> {
    const result = await this.runCommand(["session", "list", "--json"]);
    if (result.exitCode !== 0)
      throw new HerdrApiError(
        result.exitCode === 2 ? "backend_incompatible" : "backend_unavailable",
        result.stderr.trim() || "Herdr session inventory is unavailable.",
        "backend.session_lifecycle",
      );
    const parsed = parseObject(result.stdout, "Herdr session inventory");
    if (!Array.isArray(parsed.sessions))
      throw new HerdrApiError(
        "backend_incompatible",
        "Herdr session inventory omitted its sessions array.",
        "backend.session_lifecycle",
      );
    return parsed.sessions.map((value, index) => {
      const item = object(value, `sessions[${index}]`);
      return {
        name: requiredString(item.name, `sessions[${index}].name`),
        running: requiredBoolean(item.running, `sessions[${index}].running`),
        sessionDirectory: requiredString(
          item.session_dir,
          `sessions[${index}].session_dir`,
        ),
        socketPath: requiredString(
          item.socket_path,
          `sessions[${index}].socket_path`,
        ),
      };
    });
  }

  private async status(): Promise<Record<string, unknown>> {
    const result = await this.runCommand([
      "--session",
      this.sessionName,
      "status",
      "server",
      "--json",
    ]);
    if (result.exitCode !== 0)
      throw new HerdrApiError(
        result.exitCode === 2 ? "backend_incompatible" : "backend_unavailable",
        result.stderr.trim() || "Herdr status failed.",
        result.exitCode === 2 ? "backend.session_lifecycle" : undefined,
      );
    return parseObject(result.stdout, "Herdr status");
  }

  private async schema(): Promise<Record<string, unknown>> {
    // Schema is bundled client metadata and does not need to address/create the
    // Worker-owned named session.
    const result = await this.runCommand(["api", "schema", "--json"]);
    if (result.exitCode !== 0)
      throw new HerdrApiError(
        result.exitCode === 2 ? "backend_incompatible" : "backend_unavailable",
        result.stderr.trim() || "Herdr API schema metadata is unavailable.",
        "backend.api_metadata",
      );
    return parseObject(
      result.stdout,
      "Herdr API schema",
      "backend.api_metadata",
    );
  }
}

function assertStatusMatchesSession(
  status: Record<string, unknown>,
  session: ListedSession,
): void {
  const socket = requiredString(status.socket, "status.socket");
  if (socket !== session.socketPath)
    throw ownershipConflict(
      `Herdr status for '${session.name}' resolved socket '${socket}', but session inventory resolved '${session.socketPath}'.`,
    );
}

function assertSessionLifecycleContract(schema: Record<string, unknown>): void {
  const methods = new Set<string>();
  visit(schema, (value) => {
    const properties = objectOrNull(value.properties);
    const method = objectOrNull(properties?.method)?.const;
    if (typeof method === "string") methods.add(method);
  });
  for (const method of [
    "ping",
    "session.snapshot",
    "workspace.report_metadata",
  ])
    if (!methods.has(method))
      throw new HerdrApiError(
        "backend_incompatible",
        `Herdr cannot ensure QE-owned sessions because API metadata omits '${method}'.`,
        method === "workspace.report_metadata"
          ? "session.ownership_metadata"
          : "backend.session_lifecycle",
      );
}

function assertWorkspaceOwnership(
  snapshot: HerdrCompatibilityEvidence["snapshot"],
  ownership: HerdrSessionOwnershipRecord,
): string | null {
  const expected = workspaceOwnershipTokens(ownership);
  let match: string | null = null;
  for (const workspace of snapshot.workspaces) {
    const tokens = workspace.tokens;
    if (!tokens || !Object.keys(expected).some((key) => key in tokens))
      continue;
    if (Object.entries(expected).some(([key, value]) => tokens[key] !== value))
      throw ownershipConflict(
        `Live Herdr workspace metadata conflicts with durable ownership for session '${ownership.sessionName}'.`,
      );
    if (match && match !== workspace.workspaceId)
      throw ownershipConflict(
        `Multiple Herdr workspaces claim infrastructure ownership for session '${ownership.sessionName}'.`,
      );
    match = workspace.workspaceId;
  }
  return match;
}

function workspaceOwnershipTokens(
  ownership: HerdrSessionOwnershipRecord,
): Record<string, string> {
  return {
    qe_infrastructure_owner: HERDR_OWNERSHIP_TOKEN,
    qe_worker_id: ownership.workerId,
    qe_session_incarnation: ownership.sessionIncarnation,
  };
}

function readinessForError(
  harnessKind: string,
  error: unknown,
  currentProvenance?: SessionBackendReadiness["provenance"],
): SessionBackendReadiness {
  if (error instanceof HerdrApiError) {
    if (
      ["backend_unavailable", "server_not_running", "timeout"].includes(
        error.code,
      )
    )
      return unavailableHerdrReadiness(harnessKind, error.message);
    return incompatibleHerdrReadiness(
      harnessKind,
      error.capability ?? "backend.contract",
      error.message,
      currentProvenance,
      error.capability === "backend.session_ownership"
        ? "ownership_conflict"
        : "malformed_contract",
    );
  }
  return unavailableHerdrReadiness(
    harnessKind,
    error instanceof Error ? error.message : String(error),
  );
}

function throwForReadiness(readiness: SessionBackendReadiness): never {
  throw new HerdrApiError(
    readiness.status === "unavailable"
      ? "backend_unavailable"
      : "backend_incompatible",
    readinessDetail(readiness),
    readiness.missingCapabilities[0],
  );
}

function appendSessionIncarnation(
  readiness: SessionBackendReadiness,
  ownership: HerdrSessionOwnershipRecord,
): SessionBackendReadiness {
  return {
    ...readiness,
    provenance: {
      ...readiness.provenance,
      sessionIncarnation: ownership.sessionIncarnation,
    },
  };
}

function withSessionIncarnation(
  value: SessionBackendReadiness["provenance"],
  ownership: HerdrSessionOwnershipRecord,
): SessionBackendReadiness["provenance"] {
  return { ...value, sessionIncarnation: ownership.sessionIncarnation };
}

function parseObject(
  value: string,
  label: string,
  capability = "backend.status",
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Use the capability-specific error below.
  }
  throw new HerdrApiError(
    "backend_incompatible",
    `${label} was not a JSON object.`,
    capability,
  );
}

function serverGeneration(
  socket: string,
  status: Record<string, unknown>,
): string {
  try {
    const stat = statSync(socket);
    return [
      socket,
      stat.dev,
      stat.ino,
      stat.birthtimeMs,
      stat.mtimeMs,
      status.version,
      status.protocol,
    ].join(":");
  } catch (error) {
    throw new HerdrApiError(
      "backend_unavailable",
      `Herdr socket generation cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function provenance(
  status: Record<string, unknown>,
): SessionBackendReadiness["provenance"] {
  const capabilities = objectOrNull(status.capabilities);
  return {
    ...(typeof status.version === "string" ? { version: status.version } : {}),
    ...(typeof status.protocol === "number" && Number.isInteger(status.protocol)
      ? { protocol: status.protocol }
      : {}),
    ...(typeof capabilities?.endpoint_protocol_generation === "number" &&
    Number.isInteger(capabilities.endpoint_protocol_generation)
      ? {
          endpointGeneration: capabilities.endpoint_protocol_generation,
        }
      : {}),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new HerdrApiError(
      "backend_incompatible",
      `Herdr ${label} is missing.`,
      "backend.status",
    );
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new HerdrApiError(
      "backend_incompatible",
      `Herdr ${label} is missing.`,
      "backend.status",
    );
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new HerdrApiError(
      "backend_incompatible",
      `Herdr ${label} is missing.`,
      "backend.session_lifecycle",
    );
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  const result = objectOrNull(value);
  if (!result)
    throw new HerdrApiError(
      "backend_incompatible",
      `Herdr ${label} is malformed.`,
      "backend.session_lifecycle",
    );
  return result;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function visit(
  value: unknown,
  callback: (item: Record<string, unknown>) => void,
): void {
  const item = objectOrNull(value);
  if (item) {
    callback(item);
    for (const nested of Object.values(item)) visit(nested, callback);
  } else if (Array.isArray(value)) {
    for (const nested of value) visit(nested, callback);
  }
}

async function runHerdrCommand(args: string[]): Promise<CommandResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(["herdr", ...args], {
      env: explicitEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new HerdrApiError(
      "backend_unavailable",
      `Herdr CLI is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function startHerdrServer(sessionName: string): StartedServer {
  const child = Bun.spawn(["herdr", "--session", sessionName, "server"], {
    env: explicitEnvironment(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  return child;
}

function explicitEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env };
  delete environment.HERDR_SESSION;
  delete environment.HERDR_SOCKET_PATH;
  delete environment.HERDR_WORKSPACE_ID;
  delete environment.HERDR_TAB_ID;
  delete environment.HERDR_PANE_ID;
  return environment;
}
