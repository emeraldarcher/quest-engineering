import { writeFile } from "node:fs/promises";

const [readyPath, childReadyPath] = process.argv.slice(2);
if (!readyPath || !childReadyPath) throw new Error("ready paths required");
const child = Bun.spawn(
  [
    process.execPath,
    `${import.meta.dir}/owned-process-child.ts`,
    childReadyPath,
  ],
  { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
);
await writeFile(
  readyPath,
  `${JSON.stringify({ parentPid: process.pid, childPid: child.pid })}\n`,
);
await new Promise<void>((resolve) => {
  process.on("SIGTERM", resolve);
  process.on("SIGINT", resolve);
});
