// Bun SQL with the SQLite adapter: async and in-process. The same behavior
// as the sync SQLite suite, through the async API.

import { describe, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { defineRelations, eq, sql } from "drizzle-orm-beta";
import { drizzle } from "drizzle-orm-beta/bun-sql/sqlite";
import { integer, sqliteTable, text } from "drizzle-orm-beta/sqlite-core";
import { readMember } from "../src/internal/drizzle.ts";
import { executeBatchTransaction } from "../src/pg.ts";
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
type Db = Awaited<ReturnType<typeof createDb>>["db"];
const logged = async (db: Db) =>
	(await db.select({ v: log.v }).from(log).orderBy(log.n)).map((r) => r.v);

describe("e2e: Bun SQL SQLite", () => {
	test("before and after run around the query, in order, in one transaction", async () => {
		const { db } = await createDb();
		const wrapped = withMiddleware(db, () => ({
			before: [insertLog("before")],
			after: [insertLog("after")],
		}));
		// The query sees the `before` row, and not yet the `after` row.
		expect(await wrapped.select({ v: log.v }).from(log)).toEqual([
			{ v: "before" },
		]);
		expect(await logged(db)).toEqual(["before", "after"]);

		// A failing statement rolls back the whole unit.
		const failing = withMiddleware(db, () => ({
			before: [insertLog("rolled back")],
			after: [sql`insert into log (v) values (null)`],
		}));
		await expect(
			Promise.resolve(failing.insert(users).values({ name: "Bob" })),
		).rejects.toThrow();
		expect(await db.select().from(users)).toEqual([]);
		expect(await logged(db)).toEqual(["before", "after"]);
	});

	test("insert, update and delete run with middleware and return their results", async () => {
		const { db } = await createDb();
		const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));
		expect(
			await wrapped.insert(users).values({ name: "Ada" }).returning(),
		).toEqual([{ id: 1, name: "Ada" }]);
		await wrapped.update(users).set({ name: "Eve" }).where(eq(users.id, 1));
		expect(await db.select().from(users)).toEqual([{ id: 1, name: "Eve" }]);
		await wrapped.delete(users).where(eq(users.id, 1));
		expect(await db.select().from(users)).toEqual([]);
		expect(await logged(db)).toEqual(["b", "b", "b"]);
	});

	test("every supported query API runs the middleware", async () => {
		const { db } = await createDb();
		await db.insert(users).values({ name: "Ada" });
		await db.insert(posts).values({ userId: 1 });
		const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));

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
		const byId = wrapped
			.select()
			.from(users)
			.where(eq(users.id, sql.placeholder("id")))
			.prepare();
		expect(await byId.all({ id: 1 })).toEqual([{ id: 1, name: "Ada" }]);
		expect(await wrapped.$count(users)).toBe(1);
		await wrapped.run(sql`select 1`);
		await wrapped.all(sql`select 1`);
		await wrapped.get(sql`select 1`);
		await wrapped.values(sql`select 1`);
		expect((await logged(db)).length).toBe(9);
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

	test("db.transaction: before with the first query, after before the commit", async () => {
		const { db } = await createDb();
		const wrapped = withMiddleware(db, () => ({
			before: [insertLog("before")],
			after: [insertLog("after")],
		}));
		await wrapped.transaction(async (tx) => {
			await tx.insert(users).values({ name: "Ada" });
			await tx.insert(users).values({ name: "Bob" });
			await tx.transaction(async (savepoint) => {
				await savepoint.select().from(users);
			});
		});
		expect(await logged(db)).toEqual(["before", "after"]);
		expect(await db.select().from(users)).toHaveLength(2);
	});

	test("a wrapped open transaction runs the middleware around each query, in it", async () => {
		const { db } = await createDb();
		await expect(
			db.transaction(async (tx) => {
				const wrapped = withMiddleware(tx, () => ({
					before: [insertLog("before")],
					after: [insertLog("after")],
				}));
				await wrapped.run(insertLog("query"));
				expect(await logged(tx as unknown as Db)).toEqual([
					"before",
					"query",
					"after",
				]);
				throw new Error("roll back the outer transaction");
			}),
		).rejects.toThrow("roll back the outer transaction");
		expect(await logged(db)).toEqual([]);
	});

	test("stacked middleware on a transaction runs each layer once", async () => {
		const { db } = await createDb();
		await db.transaction(async (tx) => {
			const inner = withMiddleware(tx, () => ({
				before: [insertLog("inner")],
			}));
			const outer = withMiddleware(inner, () => ({
				before: [insertLog("outer")],
			}));
			await outer.select().from(users);
		});
		expect(await logged(db)).toEqual(["outer", "inner"]);
	});

	test("executeBatchTransaction runs the queries and the middleware as one unit", async () => {
		const { db } = await createDb();
		const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));
		const [inserted, all] = await executeBatchTransaction([
			wrapped.insert(users).values({ name: "Ada" }).returning(),
			wrapped.select().from(users),
		]);
		expect(inserted).toEqual([{ id: 1, name: "Ada" }]);
		expect(all).toEqual([{ id: 1, name: "Ada" }]);
		expect(await logged(db)).toEqual(["b"]);
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

	test("blocks $client and direct driver access", async () => {
		const { db } = await createDb();
		const wrapped = withMiddleware(db, () => ({}));
		expect(() => wrapped.$client).toThrow("blocked access to `$client`");
		const session = readMember(wrapped, "session") as Record<string, unknown>;
		expect(() => session.client).toThrow("blocked access to `client`");
	});
});
