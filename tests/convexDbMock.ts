import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";

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

export const testUserId = "users:test-user" as Id<"users">;

export function createDbMock() {
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

export function mutationCtx(db: ReturnType<typeof createDbMock>) {
  return db.ctx as unknown as MutationCtx;
}
