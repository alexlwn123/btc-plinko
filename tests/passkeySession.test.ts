import { describe, expect, it } from "vitest";
import {
  PASSKEY_SESSION_STORAGE_KEY,
  clearPasskeySession,
  getSavedPasskeySession,
  isPasskeySessionToken,
  savePasskeySession,
} from "../src/passkeySession";

function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("passkey session storage", () => {
  it("saves and reads a valid session token", () => {
    const storage = createMemoryStorage();
    const sessionToken = "a".repeat(43);

    savePasskeySession(sessionToken, storage);

    expect(getSavedPasskeySession(storage)).toBe(sessionToken);
    expect(storage.getItem(PASSKEY_SESSION_STORAGE_KEY)).toBe(sessionToken);
  });

  it("ignores malformed stored values", () => {
    const storage = createMemoryStorage();
    storage.setItem(PASSKEY_SESSION_STORAGE_KEY, "not a token");

    expect(getSavedPasskeySession(storage)).toBeNull();
  });

  it("clears the saved session token", () => {
    const storage = createMemoryStorage();
    savePasskeySession("b".repeat(43), storage);

    clearPasskeySession(storage);

    expect(getSavedPasskeySession(storage)).toBeNull();
  });

  it("rejects malformed tokens before saving", () => {
    const storage = createMemoryStorage();

    expect(() => savePasskeySession("bad token", storage)).toThrow(
      "Passkey session token is malformed.",
    );
    expect(isPasskeySessionToken("bad token")).toBe(false);
  });
});
