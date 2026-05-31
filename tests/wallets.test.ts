import { describe, expect, it } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { INITIAL_PLAYABLE_BALANCE_SATS } from "../convex/walletCore";
import {
  captureWithdrawalForUser,
  creditDepositForUser,
  ensureWalletForUser,
  releaseWithdrawalForUser,
  reserveWithdrawalForUser,
} from "../convex/wallets";

type StoredDoc = {
  _creationTime: number;
  _id: string;
  [key: string]: unknown;
};

type Filter = {
  field: string;
  value: unknown;
};

type IndexFilter = {
  eq: (field: string, value: unknown) => IndexFilter;
};

function createDbMock() {
  const tables = new Map<string, Map<string, StoredDoc>>();
  let nextId = 1;

  function table(tableName: string) {
    let current = tables.get(tableName);

    if (!current) {
      current = new Map<string, StoredDoc>();
      tables.set(tableName, current);
    }

    return current;
  }

  function rows(tableName: string) {
    return [...table(tableName).values()];
  }

  function query(tableName: string) {
    const filters: Filter[] = [];
    let order: "asc" | "desc" = "asc";

    function select() {
      const selected = rows(tableName)
        .filter((doc) => filters.every((filter) => Object.is(doc[filter.field], filter.value)))
        .sort((left, right) => {
          const leftSort = typeof left.createdAt === "number" ? left.createdAt : left._creationTime;
          const rightSort =
            typeof right.createdAt === "number" ? right.createdAt : right._creationTime;
          return leftSort - rightSort;
        });

      return order === "desc" ? selected.reverse() : selected;
    }

    const builder = {
      order(nextOrder: "asc" | "desc") {
        order = nextOrder;
        return builder;
      },
      take(limit: number) {
        return Promise.resolve(select().slice(0, limit));
      },
      unique() {
        const selected = select();

        if (selected.length > 1) {
          throw new Error(`Expected unique ${tableName} result, found ${selected.length}.`);
        }

        return Promise.resolve(selected[0] ?? null);
      },
      withIndex(_indexName: string, collectFilters: (q: IndexFilter) => unknown) {
        const indexFilter: IndexFilter = {
          eq(field, value) {
            filters.push({ field, value });
            return indexFilter;
          },
        };

        collectFilters(indexFilter);
        return builder;
      },
    };

    return builder;
  }

  return {
    ctx: {
      db: {
        get(id: string) {
          const tableName = id.split(":")[0];
          return Promise.resolve(table(tableName).get(id) ?? null);
        },
        insert(tableName: string, value: Record<string, unknown>) {
          const id = `${tableName}:${nextId++}`;
          table(tableName).set(id, {
            ...value,
            _creationTime: nextId,
            _id: id,
          });

          return Promise.resolve(id);
        },
        patch(id: string, patch: Record<string, unknown>) {
          const tableName = id.split(":")[0];
          const existing = table(tableName).get(id);

          if (!existing) {
            throw new Error(`Cannot patch missing document ${id}.`);
          }

          Object.assign(existing, patch);
          return Promise.resolve();
        },
        query,
      },
    },
    rows,
  };
}

const userId = "users:test-user" as Id<"users">;

function mutationCtx(db: ReturnType<typeof createDbMock>) {
  return db.ctx as unknown as MutationCtx;
}

describe("wallet mutations", () => {
  it("creates a wallet and initial event exactly once", async () => {
    const db = createDbMock();

    const wallet = await ensureWalletForUser(mutationCtx(db), userId, 100);
    const sameWallet = await ensureWalletForUser(mutationCtx(db), userId, 200);

    expect(sameWallet._id).toBe(wallet._id);
    expect(db.rows("wallets")).toHaveLength(1);
    expect(db.rows("walletEvents")).toMatchObject([
      {
        amount: INITIAL_PLAYABLE_BALANCE_SATS,
        availableBalanceAfter: INITIAL_PLAYABLE_BALANCE_SATS,
        heldBalanceAfter: 0,
        kind: "manual_adjustment",
        status: "completed",
      },
    ]);
  });

  it("credits a deposit once even when retried with a different idempotency key", async () => {
    const db = createDbMock();

    const first = await creditDepositForUser(mutationCtx(db), {
      amount: 500,
      depositId: "deposit-1",
      idempotencyKey: "deposit-1:first-attempt",
      userId,
    });
    const second = await creditDepositForUser(mutationCtx(db), {
      amount: 500,
      depositId: "deposit-1",
      idempotencyKey: "deposit-1:second-attempt",
      userId,
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    expect(first.wallet).toMatchObject({
      availableBalance: INITIAL_PLAYABLE_BALANCE_SATS + 500,
      heldBalance: 0,
      unit: "sats",
    });
    expect(db.rows("walletEvents").filter((event) => event.kind === "deposit_credit")).toHaveLength(
      1,
    );
    expect(db.rows("wallets")[0]).toMatchObject({
      availableBalance: INITIAL_PLAYABLE_BALANCE_SATS + 500,
      heldBalance: 0,
    });
  });

  it("holds withdrawal funds and captures the hold once", async () => {
    const db = createDbMock();

    const hold = await reserveWithdrawalForUser(mutationCtx(db), {
      amount: 300,
      idempotencyKey: "withdrawal-1:hold",
      userId,
      withdrawalId: "withdrawal-1",
    });
    const duplicateHold = await reserveWithdrawalForUser(mutationCtx(db), {
      amount: 300,
      idempotencyKey: "withdrawal-1:hold-retry",
      userId,
      withdrawalId: "withdrawal-1",
    });
    const capture = await captureWithdrawalForUser(mutationCtx(db), {
      idempotencyKey: "withdrawal-1:capture",
      userId,
      withdrawalId: "withdrawal-1",
    });

    expect(hold.duplicate).toBe(false);
    expect(duplicateHold.duplicate).toBe(true);
    expect(capture.duplicate).toBe(false);
    expect(db.rows("wallets")[0]).toMatchObject({
      availableBalance: INITIAL_PLAYABLE_BALANCE_SATS - 300,
      heldBalance: 0,
    });
    expect(db.rows("walletEvents").map((event) => event.kind)).toEqual([
      "manual_adjustment",
      "withdrawal_hold",
      "withdrawal_capture",
    ]);
    await expect(
      releaseWithdrawalForUser(mutationCtx(db), {
        idempotencyKey: "withdrawal-1:release",
        userId,
        withdrawalId: "withdrawal-1",
      }),
    ).rejects.toThrow("Withdrawal has already been captured.");
  });

  it("releases withdrawal holds when a withdrawal fails", async () => {
    const db = createDbMock();

    await reserveWithdrawalForUser(mutationCtx(db), {
      amount: 300,
      idempotencyKey: "withdrawal-2:hold",
      userId,
      withdrawalId: "withdrawal-2",
    });
    const release = await releaseWithdrawalForUser(mutationCtx(db), {
      idempotencyKey: "withdrawal-2:release",
      status: "failed",
      userId,
      withdrawalId: "withdrawal-2",
    });

    expect(release.duplicate).toBe(false);
    expect(db.rows("wallets")[0]).toMatchObject({
      availableBalance: INITIAL_PLAYABLE_BALANCE_SATS,
      heldBalance: 0,
    });
    expect(db.rows("walletEvents").at(-1)).toMatchObject({
      kind: "withdrawal_release",
      status: "failed",
    });
    await expect(
      captureWithdrawalForUser(mutationCtx(db), {
        idempotencyKey: "withdrawal-2:capture",
        userId,
        withdrawalId: "withdrawal-2",
      }),
    ).rejects.toThrow("Withdrawal has already been released.");
  });

  it("rejects withdrawal holds that exceed the available balance", async () => {
    const db = createDbMock();

    await expect(
      reserveWithdrawalForUser(mutationCtx(db), {
        amount: INITIAL_PLAYABLE_BALANCE_SATS + 1,
        idempotencyKey: "withdrawal-3:hold",
        userId,
        withdrawalId: "withdrawal-3",
      }),
    ).rejects.toThrow("Wallet amounts must be non-negative safe integers in sats.");
    expect(db.rows("wallets")[0]).toMatchObject({
      availableBalance: INITIAL_PLAYABLE_BALANCE_SATS,
      heldBalance: 0,
    });
    expect(
      db.rows("walletEvents").filter((event) => event.kind === "withdrawal_hold"),
    ).toHaveLength(0);
  });
});
