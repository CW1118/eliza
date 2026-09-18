/** Verifies arithmetic inference preserves finished descriptive replies at both Stage-1 routing boundaries. */
import { describe, expect, it } from "vitest";
import { createBasicCapabilitiesPlugin } from "../../features/basic-capabilities/index.ts";
import {
	parseMessageHandlerOutput,
	routeMessageHandlerOutput,
} from "../../runtime/message-handler.ts";
import { runResponseHandlerEvaluators } from "../../runtime/response-handler-evaluators.ts";
import { AgentRuntime } from "../../runtime.ts";
import type { Memory } from "../../types/memory.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "./stage1-evaluators.ts";
import { messageHandlerFromFieldResult } from "./stage1-output.ts";

function routingRuntime() {
	const runtime = new AgentRuntime({
		character: { name: "Eliza", bio: [], settings: {} },
		disableBasicCapabilities: true,
	});
	const calculate = createBasicCapabilitiesPlugin().actions?.find(
		(action) => action.name === "CALCULATE",
	);
	if (!calculate) throw new Error("Basic capabilities must register CALCULATE");
	runtime.registerAction(calculate);
	return runtime;
}

const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.filter(
	(entry) => entry.name === "core.simple_registered_action_request",
);

function replyFields(replyText: string) {
	return {
		shouldRespond: "RESPOND" as const,
		contexts: ["simple"],
		intents: [],
		candidateActionNames: [],
		replyEffectStatus: "none" as const,
		replyText,
		facts: [],
		relationships: [],
		addressedTo: [],
	};
}

async function evaluateReply(
	runtime: AgentRuntime,
	text: string,
	reply: string,
) {
	const result = parseMessageHandlerOutput(JSON.stringify(replyFields(reply)));
	if (!result) throw new Error("A complete response envelope must parse");
	const trace = await runResponseHandlerEvaluators({
		runtime,
		message: {
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			roomId: runtime.agentId,
			content: { text, source: "direct" },
		} as Memory,
		state: { values: {}, data: {}, text: "" },
		messageHandler: result,
		availableContexts: [],
		evaluators: evaluator,
	});
	expect(evaluator).toHaveLength(1);
	expect(trace.errors).toEqual([]);
	return { result, trace };
}

describe("arithmetic request routing", () => {
	it.each([
		[
			"What is a 4×6 photo frame?",
			"A 4×6 frame holds a photograph four inches wide and six inches tall.",
		],
		[
			"What is a 2*4 timber used for?",
			"A 2*4 timber is a framing lumber size used for structural supports.",
		],
		[
			"I read 2 times 3 chapters last week.",
			"You are describing your reading schedule last week.",
		],
	])(
		"preserves the completed conversational answer to %s",
		async (text, reply) => {
			const runtime = routingRuntime();
			const structured = messageHandlerFromFieldResult(
				replyFields(reply),
				undefined,
				{
					actions: runtime.actions,
					messageText: text,
				},
			);
			expect(structured.plan.requiresTool).toBe(false);
			expect(structured.plan.candidateActions).toBeUndefined();
			expect(
				routeMessageHandlerOutput(structured, { messageText: text }),
			).toMatchObject({ type: "final_reply", reply });
			const { result, trace } = await evaluateReply(runtime, text, reply);
			expect(trace.appliedPatches).toEqual([]);
			expect(result.plan.reply).toBe(reply);
			expect(result.plan.requiresTool).not.toBe(true);
			expect(
				routeMessageHandlerOutput(result, { messageText: text }),
			).toMatchObject({ type: "final_reply", reply });
		},
	);

	it.each([
		"whats 17 times 23",
		"17*23",
		"2**10",
		"calculate 4×6",
		"what is 4×6?",
	])("requires computed evidence for %s", async (text) => {
		const runtime = routingRuntime();
		const structured = messageHandlerFromFieldResult(
			replyFields("The result is available."),
			undefined,
			{
				actions: runtime.actions,
				messageText: text,
			},
		);
		expect(structured.plan.requiresTool).toBe(true);
		expect(structured.plan.candidateActions).toEqual(["CALCULATE"]);
		expect(
			routeMessageHandlerOutput(structured, { messageText: text }).type,
		).toBe("planning_needed");
		const { result, trace } = await evaluateReply(
			runtime,
			text,
			"The result is available.",
		);
		expect(trace.candidateActionsAddedByEvaluators).toEqual(["CALCULATE"]);
		expect(result.plan.reply).toBeUndefined();
		expect(result.plan.requiresTool).toBe(true);
		expect(routeMessageHandlerOutput(result, { messageText: text }).type).toBe(
			"planning_needed",
		);
	});
});
