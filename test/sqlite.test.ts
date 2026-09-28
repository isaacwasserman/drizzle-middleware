// withMiddleware (sqlite) on bun:sqlite: the wrapped db, a wrapped open
// transaction, and the guard.

import { describe, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm-beta";
import { drizzle } from "drizzle-orm-beta/bun-sqlite";
import { integer, sqliteTable } from "drizzle-orm-beta/sqlite-core";
import { readMember } from "../src/internal/drizzle.ts";
import { withMiddleware } from "../src/sqlite.ts";

const t = sqliteTable("t", { id: integer("id") });

function createDb() {
	const db = drizzle(":memory:");
	db.run(sql`create table t (id integer)`);
	return db;
}

describe("withMiddleware (sqlite)", () => {
	// -------------------------------------------------------------------
	// The wrapped db
	// -------------------------------------------------------------------

	test("keeps the relational-query flags of the input db", () => {
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
		const wrapped = withMiddleware(flaggedDb, () => ({})) as any;
		expect(wrapped.rowModeRQB).toBe(true);
		expect(wrapped.forbidJsonb).toBe(true);
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

	// The types reject a transaction too; this is for callers without types.
	test("rejects a transaction, raw or from a wrapped db", () => {
		const db = createDb();
		db.transaction((tx) => {
			expect(() => withMiddleware(tx as never, () => ({}))).toThrow(TypeError);
		});
		withMiddleware(db, () => ({})).transaction((tx) => {
			expect(() => withMiddleware(tx as never, () => ({}))).toThrow(TypeError);
		});
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
