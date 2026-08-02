import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AgentCallerIdentity } from "./destructive-action-authority.js";

const AGENT_CAPABILITY_PREFIX = "paseo.agent.v1";
const MAX_CAPABILITY_LENGTH = 4096;

export type IngressPrincipal =
  | { readonly kind: "coordinator" }
  | { readonly kind: "agent"; readonly identity: AgentCallerIdentity };

export class AgentIngressCapabilityAuthority {
  private readonly signingKey: Buffer;

  constructor(
    private readonly coordinatorToken: string,
    signingKey: Buffer = randomBytes(32),
  ) {
    this.signingKey = Buffer.from(signingKey);
  }

  issueAgentToken(identity: AgentCallerIdentity): string {
    const payload = Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
    const signature = this.sign(payload);
    return `${AGENT_CAPABILITY_PREFIX}.${payload}.${signature}`;
  }

  resolve(token: string | null): IngressPrincipal | null {
    if (!token || token.length > MAX_CAPABILITY_LENGTH) {
      return null;
    }
    if (constantTimeEqual(token, this.coordinatorToken)) {
      return Object.freeze({ kind: "coordinator" });
    }

    const prefix = `${AGENT_CAPABILITY_PREFIX}.`;
    if (!token.startsWith(prefix)) {
      return null;
    }
    const parts = token.slice(prefix.length).split(".");
    if (parts.length !== 2) {
      return null;
    }
    const [payload, providedSignature] = parts;
    if (
      !payload ||
      !providedSignature ||
      !constantTimeEqual(providedSignature, this.sign(payload))
    ) {
      return null;
    }

    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        agentId?: unknown;
        incarnation?: unknown;
      };
      if (
        typeof parsed.agentId !== "string" ||
        parsed.agentId.length === 0 ||
        typeof parsed.incarnation !== "string" ||
        parsed.incarnation.length === 0
      ) {
        return null;
      }
      return Object.freeze({
        kind: "agent",
        identity: Object.freeze({ agentId: parsed.agentId, incarnation: parsed.incarnation }),
      });
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey).update(payload).digest("base64url");
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
