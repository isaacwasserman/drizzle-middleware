import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm-beta";
import { integer, pgTable, serial, text } from "drizzle-orm-beta/pg-core";
import { drizzle } from "drizzle-orm-beta/pglite";
import { type Middleware, withMiddleware } from "./src/pg.ts";

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
	test("select returns correctly typed rows", async () => {
		const db = await createTestDb();
		await db.insert(users).values({ name: "Alice" });

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('flag', 'on') ON CONFLICT(key) DO UPDATE SET value = 'on'`,
			],
		}));

		const rows = await wrapped.select().from(users);
		expect(rows).toEqual([{ id: 1, name: "Alice" }]);
	});

	test("before queries execute atomically with the main query", async () => {
		const db = await createTestDb();

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('tenant', 'acme') ON CONFLICT(key) DO UPDATE SET value = 'acme'`,
			],
		}));

		await wrapped.insert(users).values({ name: "Bob" });

		const kvRows = await db.select().from(kvStore);
		expect(kvRows).toEqual([{ key: "tenant", value: "acme" }]);
	});

	test("after queries execute atomically with the main query", async () => {
		const db = await createTestDb();

		const wrapped = withMiddleware(db, () => ({
			after: [
				sql`INSERT INTO kv (key, value) VALUES ('done', 'yes') ON CONFLICT(key) DO UPDATE SET value = 'yes'`,
			],
		}));

		await wrapped.insert(users).values({ name: "Charlie" });

		const kvRows = await db.select().from(kvStore);
		expect(kvRows).toEqual([{ key: "done", value: "yes" }]);
	});

	test("before + select + after all work together", async () => {
		const db = await createTestDb();
		await db.insert(users).values({ name: "Dave" });

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('pre', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`,
			],
			after: [
				sql`INSERT INTO kv (key, value) VALUES ('post', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`,
			],
		}));

		const rows = await wrapped.select().from(users);
		expect(rows).toEqual([{ id: 1, name: "Dave" }]);

		const kvRows = await db.select().from(kvStore).orderBy(kvStore.key);
		expect(kvRows).toEqual([
			{ key: "post", value: "1" },
			{ key: "pre", value: "1" },
		]);
	});

	test("middleware params are inlined correctly", async () => {
		const db = await createTestDb();
		const tenant = "acme-corp";

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('tenant', ${tenant}) ON CONFLICT(key) DO UPDATE SET value = ${tenant}`,
			],
		}));

		await wrapped.insert(users).values({ name: "Eve" });

		const kvRows = await db.select().from(kvStore);
		expect(kvRows).toEqual([{ key: "tenant", value: "acme-corp" }]);
	});

	test("insert returning works with batch middleware", async () => {
		const db = await createTestDb();

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('x', 'y') ON CONFLICT(key) DO UPDATE SET value = 'y'`,
			],
		}));

		const result = await wrapped
			.insert(users)
			.values({ name: "Frank" })
			.returning();

		expect(result).toEqual([{ id: 1, name: "Frank" }]);
	});

	test("update works with batch middleware", async () => {
		const db = await createTestDb();
		await db.insert(users).values({ name: "Grace" });

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('op', 'update') ON CONFLICT(key) DO UPDATE SET value = 'update'`,
			],
		}));

		await wrapped.update(users).set({ name: "Gwen" }).where(eq(users.id, 1));

		const rows = await db.select().from(users);
		expect(rows).toEqual([{ id: 1, name: "Gwen" }]);
	});

	test("delete works with batch middleware", async () => {
		const db = await createTestDb();
		await db.insert(users).values({ name: "Heidi" });

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('op', 'delete') ON CONFLICT(key) DO UPDATE SET value = 'delete'`,
			],
		}));

		await wrapped.delete(users).where(eq(users.id, 1));

		const rows = await db.select().from(users);
		expect(rows).toHaveLength(0);
	});

	test("multiple queries each trigger middleware independently", async () => {
		const db = await createTestDb();
		let count = 0;

		const wrapped = withMiddleware(db, () => {
			count++;
			return {
				before: [
					sql`INSERT INTO kv (key, value) VALUES (${`call-${count}`}, ${String(count)}) ON CONFLICT(key) DO UPDATE SET value = ${String(count)}`,
				],
			};
		});

		await wrapped.insert(users).values({ name: "A" });
		await wrapped.insert(users).values({ name: "B" });
		await wrapped.select().from(users);

		expect(count).toBe(3);
		const kvRows = await db.select().from(kvStore).orderBy(kvStore.key);
		expect(kvRows).toHaveLength(3);
	});

	test("user transaction: before/after run at boundaries", async () => {
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

	test("fast path: empty middleware does not alter behavior", async () => {
		const db = await createTestDb();
		await db.insert(users).values({ name: "Kim" });

		const wrapped = withMiddleware(db, () => ({}));

		const rows = await wrapped.select().from(users);
		expect(rows).toEqual([{ id: 1, name: "Kim" }]);
	});

	test("set_config is visible to the main query via batch before", async () => {
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

	test("wrapped db preserves $client", async () => {
		const db = await createTestDb();
		const wrapped = withMiddleware(db, () => ({}));
		expect(wrapped.$client).toBeInstanceOf(PGlite);
	});

	test("join with duplicate column labels maps correctly through the batch", async () => {
		const db = await createTestDb();
		await db.execute(
			sql`CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL)`,
		);
		await db.insert(users).values({ name: "Nia" });
		await db.insert(orders).values({ userId: 1 });

		// Both tables expose an `id`; the batched multi-statement result must come
		// back as positional array rows so neither `id` is dropped.
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

	test("executeBatchTransaction: join with duplicate column labels", async () => {
		const db = await createTestDb();
		await db.execute(
			sql`CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL)`,
		);
		await db.insert(users).values({ name: "Omar" });
		await db.insert(orders).values({ userId: 1 });

		const { executeBatchTransaction } = await import("./src/pg.ts");
		const [joined] = await executeBatchTransaction([
			db.select().from(users).innerJoin(orders, eq(orders.userId, users.id)),
		]);

		expect(joined).toEqual([
			{ users: { id: 1, name: "Omar" }, orders: { id: 1, userId: 1 } },
		]);
	});

	test("composition: nested middleware applies both layers in one round trip", async () => {
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
