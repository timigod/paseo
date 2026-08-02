import type { CreateAgentRequestMessage } from "@getpaseo/protocol/messages";
import { z } from "zod";

const AgentRunIntentEnvelopeSchema = z
  .object({
    create: z.unknown(),
    prompt: z.string().min(1),
    waitTimeoutMs: z.number().int().nonnegative(),
    background: z.boolean(),
  })
  .strict();

export interface AgentRunIntent extends Omit<
  z.infer<typeof AgentRunIntentEnvelopeSchema>,
  "create"
> {
  create: Omit<CreateAgentRequestMessage, "requestId">;
}

export async function parseAgentRunIntent(value: unknown): Promise<AgentRunIntent> {
  const envelope = AgentRunIntentEnvelopeSchema.parse(value);
  const { CreateAgentRequestMessageSchema } = await import("@getpaseo/protocol/messages");
  return {
    ...envelope,
    create: CreateAgentRequestMessageSchema.omit({ requestId: true }).parse(envelope.create),
  };
}
