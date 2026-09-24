import { resolveHostPiOpenAiCredential } from "./pi-host-credential.ts";

interface OutputSink {
  write(value: string): unknown;
}

export async function runPiHostCredentialHelper(
  resolveCredential = resolveHostPiOpenAiCredential,
  stdout: OutputSink = process.stdout,
  stderr: OutputSink = process.stderr,
): Promise<number> {
  try {
    const resolved = await resolveCredential();
    stdout.write(resolved.accessToken);
    return 0;
  } catch {
    // SBX owns the resolver's stdout as secret material. Never echo errors,
    // provider responses, credential fields, or thrown values to either stream.
    stderr.write("QE Pi host credential resolution failed.\n");
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runPiHostCredentialHelper();
