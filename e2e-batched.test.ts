import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm-beta";
import { drizzle as sqliteDrizzle } from "drizzle-orm-beta/bun-sqlite";
import { pgTable, serial, text } from "drizzle-orm-beta/pg-core";
import { drizzle as pgDrizzle } from "drizzle-orm-beta/pglite";
import {
	integer as sqliteInteger,
	sqliteTable,
	text as sqliteText,
} from "drizzle-orm-beta/sqlite-core";
import { executeBatchTransaction } from "./src/index.ts";
import { withMiddleware } from "./src/pg.ts";

const users = pgTable("users", {
	id: serial("id").primaryKey(),
	name: text("name").notNull(),
});

const kv = pgTable("kv", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

async function createPgDb() {
	const db = pgDrizzle({ client: new PGlite() });
	await db.execute(
		sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`,
	);
	await db.execute(
		sql`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	);
	return db;
}

describe("executeBatchTransaction: pglite", () => {
	test("runs writes then a read in a single batch, in order", async () => {
		const db = await createPgDb();

		const [ins, kvIns, rows] = await executeBatchTransaction([
			db.insert(users).values({ name: "Alice" }).returning(),
			db.insert(kv).values({ key: "a", value: "1" }).returning(),
			db.select().from(users),
		]);

		expect(ins).toEqual([{ id: 1, name: "Alice" }]);
		expect(kvIns).toEqual([{ key: "a", value: "1" }]);
		expect(rows).toEqual([{ id: 1, name: "Alice" }]);
	});

	test("results map back per query (fields + where)", async () => {
		const db = await createPgDb();
		await db.insert(users).values([{ name: "Bob" }, { name: "Cara" }]);

		const [names, one] = await executeBatchTransaction([
			db.select({ name: users.name }).from(users).orderBy(users.name),
			db.select().from(users).where(eq(users.id, 2)),
		]);

		expect(names).toEqual([{ name: "Bob" }, { name: "Cara" }]);
		expect(one).toEqual([{ id: 2, name: "Cara" }]);
	});

	test("single query works", async () => {
		const db = await createPgDb();
		await db.insert(users).values({ name: "Dee" });

		const [rows] = await executeBatchTransaction([db.select().from(users)]);
		expect(rows).toEqual([{ id: 1, name: "Dee" }]);
	});

	test("empty array resolves to empty array", async () => {
		const results = await executeBatchTransaction([]);
		expect(results).toEqual([]);
	});

	test("honors middleware on a wrapped db (before runs once around the batch)", async () => {
		const base = await createPgDb();

		let mwCalls = 0;
		const wrapped = withMiddleware(base, () => {
			mwCalls++;
			return {
				before: [
					sql`INSERT INTO kv (key, value) VALUES ('mw', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`,
				],
				after: [sql`UPDATE kv SET value = '2' WHERE key = 'mw'`],
			};
		});

		const [ins, rows] = await executeBatchTransaction([
			wrapped.insert(users).values({ name: "Alice" }).returning(),
			wrapped.select().from(users),
		]);

		// Batched queries run correctly through the wrapped session/dialect proxies.
		expect(ins).toEqual([{ id: 1, name: "Alice" }]);
		expect(rows).toEqual([{ id: 1, name: "Alice" }]);

		// The middleware is applied exactly once around the whole batch, not
		// bypassed and not per-query.
		expect(mwCalls).toBe(1);
		expect(await base.select().from(kv)).toEqual([{ key: "mw", value: "2" }]);
	});

	test("composes nested middleware (both layers applied, outer-first)", async () => {
		const base = await createPgDb();

		let innerCalls = 0;
		let outerCalls = 0;
		const inner = withMiddleware(base, () => {
			innerCalls++;
			return {
				before: [
					sql`INSERT INTO kv (key, value) VALUES ('inner', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`,
				],
			};
		});
		const outer = withMiddleware(inner, () => {
			outerCalls++;
			return {
				before: [
					sql`INSERT INTO kv (key, value) VALUES ('outer', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`,
				],
			};
		});

		const [rows] = await executeBatchTransaction([
			outer.insert(users).values({ name: "Bob" }).returning(),
		]);

		expect(rows).toEqual([{ id: 1, name: "Bob" }]);
		// Neither layer is bypassed; each factory is invoked once.
		expect(outerCalls).toBe(1);
		expect(innerCalls).toBe(1);
		expect(await base.select().from(kv).orderBy(kv.key)).toEqual([
			{ key: "inner", value: "1" },
			{ key: "outer", value: "1" },
		]);
	});

	test("rejects queries from different database instances", async () => {
		const dbA = await createPgDb();
		const dbB = await createPgDb();

		expect(() =>
			executeBatchTransaction([
				dbA.select().from(users),
				dbB.select().from(users),
			]),
		).toThrow(/same database instance/);
	});
});

const sqUsers = sqliteTable("users", {
	id: sqliteInteger("id").primaryKey({ autoIncrement: true }),
	name: sqliteText("name").notNull(),
});

describe("executeBatchTransaction: bun-sqlite (sync)", () => {
	test("runs queries atomically and maps results", async () => {
		const db = sqliteDrizzle(":memory:");
		db.run(
			sql`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
		);

		const [ins, rows] = await executeBatchTransaction([
			db.insert(sqUsers).values({ name: "Eve" }).returning(),
			db.select().from(sqUsers),
		]);

		expect(ins).toEqual([{ id: 1, name: "Eve" }]);
		expect(rows).toEqual([{ id: 1, name: "Eve" }]);
	});
});
