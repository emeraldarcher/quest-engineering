import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonValue } from "../../protocol/types.ts";
import { HarnessControlClient } from "../control/client.ts";

/** Pi-native transport shim into the generic Worker-local QE control bridge. */
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
      const result = await HarnessControlClient.fromEnvironment().completeStep(
        params.outputs as Record<string, JsonValue>,
        toolCallId,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: "Quest Engineering step result recorded.",
          },
        ],
        details: result,
        terminate: true,
      };
    },
  });
}
