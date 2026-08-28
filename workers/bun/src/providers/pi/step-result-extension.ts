import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonValue } from "../../protocol/types.ts";
import {
  readControl,
  STEP_RESULT_PROTOCOL_VERSION,
  type StepResultEnvelope,
  validateOutputs,
  writeStepResultAtomic,
} from "./result-envelope.ts";

export default function questEngineeringStepResultExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "qe_step_result",
    label: "Quest Engineering Step Result",
    description:
      "Submit the one final machine-readable result for the current Quest Engineering Action. Call exactly once as the final action.",
    promptSnippet: "Submit the final Quest Engineering Action outputs",
    promptGuidelines: [
      "Use qe_step_result exactly once as the final action and emit exactly the declared output keys.",
    ],
    parameters: Type.Object({
      outputs: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(toolCallId, params) {
      const controlPath = process.env.QE_RESULT_CONTROL_PATH?.trim();
      if (!controlPath) throw new Error("QE_RESULT_CONTROL_PATH is missing.");
      const control = await readControl(controlPath);
      validateOutputs(control.action.declared_outputs, params.outputs);
      const envelope: StepResultEnvelope = {
        protocolVersion: STEP_RESULT_PROTOCOL_VERSION,
        kind: "quest_engineering_step_result",
        workerId: control.workerId,
        actionId: control.action.action_id,
        runId: control.action.run_id,
        occurrenceId: control.action.occurrence_id,
        attemptId: control.action.attempt_id,
        nonce: control.nonce,
        createdAt: new Date().toISOString(),
        outputs: params.outputs as Record<string, JsonValue>,
      };
      await writeStepResultAtomic(
        control.resultDirectory,
        toolCallId,
        envelope,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: "Quest Engineering step result recorded.",
          },
        ],
        details: envelope,
        terminate: true,
      };
    },
  });
}
