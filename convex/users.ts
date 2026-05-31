import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, mutation, query } from "./_generated/server";
import { INITIAL_PLAYABLE_BALANCE_SATS, idempotencyKeyFor } from "./walletCore";

const RP_NAME = "BTC Plinko";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytesToBase64Url(bytes: Uint8Array) {
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triplet = (first << 16) | (second << 8) | third;

    output += BASE64URL_ALPHABET[(triplet >> 18) & 63];
    output += BASE64URL_ALPHABET[(triplet >> 12) & 63];

    if (index + 1 < bytes.length) {
      output += BASE64URL_ALPHABET[(triplet >> 6) & 63];
    }

    if (index + 2 < bytes.length) {
      output += BASE64URL_ALPHABET[triplet & 63];
    }
  }

  return output;
}

function randomBase64Url(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function copyToArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function hashSessionToken(sessionToken: string) {
  if (!SESSION_TOKEN_PATTERN.test(sessionToken)) {
    throw new Error("Session token is malformed.");
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken));
  return bytesToBase64Url(new Uint8Array(digest));
}

function getPasskeyContext(origin: string, rpId: string) {
  const url = new URL(origin);
  const isLocalhost = url.protocol === "http:" && url.hostname === "localhost";
  const isSecure = url.protocol === "https:";

  if (!isLocalhost && !isSecure) {
    throw new Error("Passkeys require HTTPS, or http://localhost for local development.");
  }

  if (url.hostname !== rpId) {
    throw new Error("Passkey relying party must match the app hostname.");
  }

  if (rpId !== "localhost" && /^\d+\.\d+\.\d+\.\d+$/.test(rpId)) {
    throw new Error("Open the local app with localhost instead of the IP address to use passkeys.");
  }

  return {
    origin: url.origin,
    rpId,
  };
}

async function createSession(ctx: MutationCtx, userId: Id<"users">, now: number) {
  const sessionToken = randomBase64Url(32);
  const tokenHash = await hashSessionToken(sessionToken);

  await ctx.db.insert("passkeySessions", {
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    tokenHash,
    userId,
  });

  return sessionToken;
}

export async function findSession(ctx: QueryCtx | MutationCtx, sessionToken: string) {
  if (!SESSION_TOKEN_PATTERN.test(sessionToken)) {
    return null;
  }

  const tokenHash = await hashSessionToken(sessionToken);
  return await ctx.db
    .query("passkeySessions")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
}

export async function requireActiveUserBySession(
  ctx: QueryCtx | MutationCtx,
  sessionToken: string,
) {
  const session = await findSession(ctx, sessionToken);
  const now = Date.now();

  if (!session || session.revokedAt || session.expiresAt < now) {
    throw new Error("Session is not active.");
  }

  const user = await ctx.db.get(session.userId);

  if (!user || user.accountState !== "active") {
    throw new Error("Account is not active.");
  }

  return user;
}

function serializeUser(user: Doc<"users">) {
  return {
    accountState: user.accountState,
    authMethod: user.authMethod ?? "passkey",
    publicId: user.publicId ?? "anonymous",
  };
}

async function requireFreshChallenge(
  ctx: MutationCtx,
  challenge: string,
  kind: "authentication" | "registration",
  now: number,
) {
  const challengeDoc = await ctx.db
    .query("passkeyChallenges")
    .withIndex("by_challenge", (q) => q.eq("challenge", challenge))
    .unique();

  if (!challengeDoc || challengeDoc.kind !== kind) {
    throw new Error("Passkey challenge was not found.");
  }

  if (challengeDoc.usedAt || challengeDoc.expiresAt < now) {
    throw new Error("Passkey challenge has expired.");
  }

  return challengeDoc;
}

export const beginPasskeyRegistration = mutation({
  args: {
    origin: v.string(),
    rpId: v.string(),
  },
  handler: async (ctx, { origin, rpId }) => {
    const context = getPasskeyContext(origin, rpId);
    const userHandle = crypto.getRandomValues(new Uint8Array(16));
    const options = await generateRegistrationOptions({
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      rpID: context.rpId,
      rpName: RP_NAME,
      timeout: 60_000,
      userDisplayName: "Anonymous Player",
      userID: userHandle,
      userName: `anonymous-${randomBase64Url(8)}`,
    });
    const now = Date.now();

    await ctx.db.insert("passkeyChallenges", {
      challenge: options.challenge,
      createdAt: now,
      expiresAt: now + CHALLENGE_TTL_MS,
      kind: "registration",
      origin: context.origin,
      rpId: context.rpId,
      userHandle: options.user.id,
    });

    return options;
  },
});

export const verifyPasskeyRegistration = mutation({
  args: {
    challenge: v.string(),
    response: v.any(),
  },
  handler: async (ctx, { challenge, response }) => {
    const now = Date.now();
    const challengeDoc = await requireFreshChallenge(ctx, challenge, "registration", now);
    const verification = await verifyRegistrationResponse({
      expectedChallenge: challengeDoc.challenge,
      expectedOrigin: challengeDoc.origin,
      expectedRPID: challengeDoc.rpId,
      requireUserVerification: true,
      response: response as RegistrationResponseJSON,
    });

    if (!verification.verified) {
      throw new Error("Passkey registration was not verified.");
    }

    const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;
    const existingCredential = await ctx.db
      .query("passkeyCredentials")
      .withIndex("by_credential_id", (q) => q.eq("credentialId", credential.id))
      .unique();

    if (existingCredential) {
      throw new Error("This passkey is already registered.");
    }

    const userId = await ctx.db.insert("users", {
      accountState: "active",
      authMethod: "passkey",
      createdAt: now,
      lastSeenAt: now,
      publicId: `anon-${randomBase64Url(5)}`,
    });
    const walletId = await ctx.db.insert("wallets", {
      availableBalance: INITIAL_PLAYABLE_BALANCE_SATS,
      createdAt: now,
      heldBalance: 0,
      unit: "sats",
      updatedAt: now,
      userId,
    });

    await ctx.db.insert("walletEvents", {
      amount: INITIAL_PLAYABLE_BALANCE_SATS,
      availableBalanceAfter: INITIAL_PLAYABLE_BALANCE_SATS,
      availableDelta: INITIAL_PLAYABLE_BALANCE_SATS,
      createdAt: now,
      heldBalanceAfter: 0,
      heldDelta: 0,
      idempotencyKey: idempotencyKeyFor("system", userId, "manual_adjustment"),
      kind: "manual_adjustment",
      sourceId: userId,
      sourceType: "system",
      status: "completed",
      userId,
      walletId,
    });

    await ctx.db.insert("passkeyCredentials", {
      backedUp: credentialBackedUp,
      counter: credential.counter,
      createdAt: now,
      credentialId: credential.id,
      deviceType: credentialDeviceType,
      publicKey: copyToArrayBuffer(credential.publicKey),
      transports: response.response?.transports ?? [],
      userId,
    });

    await ctx.db.patch(challengeDoc._id, {
      usedAt: now,
    });

    const sessionToken = await createSession(ctx, userId, now);
    const user = await ctx.db.get(userId);

    if (!user) {
      throw new Error("Registered user could not be loaded.");
    }

    return {
      sessionToken,
      user: serializeUser(user),
    };
  },
});

export const beginPasskeyAuthentication = mutation({
  args: {
    origin: v.string(),
    rpId: v.string(),
  },
  handler: async (ctx, { origin, rpId }) => {
    const context = getPasskeyContext(origin, rpId);
    const options = await generateAuthenticationOptions({
      rpID: context.rpId,
      timeout: 60_000,
      userVerification: "required",
    });
    const now = Date.now();

    await ctx.db.insert("passkeyChallenges", {
      challenge: options.challenge,
      createdAt: now,
      expiresAt: now + CHALLENGE_TTL_MS,
      kind: "authentication",
      origin: context.origin,
      rpId: context.rpId,
    });

    return options;
  },
});

export const verifyPasskeyAuthentication = mutation({
  args: {
    challenge: v.string(),
    response: v.any(),
  },
  handler: async (ctx, { challenge, response }) => {
    const now = Date.now();
    const authenticationResponse = response as AuthenticationResponseJSON;
    const challengeDoc = await requireFreshChallenge(ctx, challenge, "authentication", now);
    const credentialDoc = await ctx.db
      .query("passkeyCredentials")
      .withIndex("by_credential_id", (q) => q.eq("credentialId", authenticationResponse.id))
      .unique();

    if (!credentialDoc) {
      throw new Error("Passkey is not registered for this app.");
    }

    const verification = await verifyAuthenticationResponse({
      credential: {
        counter: credentialDoc.counter,
        id: credentialDoc.credentialId,
        publicKey: new Uint8Array(credentialDoc.publicKey),
        transports: credentialDoc.transports as AuthenticatorTransportFuture[],
      },
      expectedChallenge: challengeDoc.challenge,
      expectedOrigin: challengeDoc.origin,
      expectedRPID: challengeDoc.rpId,
      requireUserVerification: true,
      response: authenticationResponse,
    });

    if (!verification.verified) {
      throw new Error("Passkey sign-in was not verified.");
    }

    const user = await ctx.db.get(credentialDoc.userId);

    if (!user || user.accountState !== "active") {
      throw new Error("Account is not active.");
    }

    await ctx.db.patch(credentialDoc._id, {
      backedUp: verification.authenticationInfo.credentialBackedUp,
      counter: verification.authenticationInfo.newCounter,
      deviceType: verification.authenticationInfo.credentialDeviceType,
      lastUsedAt: now,
    });
    await ctx.db.patch(challengeDoc._id, {
      usedAt: now,
    });
    await ctx.db.patch(user._id, {
      lastSeenAt: now,
    });

    return {
      sessionToken: await createSession(ctx, user._id, now),
      user: serializeUser(user),
    };
  },
});

export const getSessionUser = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    const session = await findSession(ctx, sessionToken);
    const now = Date.now();

    if (!session || session.revokedAt || session.expiresAt < now) {
      return null;
    }

    const user = await ctx.db.get(session.userId);

    if (!user || user.accountState !== "active") {
      return null;
    }

    return serializeUser(user);
  },
});

export const signOutPasskey = mutation({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    const session = await findSession(ctx, sessionToken);

    if (session && !session.revokedAt) {
      await ctx.db.patch(session._id, {
        revokedAt: Date.now(),
      });
    }

    return true;
  },
});
