export const PASSKEY_SESSION_STORAGE_KEY = "btc-plinko:passkey-session";

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

type SessionStorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function isPasskeySessionToken(value: unknown) {
  return typeof value === "string" && SESSION_TOKEN_PATTERN.test(value);
}

export function getSavedPasskeySession(storage: SessionStorageLike = globalThis.localStorage) {
  const sessionToken = storage.getItem(PASSKEY_SESSION_STORAGE_KEY);
  return isPasskeySessionToken(sessionToken) ? sessionToken : null;
}

export function savePasskeySession(
  sessionToken: string,
  storage: SessionStorageLike = globalThis.localStorage,
) {
  if (!isPasskeySessionToken(sessionToken)) {
    throw new Error("Passkey session token is malformed.");
  }

  storage.setItem(PASSKEY_SESSION_STORAGE_KEY, sessionToken);
}

export function clearPasskeySession(storage: SessionStorageLike = globalThis.localStorage) {
  storage.removeItem(PASSKEY_SESSION_STORAGE_KEY);
}
