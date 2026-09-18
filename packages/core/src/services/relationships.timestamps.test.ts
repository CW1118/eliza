/** Exercises stored timestamp analytics, insights and component writes through the shipped runtime and in-memory adapter. */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter.ts";
import { AgentRuntime } from "../runtime.ts";
import { ChannelType, type UUID } from "../types/primitives.ts";
import { RelationshipsService } from "./relationships.ts";

const AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const SOURCE = "22222222-2222-4222-8222-222222222222" as UUID;
const TARGET = "33333333-3333-4333-8333-333333333333" as UUID;
const ROOM = "44444444-4444-4444-8444-444444444444" as UUID;
const MESSAGE_A = "55555555-5555-4555-8555-555555555555" as UUID;
const MESSAGE_B = "66666666-6666-4666-8666-666666666666" as UUID;

async function fixture() {
	const adapter = new InMemoryDatabaseAdapter(AGENT);
	await adapter.init();
	const runtime = new AgentRuntime({
		agentId: AGENT,
		character: { id: AGENT, name: "Eliza", bio: [], settings: {} },
		adapter,
		disableBasicCapabilities: true,
	});
	await runtime.createEntities([
		{ id: SOURCE, agentId: AGENT, names: ["Alice"] },
		{ id: TARGET, agentId: AGENT, names: ["Bob"] },
	]);
	const [id] = await adapter.createRelationships([
		{ sourceEntityId: SOURCE, targetEntityId: TARGET, tags: ["friend"] },
	]);
	const [relationship] = await adapter.getRelationshipsByIds([id]);
	return { runtime, adapter, relationship };
}

describe("relationship timestamp consumers", () => {
	it.each([
		{ days: 0, recent: true },
		{ days: 40, recent: false },
	])(
		"retains a stored ISO fallback with no message history ($days days)",
		async ({ days, recent }) => {
			const { runtime, adapter, relationship } = await fixture();
			try {
				const lastInteractionAt = new Date(
					Date.now() - days * 86400000 - 60000,
				).toISOString();
				await adapter.updateRelationships([
					{ ...relationship, lastInteractionAt, strength: 0 },
				]);
				const service = new RelationshipsService(runtime);
				const analytics = await service.analyzeRelationship(SOURCE, TARGET);
				expect(analytics?.lastInteractionAt).toBe(lastInteractionAt);
				const insights = await service.getRelationshipInsights(SOURCE);
				if (recent)
					expect(insights.recentInteractions).toMatchObject([
						{ entity: { id: TARGET }, lastInteraction: lastInteractionAt },
					]);
				else
					expect(insights.needsAttention).toMatchObject([
						{ entity: { id: TARGET }, daysSinceContact: 40 },
					]);
				const components = await runtime.getComponents(SOURCE);
				expect(
					components.filter((c) => c.type === "relationship_update"),
				).toMatchObject([
					{ data: { lastInteractionAt, strength: analytics?.strength } },
				]);
			} finally {
				await adapter.close();
			}
		},
	);

	it.each([
		Number.MAX_VALUE,
		-Number.MAX_VALUE,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.NaN,
	])(
		"leaves invalid stored message time %s out of date/response metrics",
		async (invalid) => {
			const { runtime, adapter } = await fixture();
			try {
				await runtime.createRooms([
					{
						id: ROOM,
						agentId: AGENT,
						source: "direct",
						type: ChannelType.GROUP,
					},
				]);
				await runtime.createRoomParticipants([SOURCE, TARGET], ROOM);
				const validAt = 1700000000000;
				await runtime.upsertMemory(
					{
						id: MESSAGE_A,
						agentId: AGENT,
						entityId: SOURCE,
						roomId: ROOM,
						createdAt: validAt,
						content: { text: "Hello" },
					},
					"messages",
				);
				await runtime.upsertMemory(
					{
						id: MESSAGE_B,
						agentId: AGENT,
						entityId: TARGET,
						roomId: ROOM,
						createdAt: invalid,
						content: { text: "Reply" },
					},
					"messages",
				);
				expect(
					await runtime.getMemoriesByRoomIds({
						tableName: "messages",
						roomIds: [ROOM],
					}),
				).toHaveLength(2);
				const service = new RelationshipsService(runtime);
				const analytics = await service.analyzeRelationship(SOURCE, TARGET);
				expect(analytics?.lastInteractionAt).toBe(
					new Date(validAt).toISOString(),
				);
				expect(analytics).not.toHaveProperty("averageResponseTime");
				const components = await runtime.getComponents(SOURCE);
				expect(
					components.filter((c) => c.type === "relationship_update"),
				).toMatchObject([
					{ data: { lastInteractionAt: new Date(validAt).toISOString() } },
				]);
			} finally {
				await adapter.close();
			}
		},
	);
});
