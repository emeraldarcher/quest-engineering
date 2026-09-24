import { writeFile } from "node:fs/promises";

const readyPath = process.argv[2];
if (!readyPath) throw new Error("ready path required");
await writeFile(readyPath, `${process.pid}\n`);
await new Promise<void>((resolve) => {
  process.on("SIGTERM", resolve);
  process.on("SIGINT", resolve);
});
