// executeBatchTransaction on PGlite and bun:sqlite.
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm-beta";
import { drizzle as sqliteDrizzle } from "drizzle-orm-beta/bun-sqlite";
import { integer, pgTable, serial, text } from "drizzle-orm-beta/pg-core";
import { drizzle as pgDrizzle } from "drizzle-orm-beta/pglite";
import {
	integer as sqliteInteger,
	sqliteTable,
	text as sqliteText,
} from "drizzle-orm-beta/sqlite-core";
import { executeBatchTransaction, withMiddleware } from "../src/pg.ts";

const users = pgTable("users", {
	id: serial("id").primaryKey(),
	name: text("name").notNull(),
});

const orders = pgTable("orders", {
	id: serial("id").primaryKey(),
	userId: integer("user_id").notNull(),
});

const kv = pgTable("kv", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

// One PGlite database for the file, because each one takes about half a
// second to start. Each test gets an empty schema and the default settings.
const client = new PGlite();
const freshSchema = () =>
	client.exec("reset all; drop schema public cascade; create schema public");

async function createPgDb() {
	await freshSchema();
	const db = pgDrizzle({ client });
	await db.execute(
		sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`,
	);
	await db.execute(
		sql`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	);
	await db.execute(
		sql`CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL)`,
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

	test("each query's result is mapped by that query, joins included", async () => {
		const db = await createPgDb();
		await db.insert(users).values([{ name: "Bob" }, { name: "Cara" }]);
		await db.insert(orders).values({ userId: 2 });

		const [names, joined] = await executeBatchTransaction([
			db.select({ name: users.name }).from(users).orderBy(users.name),
			// Both tables have an `id` column; neither may be lost.
			db
				.select()
				.from(users)
				.innerJoin(orders, eq(orders.userId, users.id)),
		]);

		expect(names).toEqual([{ name: "Bob" }, { name: "Cara" }]);
		expect(joined).toEqual([
			{ users: { id: 2, name: "Cara" }, orders: { id: 1, userId: 2 } },
		]);
	});

	test("empty array resolves to empty array", async () => {
		const results = await executeBatchTransaction([]);
		expect(results).toEqual([]);
	});

	test("rejects a value that is not a query builder", async () => {
		const db = await createPgDb();
		const wrapped = withMiddleware(db, () => ({}));
		// The types reject an awaited result; the runtime check is for callers
		// without types.
		const notBuilders: unknown[] = [
			await db.select().from(users),
			wrapped.execute(sql`select 1`),
		];
		for (const notBuilder of notBuilders)
			expect(() =>
				executeBatchTransaction([
					db.select().from(users),
					notBuilder as PromiseLike<unknown>,
				]),
			).toThrow(TypeError);
	});

	test("rejects queries from different database instances", async () => {
		const dbA = await createPgDb();
		const dbB = await createPgDb();

		expect(() =>
			executeBatchTransaction([
				dbA.select().from(users),
				dbB.select().from(users),
			]),
		).toThrow(TypeError);
	});
});

const sqUsers = sqliteTable("users", {
	id: sqliteInteger("id").primaryKey({ autoIncrement: true }),
	name: sqliteText("name").notNull(),
});

describe("executeBatchTransaction: bun-sqlite (sync)", () => {
	test("runs the queries and maps their results", async () => {
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
