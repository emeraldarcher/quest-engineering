import { SbxAntigravityCredentialProvisioner } from "./sbx-antigravity-credential.ts";
import type { SbxClient } from "./sbx-client.ts";
import { SbxPiCredentialProvisioner } from "./sbx-pi-credential.ts";

interface PiCredentialProvisioner {
  provision(sandboxName: string): Promise<{ placeholder: string }>;
  revoke(sandboxName: string, placeholder: string): Promise<void>;
}

interface AntigravityCredentialProvisioner {
  provision(sandboxName: string): Promise<unknown>;
}

/** Compose independent subscription authorities for one mixed-harness Run VM. */
export class SbxMixedCredentialProvisioner {
  private readonly pi: PiCredentialProvisioner;
  private readonly antigravity: AntigravityCredentialProvisioner;

  constructor(
    client: SbxClient,
    options: {
      pi?: PiCredentialProvisioner;
      antigravity?: AntigravityCredentialProvisioner;
    } = {},
  ) {
    this.pi = options.pi ?? new SbxPiCredentialProvisioner(client);
    this.antigravity =
      options.antigravity ?? new SbxAntigravityCredentialProvisioner(client);
  }

  async provision(sandboxName: string): Promise<void> {
    const pi = await this.pi.provision(sandboxName);
    try {
      await this.antigravity.provision(sandboxName);
    } catch (error) {
      await this.pi.revoke(sandboxName, pi.placeholder).catch(() => undefined);
      throw error;
    }
  }
}
