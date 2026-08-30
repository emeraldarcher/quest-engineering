const GITHUB_PULL_REQUEST =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/;

export function canonicalPullRequestUrl(
  value: string,
  expectedNumber?: number,
): URL {
  const url = new URL(value);
  const match = value.match(GITHUB_PULL_REQUEST);
  if (!match || url.username || url.password || url.search || url.hash)
    throw new Error("The Pull Request URL is not a canonical GitHub URL.");
  if (expectedNumber !== undefined && Number(match[3]) !== expectedNumber)
    throw new Error(
      "The Pull Request URL does not match its persisted number.",
    );
  return url;
}

export async function openPullRequest(
  value: string,
  expectedNumber: number,
): Promise<void> {
  const url = canonicalPullRequestUrl(value, expectedNumber).toString();
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
