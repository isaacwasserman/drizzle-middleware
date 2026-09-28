// End-to-end behavior on PGlite.
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { defineRelations, eq, sql } from "drizzle-orm-beta";
import { integer, pgTable, serial, text } from "drizzle-orm-beta/pg-core";
import { drizzle } from "drizzle-orm-beta/pglite";
import { withMiddleware } from "../src/pg.ts";

const users = pgTable("users", {
	id: serial("id").primaryKey(),
	name: text("name").notNull(),
});

const kvStore = pgTable("kv", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

const orders = pgTable("orders", {
	id: serial("id").primaryKey(),
	userId: integer("user_id").notNull(),
});

async function createTestDb() {
	const client = new PGlite();
	const db = drizzle({ client });
	await db.execute(
		sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`,
	);
	await db.execute(
		sql`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	);
	return db;
}

describe("e2e: pglite middleware", () => {
	test("before and after run around the query, in order, in one transaction", async () => {
		const db = await createTestDb();
		const wrapped = withMiddleware(db, () => ({
			before: [sql`INSERT INTO kv (key, value) VALUES ('before', ${"acme"})`],
			after: [sql`INSERT INTO kv (key, value) VALUES ('after', 'done')`],
		}));

		// The query sees the `before` row, and not yet the `after` row.
		expect(await wrapped.select({ key: kvStore.key }).from(kvStore)).toEqual([
			{ key: "before" },
		]);
		expect(await db.select().from(kvStore).orderBy(kvStore.key)).toEqual([
			{ key: "after", value: "done" },
			{ key: "before", value: "acme" },
		]);

		// A failing statement rolls back the whole unit: the query's insert and
		// the `before` row are not kept.
		const failing = withMiddleware(db, () => ({
			before: [sql`INSERT INTO kv (key, value) VALUES ('rolled back', 'x')`],
			after: [sql`INSERT INTO kv (key, value) VALUES ('bad', NULL)`],
		}));
		await expect(
			Promise.resolve(failing.insert(users).values({ name: "Bob" })),
		).rejects.toThrow();
		expect(await db.select().from(users)).toEqual([]);
		expect(await db.select().from(kvStore)).toHaveLength(2);
	});

	test("insert, update and delete run with middleware and return their results", async () => {
		const db = await createTestDb();
		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('op', 'x') ON CONFLICT(key) DO NOTHING`,
			],
		}));

		expect(
			await wrapped.insert(users).values({ name: "Frank" }).returning(),
		).toEqual([{ id: 1, name: "Frank" }]);
		await wrapped.update(users).set({ name: "Gwen" }).where(eq(users.id, 1));
		expect(await db.select().from(users)).toEqual([{ id: 1, name: "Gwen" }]);
		await wrapped.delete(users).where(eq(users.id, 1));
		expect(await db.select().from(users)).toEqual([]);
	});

	test("db.transaction runs before and after once, around the whole transaction", async () => {
		const db = await createTestDb();

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('phase', 'before') ON CONFLICT(key) DO UPDATE SET value = 'before'`,
			],
			after: [sql`UPDATE kv SET value = 'after' WHERE key = 'phase'`],
		}));

		await wrapped.transaction(async (tx) => {
			await tx.insert(users).values({ name: "Ivy" });
			await tx.insert(users).values({ name: "Jack" });
		});

		const userRows = await db.select().from(users);
		expect(userRows).toHaveLength(2);

		const kvRows = await db.select().from(kvStore);
		expect(kvRows).toEqual([{ key: "phase", value: "after" }]);
	});

	test("transaction-local state from before is visible to the query", async () => {
		const db = await createTestDb();
		await db.insert(users).values({ name: "Leo" });

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT set_config('app.tenant', 'acme', true)`],
		}));

		const rows = await wrapped
			.select({
				name: users.name,
				tenant: sql<string>`current_setting('app.tenant')`,
			})
			.from(users);

		expect(rows).toEqual([{ name: "Leo", tenant: "acme" }]);
	});

	test("a join with duplicate column names maps both columns", async () => {
		const db = await createTestDb();
		await db.execute(
			sql`CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL)`,
		);
		await db.insert(users).values({ name: "Nia" });
		await db.insert(orders).values({ userId: 1 });

		// Both tables have an `id` column; neither may be lost in the result.
		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT set_config('app.x', '1', true)`],
		}));

		const rows = await wrapped
			.select()
			.from(users)
			.innerJoin(orders, eq(orders.userId, users.id));

		expect(rows).toEqual([
			{
				users: { id: 1, name: "Nia" },
				orders: { id: 1, userId: 1 },
			},
		]);
	});

	test("stacked layers each run once, and the query sees both", async () => {
		const db = await createTestDb();
		await db.insert(users).values({ name: "Mia" });

		let innerCalls = 0;
		let outerCalls = 0;

		const inner = withMiddleware(db, () => {
			innerCalls++;
			return {
				before: [sql`SELECT set_config('app.inner', 'i', true)`],
				after: [
					sql`INSERT INTO kv (key, value) VALUES ('inner_after', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`,
				],
			};
		});
		const outer = withMiddleware(inner, () => {
			outerCalls++;
			return {
				before: [sql`SELECT set_config('app.outer', 'o', true)`],
				after: [
					sql`INSERT INTO kv (key, value) VALUES ('outer_after', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`,
				],
			};
		});

		// Both before-layers are visible to the main query (neither is bypassed).
		const rows = await outer
			.select({
				name: users.name,
				ctx: sql<string>`current_setting('app.inner') || '/' || current_setting('app.outer')`,
			})
			.from(users);
		expect(rows).toEqual([{ name: "Mia", ctx: "i/o" }]);

		// Each factory runs exactly once for the single query.
		expect(innerCalls).toBe(1);
		expect(outerCalls).toBe(1);

		// Both after-layers ran too.
		expect(await db.select().from(kvStore).orderBy(kvStore.key)).toEqual([
			{ key: "inner_after", value: "1" },
			{ key: "outer_after", value: "1" },
		]);
	});
});

describe("e2e: pglite fail-closed guard", () => {
	const posts = pgTable("posts", {
		id: serial("id").primaryKey(),
		userId: integer("user_id").notNull(),
	});
	const relations = defineRelations({ users, posts }, (r) => ({
		users: { posts: r.many.posts({ from: r.users.id, to: r.posts.userId }) },
	}));

	async function createRelationalDb() {
		const client = new PGlite();
		const db = drizzle({ client, relations, schema: { users, posts } });
		await db.execute(
			sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`,
		);
		await db.execute(
			sql`CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL)`,
		);
		await db.execute(sql`CREATE TABLE mw_log (n SERIAL)`);
		await db.insert(users).values({ name: "Ada" });
		await db.insert(posts).values({ userId: 1 });
		return db;
	}

	async function middlewareRuns(
		db: Awaited<ReturnType<typeof createRelationalDb>>,
	) {
		const result = await db.execute<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM mw_log`,
		);
		return result.rows[0]?.n;
	}

	test("blocks direct driver access through the wrapped session", async () => {
		const db = await createRelationalDb();
		const wrapped = withMiddleware(db, () => ({}));
		const session = (wrapped as any).session;

		expect(() => session.client).toThrow("blocked access to `client`");
		expect(() => Object.getOwnPropertyDescriptor(session, "client")).toThrow(
			"blocked access to `client`",
		);
	});

	test("every supported query API still runs the middleware", async () => {
		const db = await createRelationalDb();
		const wrapped = withMiddleware(db, () => ({
			before: [sql`INSERT INTO mw_log DEFAULT VALUES`],
		}));

		expect(
			await wrapped.query.users.findMany({ with: { posts: true } }),
		).toEqual([{ id: 1, name: "Ada", posts: [{ id: 1, userId: 1 }] }]);
		expect(await wrapped.query.users.findFirst()).toEqual({
			id: 1,
			name: "Ada",
		});
		expect(await (wrapped as any)._query.users.findMany()).toEqual([
			{ id: 1, name: "Ada" },
		]);
		const prepared = wrapped
			.select()
			.from(users)
			.where(eq(users.id, sql.placeholder("id")))
			.prepare("guard_select");
		expect(await prepared.execute({ id: 1 })).toEqual([{ id: 1, name: "Ada" }]);
		expect(await wrapped.$count(users)).toBe(1);
		await wrapped.execute(sql`SELECT 1`);
		expect(await middlewareRuns(db)).toBe(6);

		// A transaction runs the middleware once, at its boundary.
		await wrapped.transaction(async (tx) => {
			await tx.query.users.findMany();
			await tx.transaction(async (nested) => {
				await nested.select().from(users);
			});
		});
		expect(await middlewareRuns(db)).toBe(7);
	});

	test("a rolled-back savepoint does not undo the transaction's before", async () => {
		const db = await createTestDb();
		const wrapped = withMiddleware(db, () => ({
			before: [sql`select set_config('app.tenant', 'acme', true)`],
		}));
		const tenant = async (q: Pick<typeof db, "execute">) =>
			(
				await q.execute<{ t: string }>(
					sql`select current_setting('app.tenant', true) as t`,
				)
			).rows[0]?.t;
		await wrapped.transaction(async (tx) => {
			await expect(
				tx.transaction(async (savepoint) => {
					expect(await tenant(savepoint)).toBe("acme");
					throw new Error("roll back the savepoint");
				}),
			).rejects.toThrow("roll back the savepoint");
			expect(await tenant(tx)).toBe("acme");
		});
	});

	test("nested transaction on a wrapped transaction runs the middleware", async () => {
		const db = await createRelationalDb();

		await db.transaction(async (tx) => {
			const inner = withMiddleware(tx, () => ({
				before: [sql`INSERT INTO mw_log DEFAULT VALUES`],
			}));
			const outer = withMiddleware(inner, () => ({
				before: [sql`INSERT INTO mw_log DEFAULT VALUES`],
			}));
			await outer.transaction(async (savepoint) => {
				await savepoint.insert(users).values({ name: "Kept" });
			});
			await expect(
				outer.transaction(async (savepoint) => {
					await savepoint.insert(users).values({ name: "Dropped" });
					throw new Error("roll back the savepoint");
				}),
			).rejects.toThrow("roll back the savepoint");
		});

		expect(await db.select({ name: users.name }).from(users)).toEqual([
			{ name: "Ada" },
			{ name: "Kept" },
		]);
		// Both layers ran inside each savepoint. The rolled-back savepoint also
		// rolled back its middleware rows.
		expect(await middlewareRuns(db)).toBe(2);
	});

	test("stacked middleware on a transaction runs each layer once", async () => {
		const db = await createRelationalDb();
		const order: string[] = [];

		await db.transaction(async (tx) => {
			const inner = withMiddleware(tx, () => {
				order.push("inner");
				return { before: [sql`INSERT INTO mw_log DEFAULT VALUES`] };
			});
			const outer = withMiddleware(inner, () => {
				order.push("outer");
				return { before: [sql`INSERT INTO mw_log DEFAULT VALUES`] };
			});
			await outer.select().from(users);
		});

		expect(order).toEqual(["outer", "inner"]);
		expect(await middlewareRuns(db)).toBe(2);
	});
});
