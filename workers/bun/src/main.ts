import { loadConfig } from "./config.ts";
import { QuestEngineeringWorker } from "./worker.ts";

const config = loadConfig();
if (
  config.herdrBin &&
  config.herdrConfigHome &&
  config.herdrConfigPath &&
  config.herdrLocalContextId
)
  console.log(
    JSON.stringify({
      event: "herdr_local_context_resolved",
      executable: config.herdrBin,
      configHome: config.herdrConfigHome,
      configPath: config.herdrConfigPath,
      contextId: config.herdrLocalContextId,
    }),
  );
const worker = new QuestEngineeringWorker(config);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await worker.stop();
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

try {
  await worker.run();
} finally {
  await stop();
}
