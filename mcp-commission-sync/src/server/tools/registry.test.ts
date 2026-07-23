import { describe, expect, it, vi, beforeEach } from "vitest";
import type { UserSession } from "../../auth/context.js";

const insurerGetMock = vi.fn();
const backendStatusMock = vi.fn<(err: unknown) => number | undefined>(() => undefined);

vi.mock("../../backend/client.js", () => ({
  createBackendClient: () => ({
    get: insurerGetMock,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }),
  backendStatus: (err: unknown) => backendStatusMock(err),
  describeBackendError: (err: unknown) => (err instanceof Error ? err.message : "Unknown backend error."),
  unwrapEnvelope: (raw: unknown) => ({ data: (raw as { data: unknown })?.data }),
}));

const { sessionContext } = await import("../../auth/context.js");
const { PERMISSIONS } = await import("./permissions.js");
const { assertPermission, assertPermissionAndTenant, getToolsForSession } = await import("./registry.js");

function makeSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    tenantId: "tenant_1",
    userId: "user_1",
    roles: ["broker"],
    permissions: [],
    accessToken: "test-token",
    ...overrides,
  };
}

const FULL_ACCESS_SESSION = makeSession({
  permissions: [
    PERMISSIONS.INSURER_VIEW,
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.PLANS_VIEW,
    PERMISSIONS.SCHEDULES_VIEW,
    PERMISSIONS.SCHEDULES_CREATE,
    PERMISSIONS.SCHEDULES_UPDATE,
    PERMISSIONS.SCHEDULES_DELETE,
  ],
});

// A broker who can only view - the "restricted" negative-permission case
// this test suite specifically exists to cover (see plan Task 4).
const VIEW_ONLY_SESSION = makeSession({
  permissions: [PERMISSIONS.INSURER_VIEW, PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PLANS_VIEW, PERMISSIONS.SCHEDULES_VIEW],
});

const WRITE_TOOL_NAMES = [
  "diff_commission_schedule_change",
  "create_change_request",
  "apply_change_request",
  "reject_change_request",
  "activate_schedule_version",
  "deactivate_commission_schedule",
];

beforeEach(() => {
  insurerGetMock.mockReset();
  insurerGetMock.mockResolvedValue({ status: 200, data: { data: { id: "ins_1" } } });
  backendStatusMock.mockReset();
  backendStatusMock.mockReturnValue(undefined);
});

describe("getToolsForSession (dynamic tool filtering)", () => {
  it("returns every tool for a full-access session", async () => {
    const tools = await getToolsForSession(FULL_ACCESS_SESSION);
    const names = tools.map((t) => t.name);
    for (const writeName of WRITE_TOOL_NAMES) {
      expect(names).toContain(writeName);
    }
    expect(names).toContain("list_commission_schedules");
  });

  it("excludes every write/apply tool for a view-only session, but keeps read tools", async () => {
    const tools = await getToolsForSession(VIEW_ONLY_SESSION);
    const names = tools.map((t) => t.name);

    for (const writeName of WRITE_TOOL_NAMES) {
      expect(names).not.toContain(writeName);
    }
    expect(names).toContain("list_commission_schedules");
    expect(names).toContain("get_commission_schedule");
    expect(names).toContain("list_change_requests");
  });
});

describe("assertPermission (double-layer guard, layer 1: direct call)", () => {
  it("returns the session when the caller has one of the required permissions", () => {
    sessionContext.run(FULL_ACCESS_SESSION, () => {
      const session = assertPermission("apply_change_request", [PERMISSIONS.SCHEDULES_CREATE, PERMISSIONS.SCHEDULES_UPDATE]);
      expect(session.tenantId).toBe("tenant_1");
    });
  });

  it("throws for a restricted session even when called directly, bypassing tools/list filtering", () => {
    sessionContext.run(VIEW_ONLY_SESSION, () => {
      expect(() =>
        assertPermission("apply_change_request", [PERMISSIONS.SCHEDULES_CREATE, PERMISSIONS.SCHEDULES_UPDATE])
      ).toThrow(/not authorized/i);
    });
  });

  it("throws when called outside any session context", () => {
    expect(() => assertPermission("apply_change_request", [PERMISSIONS.SCHEDULES_CREATE])).toThrow(
      /No active session context/
    );
  });
});

describe("assertPermissionAndTenant (double-layer guard, layer 2: tenant-scoped resource check)", () => {
  it("fails closed on the permission check before ever calling the backend", async () => {
    await sessionContext.run(VIEW_ONLY_SESSION, async () => {
      await expect(
        assertPermissionAndTenant("diff_commission_schedule_change", [PERMISSIONS.SCHEDULES_CREATE], {
          insurerIds: ["ins_1"],
        })
      ).rejects.toThrow(/not authorized/i);
    });
    expect(insurerGetMock).not.toHaveBeenCalled();
  });

  it("verifies each insurerId against the backend for an authorized caller", async () => {
    await sessionContext.run(FULL_ACCESS_SESSION, async () => {
      await assertPermissionAndTenant("diff_commission_schedule_change", [PERMISSIONS.SCHEDULES_CREATE], {
        insurerIds: ["ins_1", "ins_2"],
      });
    });
    expect(insurerGetMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the backend says an insurerId is not accessible (403/404)", async () => {
    insurerGetMock.mockRejectedValue(Object.assign(new Error("Backend responded 404"), { status: 404 }));
    backendStatusMock.mockReturnValue(404);

    await sessionContext.run(FULL_ACCESS_SESSION, async () => {
      await expect(
        assertPermissionAndTenant("diff_commission_schedule_change", [PERMISSIONS.SCHEDULES_CREATE], {
          insurerIds: ["ins_missing"],
        })
      ).rejects.toThrow(/not accessible for tenant/i);
    });
  });
});
