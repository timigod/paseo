import { describe, expect, test } from "vitest";
import {
  ArchiveWorkspaceRequestSchema,
  ArchiveWorkspaceResponseMessageSchema,
  DESTRUCTIVE_CALLER_WIRE_STRING_MAX_LENGTH,
  FileExplorerRequestSchema,
  MANAGED_WORKTREE_WRITER_CONFLICT_ERROR_CODE,
  PaseoWorktreeArchiveRequestSchema,
  PaseoWorktreeArchiveResponseSchema,
  PaseoWorktreeListRequestSchema,
  parseServerInfoStatusPayload,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
} from "./messages.js";

describe("managed-worktree writer conflict compatibility", () => {
  test("preserves the conflict code on create failures", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "status",
      payload: {
        status: "agent_create_failed",
        requestId: "req-create",
        error: "The managed worktree is already in use.",
        errorCode: MANAGED_WORKTREE_WRITER_CONFLICT_ERROR_CODE,
      },
    });

    expect(parsed.payload).toMatchObject({
      errorCode: "managed_worktree_writer_conflict",
    });
  });

  test("preserves the conflict code on RPC failures", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "rpc_error",
      payload: {
        requestId: "req-resume",
        requestType: "resume_agent_request",
        error: "The managed worktree is already in use.",
        code: MANAGED_WORKTREE_WRITER_CONFLICT_ERROR_CODE,
      },
    });

    expect(parsed.payload).toMatchObject({
      code: "managed_worktree_writer_conflict",
    });
  });
});

function workspaceDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    projectId: "remote:github.com/acme/app",
    projectDisplayName: "acme/app",
    projectRootPath: "/repo/app",
    workspaceDirectory: "/repo/app",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "app",
    status: "done",
    activityAt: null,
    diffStat: null,
    scripts: [],
    ...overrides,
  };
}

function fetchWorkspacesResponse(workspace: Record<string, unknown>) {
  return {
    type: "fetch_workspaces_response",
    payload: {
      requestId: "req-1",
      entries: [workspace],
      pageInfo: {
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
      },
    },
  };
}

describe("cancel agent response compatibility", () => {
  test("accepts both legacy responses and explicit cancellation outcomes", () => {
    const legacy = SessionOutboundMessageSchema.parse({
      type: "cancel_agent_response",
      payload: {
        requestId: "req-legacy",
        agentId: "agent-1",
        agent: null,
        error: null,
      },
    });
    const explicit = SessionOutboundMessageSchema.parse({
      type: "cancel_agent_response",
      payload: {
        requestId: "req-explicit",
        agentId: "agent-1",
        agent: null,
        outcome: "not_running",
        error: null,
      },
    });

    expect(legacy.type === "cancel_agent_response" && legacy.payload.outcome).toBeUndefined();
    expect(explicit.type === "cancel_agent_response" && explicit.payload.outcome).toBe(
      "not_running",
    );
  });
});

describe("workspace descriptor message compatibility", () => {
  test("old-shaped fetch_workspaces_response without project still parses", () => {
    const parsed = SessionOutboundMessageSchema.parse(
      fetchWorkspacesResponse(workspaceDescriptor()),
    );

    expect(parsed.type).toBe("fetch_workspaces_response");
    if (parsed.type !== "fetch_workspaces_response") {
      throw new Error("Expected fetch_workspaces_response");
    }
    expect(parsed.payload.entries[0]?.project).toBeUndefined();
  });

  test("new-shaped fetch_workspaces_response with project placement parses", () => {
    const parsed = SessionOutboundMessageSchema.parse(
      fetchWorkspacesResponse(
        workspaceDescriptor({
          project: {
            projectKey: "remote:github.com/acme/app",
            projectName: "acme/app",
            checkout: {
              cwd: "/repo/app",
              isGit: true,
              currentBranch: "main",
              remoteUrl: "https://github.com/acme/app.git",
              worktreeRoot: "/repo/app",
              isPaseoOwnedWorktree: false,
              mainRepoRoot: null,
            },
          },
        }),
      ),
    );

    expect(parsed.type).toBe("fetch_workspaces_response");
    if (parsed.type !== "fetch_workspaces_response") {
      throw new Error("Expected fetch_workspaces_response");
    }
    expect(parsed.payload.entries[0]?.project).toEqual({
      projectKey: "remote:github.com/acme/app",
      projectName: "acme/app",
      checkout: {
        cwd: "/repo/app",
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/app.git",
        worktreeRoot: "/repo/app",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });
  });

  test("adding project does not narrow existing descriptor fields", () => {
    const parsed = SessionOutboundMessageSchema.parse(
      fetchWorkspacesResponse(
        workspaceDescriptor({
          workspaceDirectory: undefined,
          projectKind: "non_git",
          workspaceKind: "directory",
          gitRuntime: null,
          githubRuntime: null,
          project: {
            projectKey: "/repo/local",
            projectName: "local",
            checkout: {
              cwd: "/repo/local",
              isGit: false,
              currentBranch: null,
              remoteUrl: null,
              worktreeRoot: null,
              isPaseoOwnedWorktree: false,
              mainRepoRoot: null,
            },
          },
        }),
      ),
    );

    expect(parsed.type).toBe("fetch_workspaces_response");
    if (parsed.type !== "fetch_workspaces_response") {
      throw new Error("Expected fetch_workspaces_response");
    }
    expect(parsed.payload.entries[0]).toMatchObject({
      projectKind: "non_git",
      workspaceKind: "directory",
      workspaceDirectory: "/repo/app",
      gitRuntime: null,
      githubRuntime: null,
    });
  });
});

describe("provider usage list message contract", () => {
  test("accepts the usage list request as a namespaced correlated RPC", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "provider.usage.list.request",
      requestId: "usage-1",
    });

    expect(parsed).toEqual({
      type: "provider.usage.list.request",
      requestId: "usage-1",
    });
  });

  test("accepts new providers and new usage windows as normalized data", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "provider.usage.list.response",
      payload: {
        requestId: "usage-2",
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "glm",
            displayName: "GLM coding plan",
            status: "available",
            planLabel: "GLM coding plan",
            fetchedAt: "2026-06-19T00:00:00.000Z",
            windows: [
              {
                id: "biweekly",
                label: "Biweekly",
                usedPct: 23,
                remainingPct: 77,
                resetsAt: "2026-07-03T00:00:00.000Z",
                tone: "ok",
              },
            ],
            balances: [
              {
                id: "credits",
                label: "Credits",
                remaining: 120,
                unit: "credits",
              },
            ],
            details: [{ id: "region", label: "Region", value: "US" }],
            error: null,
          },
        ],
      },
    });

    expect(parsed.type).toBe("provider.usage.list.response");
    if (parsed.type !== "provider.usage.list.response") {
      throw new Error("Expected provider.usage.list.response");
    }
    expect(parsed.payload.providers[0]?.providerId).toBe("glm");
    expect(parsed.payload.providers[0]?.windows[0]?.label).toBe("Biweekly");
  });

  test("keeps protocol numbers strict after API boundary normalization", () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: "provider.usage.list.response",
      payload: {
        requestId: "usage-3",
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "claude",
            displayName: "Claude",
            status: "available",
            planLabel: "Max 20x",
            windows: [
              {
                id: "session",
                label: "Session",
                usedPct: "7",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("diagnostics message contract", () => {
  test("accepts the diagnostics request as a simple namespaced RPC", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "diagnostics.request",
      requestId: "diag-1",
    });

    expect(parsed).toEqual({
      type: "diagnostics.request",
      requestId: "diag-1",
    });
  });

  test("accepts a copyable diagnostics response", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "diagnostics.response",
      payload: {
        requestId: "diag-2",
        diagnostic: "Paseo diagnostics\n  Status: ok",
      },
    });

    expect(parsed.type).toBe("diagnostics.response");
    if (parsed.type !== "diagnostics.response") {
      throw new Error("Expected diagnostics.response");
    }
    expect(parsed.payload.diagnostic).toContain("Status: ok");
  });
});

describe("agent detach RPC", () => {
  test("parses the namespaced detach request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "agent.detach.request",
      agentId: "child-agent",
      requestId: "req-detach",
    });

    expect(parsed).toEqual({
      type: "agent.detach.request",
      agentId: "child-agent",
      requestId: "req-detach",
    });
  });

  test("parses the namespaced detach response", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "agent.detach.response",
      payload: {
        requestId: "req-detach",
        agentId: "child-agent",
        accepted: true,
        error: null,
      },
    });

    expect(parsed.type).toBe("agent.detach.response");
  });

  test("parses the agentDetach server feature gate", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-test",
      features: {
        agentDetach: true,
      },
    });

    if (!parsed) {
      throw new Error("Expected server info payload to parse");
    }
    expect(parsed.features?.agentDetach).toBe(true);
  });

  test("parses the workspace-targeted session import feature gate", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-test",
      features: {
        importSessionWorkspaceTarget: true,
      },
    });

    if (!parsed) {
      throw new Error("Expected server info payload to parse");
    }
    expect(parsed.features?.importSessionWorkspaceTarget).toBe(true);
  });
});

describe("agent setting action responses", () => {
  test("parses optional provider notices on mode and thinking responses", () => {
    const mode = SessionOutboundMessageSchema.parse({
      type: "set_agent_mode_response",
      payload: {
        requestId: "req-mode",
        agentId: "agent-1",
        accepted: true,
        error: null,
        notice: {
          type: "info",
          message: "This change applies next turn.",
        },
      },
    });
    const thinking = SessionOutboundMessageSchema.parse({
      type: "set_agent_thinking_response",
      payload: {
        requestId: "req-thinking",
        agentId: "agent-1",
        accepted: true,
        error: null,
      },
    });

    expect(mode.type).toBe("set_agent_mode_response");
    if (mode.type !== "set_agent_mode_response") {
      throw new Error("Expected set_agent_mode_response");
    }
    expect(mode.payload.notice).toEqual({
      type: "info",
      message: "This change applies next turn.",
    });
    expect(thinking.type).toBe("set_agent_thinking_response");
    if (thinking.type !== "set_agent_thinking_response") {
      throw new Error("Expected set_agent_thinking_response");
    }
    expect(thinking.payload.notice).toBeUndefined();
  });
});

describe("file explorer request compatibility", () => {
  test("acceptBinary is optional for old clients and accepted for new clients", () => {
    expect(
      FileExplorerRequestSchema.parse({
        type: "file_explorer_request",
        cwd: "/repo/app",
        path: "image.png",
        mode: "file",
        requestId: "req-old",
      }),
    ).toEqual({
      type: "file_explorer_request",
      cwd: "/repo/app",
      path: "image.png",
      mode: "file",
      requestId: "req-old",
    });

    expect(
      FileExplorerRequestSchema.parse({
        type: "file_explorer_request",
        cwd: "/repo/app",
        path: "image.png",
        mode: "file",
        requestId: "req-new",
        acceptBinary: true,
      }),
    ).toMatchObject({
      type: "file_explorer_request",
      requestId: "req-new",
      acceptBinary: true,
    });
  });
});

describe("paseo worktree archive request compatibility", () => {
  test("omitted scope defaults to workspace", () => {
    const parsed = PaseoWorktreeArchiveRequestSchema.parse({
      type: "paseo_worktree_archive_request",
      worktreePath: "/repo/app",
      requestId: "req-old-scope",
    });
    expect(parsed.scope).toBe("workspace");
  });

  test("scope worktree parses", () => {
    const parsed = PaseoWorktreeArchiveRequestSchema.parse({
      type: "paseo_worktree_archive_request",
      worktreePath: "/repo/app",
      scope: "worktree",
      requestId: "req-worktree-scope",
    });
    expect(parsed.scope).toBe("worktree");
  });

  test("unknown extra field is still accepted", () => {
    const parsed = PaseoWorktreeArchiveRequestSchema.parse({
      type: "paseo_worktree_archive_request",
      worktreePath: "/repo/app",
      requestId: "req-extra",
      extraField: "ignored",
    });
    expect(parsed).not.toHaveProperty("extraField");
    expect(parsed.scope).toBe("workspace");
  });

  test("deprecated per-action caller fields remain parse compatible", () => {
    expect(
      PaseoWorktreeArchiveRequestSchema.parse({
        type: "paseo_worktree_archive_request",
        worktreePath: "/repo/app",
        requestId: "req-old-caller",
      }),
    ).not.toHaveProperty("callerAgentId");

    expect(
      PaseoWorktreeArchiveRequestSchema.parse({
        type: "paseo_worktree_archive_request",
        worktreePath: "/repo/app",
        callerAgentId: "agent-1",
        callerAgentProof: "proof-1",
        requestId: "req-new-caller",
      }),
    ).toMatchObject({ callerAgentId: "agent-1", callerAgentProof: "proof-1" });
  });
});

describe("archive caller protocol compatibility", () => {
  test("parses the agent archive caller feature gate", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-test",
      features: { agentArchiveCaller: true },
    });

    expect(parsed?.features?.agentArchiveCaller).toBe(true);
  });

  test("workspace archive accepts old and deprecated per-action fields", () => {
    expect(
      ArchiveWorkspaceRequestSchema.parse({
        type: "archive_workspace_request",
        workspaceId: "workspace-1",
        requestId: "req-old",
      }),
    ).not.toHaveProperty("callerAgentId");

    expect(
      ArchiveWorkspaceRequestSchema.parse({
        type: "archive_workspace_request",
        workspaceId: "workspace-1",
        callerAgentId: "agent-1",
        callerAgentProof: "proof-1",
        requestId: "req-new",
      }),
    ).toMatchObject({ callerAgentId: "agent-1", callerAgentProof: "proof-1" });
  });

  test("bounds deprecated per-action caller strings", () => {
    const bounded = "x".repeat(DESTRUCTIVE_CALLER_WIRE_STRING_MAX_LENGTH);
    const oversized = `${bounded}x`;
    const worktreeBase = {
      type: "paseo_worktree_archive_request" as const,
      worktreePath: "/repo/app",
      requestId: "req-bounded",
    };
    const workspaceBase = {
      type: "archive_workspace_request" as const,
      workspaceId: "workspace-1",
      requestId: "req-bounded",
    };

    expect(
      PaseoWorktreeArchiveRequestSchema.safeParse({
        ...worktreeBase,
        callerAgentId: bounded,
        callerAgentProof: bounded,
      }).success,
    ).toBe(true);
    expect(
      PaseoWorktreeArchiveRequestSchema.safeParse({
        ...worktreeBase,
        callerAgentId: oversized,
      }).success,
    ).toBe(false);
    expect(
      PaseoWorktreeArchiveRequestSchema.safeParse({
        ...worktreeBase,
        callerAgentProof: oversized,
      }).success,
    ).toBe(false);
    expect(
      ArchiveWorkspaceRequestSchema.safeParse({
        ...workspaceBase,
        callerAgentId: bounded,
        callerAgentProof: bounded,
      }).success,
    ).toBe(true);
    expect(
      ArchiveWorkspaceRequestSchema.safeParse({
        ...workspaceBase,
        callerAgentId: oversized,
      }).success,
    ).toBe(false);
    expect(
      ArchiveWorkspaceRequestSchema.safeParse({
        ...workspaceBase,
        callerAgentProof: oversized,
      }).success,
    ).toBe(false);
  });

  test("archive responses accept old payloads and preserve typed error codes", () => {
    expect(
      ArchiveWorkspaceResponseMessageSchema.parse({
        type: "archive_workspace_response",
        payload: {
          requestId: "req-old-workspace",
          workspaceId: "workspace-1",
          archivedAt: null,
          error: "failed",
        },
      }).payload,
    ).not.toHaveProperty("errorCode");
    expect(
      ArchiveWorkspaceResponseMessageSchema.parse({
        type: "archive_workspace_response",
        payload: {
          requestId: "req-new-workspace",
          workspaceId: "workspace-1",
          archivedAt: null,
          error: "blocked",
          errorCode: "SELF_ARCHIVE_BLOCKED",
        },
      }).payload.errorCode,
    ).toBe("SELF_ARCHIVE_BLOCKED");

    expect(
      PaseoWorktreeArchiveResponseSchema.parse({
        type: "paseo_worktree_archive_response",
        payload: {
          success: false,
          error: { code: "UNKNOWN", message: "failed" },
          requestId: "req-old-worktree",
        },
      }).payload,
    ).not.toHaveProperty("errorCode");
    expect(
      PaseoWorktreeArchiveResponseSchema.parse({
        type: "paseo_worktree_archive_response",
        payload: {
          success: false,
          error: { code: "UNKNOWN", message: "blocked" },
          errorCode: "SELF_ARCHIVE_BLOCKED",
          requestId: "req-new-worktree",
        },
      }).payload.errorCode,
    ).toBe("SELF_ARCHIVE_BLOCKED");
  });
});

describe("destructive caller hello compatibility", () => {
  const baseHello = {
    type: "hello" as const,
    clientId: "client-1",
    clientType: "cli" as const,
    protocolVersion: 1,
  };

  test("accepts a complete current agent incarnation", () => {
    expect(
      WSHelloMessageSchema.parse({
        ...baseHello,
        callerAgent: { agentId: "agent-1", incarnation: "incarnation-1" },
      }),
    ).toMatchObject({
      callerAgent: { agentId: "agent-1", incarnation: "incarnation-1" },
    });
  });

  test("keeps missing and partial legacy identities parseable for fail-closed handling", () => {
    expect(WSHelloMessageSchema.parse(baseHello)).not.toHaveProperty("callerAgent");
    expect(
      WSHelloMessageSchema.parse({ ...baseHello, callerAgent: { agentId: "agent-1" } }),
    ).toMatchObject({ callerAgent: { agentId: "agent-1" } });
  });

  test("bounds complete and partial caller identities", () => {
    const bounded = "x".repeat(DESTRUCTIVE_CALLER_WIRE_STRING_MAX_LENGTH);
    const oversized = `${bounded}x`;

    expect(
      WSHelloMessageSchema.safeParse({
        ...baseHello,
        callerAgent: { agentId: bounded, incarnation: bounded },
      }).success,
    ).toBe(true);
    expect(
      WSHelloMessageSchema.safeParse({
        ...baseHello,
        callerAgent: { agentId: oversized },
      }).success,
    ).toBe(false);
    expect(
      WSHelloMessageSchema.safeParse({
        ...baseHello,
        callerAgent: { incarnation: oversized },
      }).success,
    ).toBe(false);
  });
});

describe("paseo worktree list request compatibility", () => {
  const legacyRequestSchema = PaseoWorktreeListRequestSchema.omit({
    allRegisteredProjects: true,
  });

  test("old CLI and old daemon retain the unscoped legacy request shape", () => {
    const parsed = legacyRequestSchema.parse({
      type: "paseo_worktree_list_request",
      requestId: "req-old-cli-old-daemon",
    });

    expect(parsed).toEqual({
      type: "paseo_worktree_list_request",
      requestId: "req-old-cli-old-daemon",
    });
  });

  test("old daemon strips the new global inventory flag and returns its explicit error", () => {
    const request = legacyRequestSchema.parse({
      type: "paseo_worktree_list_request",
      allRegisteredProjects: true,
      requestId: "req-new-cli-old-daemon",
    });
    const response = SessionOutboundMessageSchema.parse({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: [],
        error: { code: "UNKNOWN", message: "cwd or repoRoot is required" },
        requestId: "req-new-cli-old-daemon",
      },
    });

    expect(request).toEqual({
      type: "paseo_worktree_list_request",
      requestId: "req-new-cli-old-daemon",
    });
    expect(response).toEqual({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: [],
        error: { code: "UNKNOWN", message: "cwd or repoRoot is required" },
        requestId: "req-new-cli-old-daemon",
      },
    });
  });

  test("new daemon preserves the explicit global inventory flag", () => {
    const parsed = PaseoWorktreeListRequestSchema.parse({
      type: "paseo_worktree_list_request",
      allRegisteredProjects: true,
      requestId: "req-new-cli-new-daemon",
    });

    expect(parsed).toEqual({
      type: "paseo_worktree_list_request",
      allRegisteredProjects: true,
      requestId: "req-new-cli-new-daemon",
    });
  });
});

describe("daemon update messages", () => {
  test("daemon update progress is a scoped outbound message", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "daemon.update.progress",
      payload: {
        requestId: "update-1",
        phase: "installing",
      },
    });

    expect(parsed).toEqual({
      type: "daemon.update.progress",
      payload: {
        requestId: "update-1",
        phase: "installing",
      },
    });
  });
});

describe("viewed timeline subscription messages", () => {
  test("parses a complete viewed-agent set and its acknowledgement", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "agent.timeline.set_subscription.request",
      agentIds: ["agent-a", "agent-b"],
      requestId: "timeline-subscription-1",
    });
    const response = SessionOutboundMessageSchema.parse({
      type: "agent.timeline.set_subscription.response",
      payload: {
        agentIds: ["agent-a", "agent-b"],
        requestId: "timeline-subscription-1",
      },
    });

    expect({ request, response }).toEqual({
      request: {
        type: "agent.timeline.set_subscription.request",
        agentIds: ["agent-a", "agent-b"],
        requestId: "timeline-subscription-1",
      },
      response: {
        type: "agent.timeline.set_subscription.response",
        payload: {
          agentIds: ["agent-a", "agent-b"],
          requestId: "timeline-subscription-1",
        },
      },
    });
  });
});
