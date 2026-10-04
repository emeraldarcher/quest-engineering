import { resolveHostAntigravityCredential } from "./antigravity-host-credential.ts";

interface OutputSink {
  write(value: string): unknown;
}

export async function runAntigravityHostCredentialHelper(
  resolveCredential = resolveHostAntigravityCredential,
  stdout: OutputSink = process.stdout,
  stderr: OutputSink = process.stderr,
): Promise<number> {
  try {
    const resolved = await resolveCredential();
    stdout.write(resolved.accessToken);
    return 0;
  } catch {
    // SBX owns stdout as secret material. Never print provider responses,
    // keyring fields, account identity, or thrown values on either stream.
    stderr.write("QE Antigravity host credential resolution failed.\n");
    return 1;
  }
}

if (import.meta.main)
  process.exitCode = await runAntigravityHostCredentialHelper();
