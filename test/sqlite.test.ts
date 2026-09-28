// withMiddleware (sqlite) on bun:sqlite: the wrapped db, a wrapped open
// transaction, and the guard.

import { describe, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm-beta";
import { drizzle } from "drizzle-orm-beta/bun-sqlite";
import { SQLiteBunTransaction } from "drizzle-orm-beta/bun-sqlite/session";
import { integer, sqliteTable, text } from "drizzle-orm-beta/sqlite-core";
import { readMember } from "../src/internal/drizzle.ts";
import { withMiddleware } from "../src/sqlite.ts";

const t = sqliteTable("t", { id: integer("id") });
const log = sqliteTable("log", {
	n: integer("n").primaryKey({ autoIncrement: true }),
	v: text("v"),
});
const insertLog = (v: string) => sql`insert into log (v) values (${v})`;

function createDb() {
	const db = drizzle(":memory:");
	db.run(sql`create table t (id integer)`);
	db.run(sql`create table log (n integer primary key autoincrement, v text)`);
	return db;
}
const logged = (db: ReturnType<typeof createDb>) =>
	db
		.select({ v: log.v })
		.from(log)
		.orderBy(log.n)
		.all()
		.map((r) => r.v);

describe("withMiddleware (sqlite)", () => {
	// -------------------------------------------------------------------
	// The wrapped db
	// -------------------------------------------------------------------

	test("keeps the relational-query flags of the input db and transaction", () => {
		const db = createDb();
		const dialect = readMember(db, "dialect");
		const session = readMember(db, "session");
		const flaggedDb = new (db.constructor as any)(
			"sync",
			dialect,
			session,
			{},
			undefined,
			true,
			true,
		);
		const flaggedTx = new SQLiteBunTransaction(
			"sync",
			dialect as any,
			session as any,
			{},
			undefined,
			2,
			true,
			true,
		);
		for (const input of [flaggedDb, flaggedTx]) {
			const wrapped = withMiddleware(input, () => ({})) as any;
			expect(wrapped.rowModeRQB).toBe(true);
			expect(wrapped.forbidJsonb).toBe(true);
		}
		expect((withMiddleware(flaggedTx, () => ({})) as any).nestedIndex).toBe(2);
	});

	// -------------------------------------------------------------------
	// Queries (bun:sqlite)
	// -------------------------------------------------------------------

	test("no middleware: the query runs directly, without a transaction", () => {
		const db = createDb();
		db.insert(t).values({ id: 1 }).run();
		const transaction = spyOn(db.$client, "transaction");
		expect(
			withMiddleware(db, () => ({}))
				.select()
				.from(t)
				.all(),
		).toEqual([{ id: 1 }]);
		expect(transaction).not.toHaveBeenCalled();
	});

	test("a wrapped open transaction runs before and after around each query, in it", () => {
		const db = createDb();
		expect(() =>
			db.transaction((tx) => {
				const wrapped = withMiddleware(tx, () => ({
					before: [insertLog("before 1"), insertLog("before 2")],
					after: [insertLog("after")],
				}));
				wrapped.run(insertLog("query"));
				expect(logged(tx as any)).toEqual([
					"before 1",
					"before 2",
					"query",
					"after",
				]);
				throw new Error("roll back the outer transaction");
			}),
		).toThrow("roll back the outer transaction");
		expect(logged(db)).toEqual([]);
	});

	test("unknown prepared-query members are blocked", () => {
		const prepared = withMiddleware(createDb(), () => ({}))
			.select()
			.from(t)
			.prepare() as unknown as Record<string, unknown>;
		expect(() => prepared.stmt).toThrow("blocked access to `stmt`");
		expect(() => prepared.allRqbV2).toThrow("blocked access to `allRqbV2`");
	});

	test("session members that reach the driver are blocked", () => {
		const session = readMember(
			withMiddleware(createDb(), () => ({})),
			"session",
		) as Record<string, unknown>;
		expect(() => session.exec).toThrow("blocked access to `exec`");
	});
});
