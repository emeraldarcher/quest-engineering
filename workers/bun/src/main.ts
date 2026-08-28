import { loadConfig } from "./config.ts";
import { QuestEngineeringWorker } from "./worker.ts";

const worker = new QuestEngineeringWorker(loadConfig());
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
