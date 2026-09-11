import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const session = vi.hoisted(() => ({
  profile: undefined as undefined | null | { publicId: string; accountState: string; role: string },
  queries: [] as string[],
}));

vi.mock("../src/passkeySession", () => ({
  getSavedPasskeySession: () => "expired-session-token-for-regression-test",
  clearPasskeySession: vi.fn(),
  savePasskeySession: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(reference);
    session.queries.push(name);
    if (name === "users:getSessionUser") return session.profile;
    if (!session.profile) throw new Error("Session is not active.");
    return undefined;
  },
}));

describe("app session validation", () => {
  beforeEach(() => {
    session.profile = undefined;
    session.queries = [];
  });

  it.each([undefined, null])("keeps the sign-in screen rendered with profile %s", (profile) => {
    session.profile = profile;

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("Account access");
    expect(html).toContain("Sign in");
    expect(session.queries).toEqual(["users:getSessionUser"]);
  });

  it("loads protected data after session validation succeeds", () => {
    session.profile = { publicId: "test-user", accountState: "active", role: "user" };

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("Game controls");
    expect(session.queries).toEqual([
      "users:getSessionUser",
      "cashier:getCashier",
      "plinko:getRecentRounds",
    ]);
  });
});
