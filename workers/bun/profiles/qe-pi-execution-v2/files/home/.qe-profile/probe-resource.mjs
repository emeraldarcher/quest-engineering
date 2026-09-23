import { getCodexModelMetadata } from "./codex-model-eligibility.mjs";

const metadata = await getCodexModelMetadata({ snapshotPath: null });
console.log(
  JSON.stringify({
    schemaVersion: 3,
    authenticated: metadata.authenticated,
    status: metadata.status,
    metadataAuthority: metadata.authority,
    metadataConclusive: metadata.conclusive,
    modelCount: metadata.modelCount,
  }),
);
