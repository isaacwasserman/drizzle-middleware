// Behavior that only Bun SQL with the SQLite adapter has. The behavior that
// all drivers share is in drivers.test.ts.

import { describe, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { defineRelations, sql } from "drizzle-orm-beta";
import { drizzle } from "drizzle-orm-beta/bun-sql/sqlite";
import { integer, sqliteTable, text } from "drizzle-orm-beta/sqlite-core";
import { withMiddleware } from "../src/sqlite.ts";

const users = sqliteTable("users", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
});
const posts = sqliteTable("posts", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	userId: integer("user_id").notNull(),
});
const log = sqliteTable("log", {
	n: integer("n").primaryKey({ autoIncrement: true }),
	v: text("v"),
});
const relations = defineRelations({ users, posts }, (r) => ({
	users: { posts: r.many.posts({ from: r.users.id, to: r.posts.userId }) },
}));
const insertLog = (v: string) => sql`insert into log (v) values (${v})`;

async function createDb() {
	const client = new SQL({ adapter: "sqlite", filename: ":memory:" });
	const db = drizzle({ client, relations, schema: { users, posts } });
	await db.run(
		sql`create table users (id integer primary key autoincrement, name text not null)`,
	);
	await db.run(
		sql`create table posts (id integer primary key autoincrement, user_id integer not null)`,
	);
	await db.run(
		sql`create table log (n integer primary key autoincrement, v text not null)`,
	);
	return { client, db };
}

describe("e2e: Bun SQL SQLite", () => {
	// A unit on a transaction handle would run outside that transaction.
	test("a transaction handle as the client is rejected", async () => {
		const { client } = await createDb();
		await client.begin(async (tx) => {
			expect(() =>
				withMiddleware(drizzle({ client: tx as SQL }), () => ({})),
			).toThrow("transaction handle");
		});
	});

	test("no middleware: the query runs directly, without a transaction", async () => {
		const { client, db } = await createDb();
		await db.insert(users).values({ name: "Ada" });
		const begin = spyOn(client, "begin");
		expect(
			await withMiddleware(db, () => ({}))
				.select()
				.from(users),
		).toEqual([{ id: 1, name: "Ada" }]);
		expect(begin).not.toHaveBeenCalled();
	});

	// Bun SQL SQLite has one connection and does not queue transactions: a
	// query sent while a transaction is open runs in it.
	test("a query waits until an open unit on the same client ends", async () => {
		const { db } = await createDb();
		const wrapped = withMiddleware(db, () => ({ before: [insertLog("A")] }));
		const direct = withMiddleware(db, () => ({}));
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const open = wrapped.transaction(async (tx) => {
			await tx.select().from(users);
			await gate;
			throw new Error("roll back");
		});
		await Bun.sleep(10);
		const read = Promise.resolve(direct.select({ v: log.v }).from(log));
		const early = await Promise.race([read, Bun.sleep(50).then(() => "waits")]);
		expect(early).toBe("waits");
		release();
		await expect(open).rejects.toThrow("roll back");
		expect(await read).toEqual([]);
	});
});
