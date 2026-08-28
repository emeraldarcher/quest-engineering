import type { HerdrControlClient } from "./client.ts";
import {
  HERDR_SUPPORTED_PROTOCOLS,
  HerdrApiError,
  HerdrSocketClient,
} from "./client.ts";

const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const startedServers = new Map<string, ReturnType<typeof Bun.spawn>>();

export interface HerdrConnection {
  client: HerdrControlClient;
  sessionName: string;
  protocol: number;
  version?: string;
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

export class LocalHerdrConnectionProvider {
  readonly sessionName: string;
  constructor(sessionName: string) {
    this.sessionName = validateHerdrSessionName(sessionName);
  }

  async connect(): Promise<HerdrConnection> {
    let status = await this.status();
    if (status.running !== true) {
      this.startServer();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await Bun.sleep(100);
        status = await this.status();
        if (status.running === true) break;
      }
    }
    if (status.running !== true || typeof status.socket !== "string") {
      throw new HerdrApiError(
        "backend_unavailable",
        `Herdr session '${this.sessionName}' is not running.`,
      );
    }
    const protocol = Number(status.protocol);
    if (
      status.compatible !== true ||
      !Number.isInteger(protocol) ||
      !HERDR_SUPPORTED_PROTOCOLS.has(protocol)
    ) {
      throw new HerdrApiError(
        "backend_unavailable",
        `Herdr protocol ${String(status.protocol)} is unsupported.`,
      );
    }
    if (status.session !== this.sessionName)
      throw new HerdrApiError(
        "backend_unavailable",
        "Herdr resolved an unexpected named session.",
      );
    return {
      client: new HerdrSocketClient(status.socket),
      sessionName: this.sessionName,
      protocol,
      ...(typeof status.version === "string"
        ? { version: status.version }
        : {}),
    };
  }

  private async status(): Promise<Record<string, unknown>> {
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(
        ["herdr", "--session", this.sessionName, "status", "server", "--json"],
        { env: explicitEnvironment(), stdout: "pipe", stderr: "pipe" },
      );
    } catch (error) {
      throw new HerdrApiError(
        "backend_unavailable",
        `Herdr CLI is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new HerdrApiError(
        "backend_unavailable",
        stderr.trim() || "Herdr status failed.",
      );
    try {
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new HerdrApiError(
        "backend_unavailable",
        "Herdr status was not valid JSON.",
      );
    }
  }

  private startServer(): void {
    if (startedServers.has(this.sessionName)) return;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(["herdr", "--session", this.sessionName, "server"], {
        env: explicitEnvironment(),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (error) {
      throw new HerdrApiError(
        "backend_unavailable",
        `Could not start Herdr session '${this.sessionName}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    startedServers.set(this.sessionName, child);
    void child.exited.finally(() => {
      if (startedServers.get(this.sessionName) === child)
        startedServers.delete(this.sessionName);
    });
  }
}

function explicitEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env };
  delete environment.HERDR_SESSION;
  delete environment.HERDR_SOCKET_PATH;
  return environment;
}
