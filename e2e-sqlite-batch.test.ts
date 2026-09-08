import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm-beta";
import { drizzle } from "drizzle-orm-beta/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm-beta/sqlite-core";
import {
	type BatchMiddleware,
	withBatchMiddleware,
} from "./src/beta/sqlite-batch.ts";

const users = sqliteTable("users", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
});

const kvStore = sqliteTable("kv", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

function createTestDb() {
	const db = drizzle(":memory:");
	db.run(
		sql`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
	);
	db.run(sql`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
	return db;
}

describe("e2e: bun-sqlite batch middleware", () => {
	test("select returns correctly typed rows", () => {
		const db = createTestDb();
		db.insert(users).values({ name: "Alice" }).run();

		const wrapped = withBatchMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('flag', 'on') ON CONFLICT(key) DO UPDATE SET value = 'on'`,
			],
		}));

		const rows = wrapped.select().from(users).all();
		expect(rows).toEqual([{ id: 1, name: "Alice" }]);
	});

	test("before queries execute inside the transaction", () => {
		const db = createTestDb();

		const wrapped = withBatchMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('tenant', 'acme') ON CONFLICT(key) DO UPDATE SET value = 'acme'`,
			],
		}));

		wrapped.insert(users).values({ name: "Bob" }).run();

		const kvRows = db.select().from(kvStore).all();
		expect(kvRows).toEqual([{ key: "tenant", value: "acme" }]);
	});

	test("after queries execute inside the transaction", () => {
		const db = createTestDb();

		const wrapped = withBatchMiddleware(db, () => ({
			after: [
				sql`INSERT INTO kv (key, value) VALUES ('done', 'yes') ON CONFLICT(key) DO UPDATE SET value = 'yes'`,
			],
		}));

		wrapped.insert(users).values({ name: "Charlie" }).run();

		const kvRows = db.select().from(kvStore).all();
		expect(kvRows).toEqual([{ key: "done", value: "yes" }]);
	});

	test("before + select + after all work together", () => {
		const db = createTestDb();
		db.insert(users).values({ name: "Dave" }).run();

		const wrapped = withBatchMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('pre', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`,
			],
			after: [
				sql`INSERT INTO kv (key, value) VALUES ('post', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`,
			],
		}));

		const rows = wrapped.select().from(users).all();
		expect(rows).toEqual([{ id: 1, name: "Dave" }]);

		const kvRows = db.select().from(kvStore).orderBy(kvStore.key).all();
		expect(kvRows).toEqual([
			{ key: "post", value: "1" },
			{ key: "pre", value: "1" },
		]);
	});

	test("middleware params are inlined correctly", () => {
		const db = createTestDb();
		const tenant = "acme-corp";

		const wrapped = withBatchMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('tenant', ${tenant}) ON CONFLICT(key) DO UPDATE SET value = ${tenant}`,
			],
		}));

		wrapped.insert(users).values({ name: "Eve" }).run();

		const kvRows = db.select().from(kvStore).all();
		expect(kvRows).toEqual([{ key: "tenant", value: "acme-corp" }]);
	});

	test("insert returns correct result", () => {
		const db = createTestDb();

		const wrapped = withBatchMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('x', 'y') ON CONFLICT(key) DO UPDATE SET value = 'y'`,
			],
		}));

		const result = wrapped
			.insert(users)
			.values({ name: "Frank" })
			.returning()
			.all();

		expect(result).toEqual([{ id: 1, name: "Frank" }]);
	});

	test("update works with batch middleware", () => {
		const db = createTestDb();
		db.insert(users).values({ name: "Grace" }).run();

		const wrapped = withBatchMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('op', 'update') ON CONFLICT(key) DO UPDATE SET value = 'update'`,
			],
		}));

		wrapped.update(users).set({ name: "Gwen" }).where(eq(users.id, 1)).run();

		const rows = db.select().from(users).all();
		expect(rows).toEqual([{ id: 1, name: "Gwen" }]);
	});

	test("delete works with batch middleware", () => {
		const db = createTestDb();
		db.insert(users).values({ name: "Heidi" }).run();

		const wrapped = withBatchMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('op', 'delete') ON CONFLICT(key) DO UPDATE SET value = 'delete'`,
			],
		}));

		wrapped.delete(users).where(eq(users.id, 1)).run();

		const rows = db.select().from(users).all();
		expect(rows).toHaveLength(0);
	});

	test("multiple queries each trigger middleware independently", () => {
		const db = createTestDb();
		let count = 0;

		const wrapped = withBatchMiddleware(db, () => {
			count++;
			return {
				before: [
					sql`INSERT INTO kv (key, value) VALUES (${`call-${count}`}, ${String(count)}) ON CONFLICT(key) DO UPDATE SET value = ${String(count)}`,
				],
			};
		});

		wrapped.insert(users).values({ name: "A" }).run();
		wrapped.insert(users).values({ name: "B" }).run();
		wrapped.select().from(users).all();

		expect(count).toBe(3);
		const kvRows = db.select().from(kvStore).orderBy(kvStore.key).all();
		expect(kvRows).toHaveLength(3);
	});

	test("user transaction: before/after run at boundaries", () => {
		const db = createTestDb();

		const wrapped = withBatchMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('phase', 'before') ON CONFLICT(key) DO UPDATE SET value = 'before'`,
			],
			after: [sql`UPDATE kv SET value = 'after' WHERE key = 'phase'`],
		}));

		wrapped.transaction((tx) => {
			tx.insert(users).values({ name: "Ivy" }).run();
			tx.insert(users).values({ name: "Jack" }).run();
		});

		const userRows = db.select().from(users).all();
		expect(userRows).toHaveLength(2);

		const kvRows = db.select().from(kvStore).all();
		expect(kvRows).toEqual([{ key: "phase", value: "after" }]);
	});

	test("wrapped db preserves $client", () => {
		const db = createTestDb();
		const wrapped = withBatchMiddleware(db, () => ({}));
		expect(wrapped.$client).toBeDefined();
	});
});
