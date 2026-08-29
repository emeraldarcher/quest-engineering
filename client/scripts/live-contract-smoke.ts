import { Socket } from "phoenix";
import { ApiClient } from "../src/api/client";
import type { RunProjection } from "../src/api/contracts";

const httpBaseUrl =
  process.env.QE_SMOKE_HTTP_BASE_URL ?? "http://127.0.0.1:4000/api/v1";
const socketUrl =
  process.env.QE_SMOKE_SOCKET_URL ?? "ws://127.0.0.1:4000/client";
const workspaceId = required("QE_SMOKE_WORKSPACE_ID");
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const api = new ApiClient({ httpBaseUrl });

const options = (await api.listExecutionOptions()).filter(
  (option) => option.available,
);
const option = options.find((item) =>
  item.workspaces.some((workspace) => workspace.workspace_id === workspaceId),
);
if (!option)
  throw new Error(
    `No available execution option supports ${workspaceId}. Start the fake Worker first.`,
  );
const workspace = option.workspaces.find(
  (item) => item.workspace_id === workspaceId,
);
const reasoning = option.reasoning.includes("medium")
  ? "medium"
  : option.reasoning[0];
if (
  !workspace ||
  !reasoning ||
  !workspace.workspace_access.includes("read_write")
)
  throw new Error("Selected execution option cannot run the smoke Loadout.");

const builder = await api.createClass({
  key: `smoke-builder-${suffix}`,
  name: "Smoke Builder",
  description: "",
  instructions: "Produce the declared result.",
});
const loadout = await api.createLoadout({
  key: `smoke-coding-${suffix}`,
  name: "Smoke Coding",
  description: "",
  model: option.model,
  reasoning,
  tools: option.tools.filter((tool) => tool !== "terminal.shell"),
  workspace_access: "read_write",
});
const squad = await api.createSquad({
  key: `smoke-squad-${suffix}`,
  name: "Smoke Squad",
  description: "",
  members: [
    {
      member_key: "smoke-builder",
      name: "Smoke Builder",
      class_id: builder.id,
      loadout_id: loadout.id,
    },
  ],
});
const tactic = await api.createTactic({
  key: `smoke-tactic-${suffix}`,
  name: "Smoke Tactic",
  description: "",
  body: {
    type: "step",
    key: "work",
    name: "Smoke Work",
    instruction: "Return the declared result.",
    performer: { selector: "class", value: builder.key },
    context: { selector: "fresh", value: null },
    consumes: [],
    produces: [{ type: "result", source: null }],
  },
});
const quest = await api.createQuest({
  title: "Client realtime smoke",
  objective: "Verify Product launch and selected-Run invalidation.",
  workspace_id: workspaceId,
  squad_id: squad.id,
  tactic_source: { type: "definition", tactic_definition_id: tactic.id },
});
const launch = await api.launchQuest(quest.id);
const initial = await api.getRun(launch.runId);
const changed = await waitForChange(launch.runId, initial.revision);
console.log(
  JSON.stringify(
    {
      ok: true,
      run_id: changed.id,
      revision: changed.revision,
      status: changed.status,
    },
    null,
    2,
  ),
);

function waitForChange(
  runId: string,
  revision: number,
): Promise<RunProjection> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Timed out waiting for run_changed."));
    }, 20_000);
    const socket = new Socket(socketUrl);
    const channel = socket.channel(`run:${runId}`);
    channel.on("run_changed", () => {
      void api.getRun(runId).then((run) => {
        if (run.revision > revision) {
          clearTimeout(timeout);
          socket.disconnect();
          resolve(run);
        }
      }, reject);
    });
    socket.connect();
    channel
      .join()
      .receive("ok", () => {})
      .receive("error", () => {
        clearTimeout(timeout);
        reject(new Error("Could not join client run channel."));
      });
  });
}
function required(key: string) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}
