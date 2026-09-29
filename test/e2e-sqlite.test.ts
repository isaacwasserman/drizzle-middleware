// Behavior that only the sync SQLite drivers (bun:sqlite, better-sqlite3)
// have: their transactions commit when the callback returns. The behavior
// that all drivers share is in drivers.test.ts.

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm-beta";
import { drizzle as betterSqlite3 } from "drizzle-orm-beta/better-sqlite3";
import { drizzle as bunSqlite } from "drizzle-orm-beta/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm-beta/sqlite-core";
import { withMiddleware } from "../src/sqlite.ts";

const users = sqliteTable("users", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
});

// Both take `drizzle(":memory:")`; better-sqlite3's db type is used as bun's.
const SYNC_DRIVERS = [
	{ name: "bun:sqlite", drizzle: bunSqlite },
	{
		name: "better-sqlite3",
		drizzle: betterSqlite3 as unknown as typeof bunSqlite,
	},
];

for (const driver of SYNC_DRIVERS) {
	function createDb() {
		const db = driver.drizzle(":memory:");
		db.run(
			sql`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
		);
		db.run(sql`CREATE TABLE mw_log (n INTEGER PRIMARY KEY AUTOINCREMENT)`);
		return db;
	}
	const middlewareRuns = (db: ReturnType<typeof createDb>) =>
		db.get<{ n: number }>(sql`SELECT count(*) AS n FROM mw_log`)?.n;
	const middleware = () => ({
		before: [sql`INSERT INTO mw_log DEFAULT VALUES`],
	});

	describe(driver.name, () => {
		// Inside the transaction, its `after` could undo the scope's `before`.
		test("a query on the wrapped db inside its own transaction throws", () => {
			const db = createDb();
			const wrapped = withMiddleware(db, middleware);
			expect(() =>
				wrapped.transaction(() => {
					wrapped.select().from(users).all();
				}),
			).toThrow("inside its own transaction");
			// After the transaction, the wrapped db works again.
			expect(wrapped.select().from(users).all()).toEqual([]);
		});

		// With an async callback, the queries after an `await` would run after
		// the commit.
		test("an async transaction callback throws, rolls back, and cannot send more queries", async () => {
			const db = createDb();
			const wrapped = withMiddleware(db, middleware);
			let later: Promise<string> = Promise.resolve("not sent");
			expect(() =>
				// @ts-expect-error -- the wrong use, as a caller without types can make it
				wrapped.transaction(async (tx) => {
					tx.insert(users).values({ name: "Rolled back" }).run();
					await Promise.resolve();
					later = Promise.resolve(tx.select().from(users)).then(
						() => "ran",
						(error: Error) => error.message,
					);
				}),
			).toThrow(TypeError);
			await Bun.sleep(0);
			expect(await later).toContain("the transaction has ended");
			expect(db.select().from(users).all()).toEqual([]);
			expect(middlewareRuns(db)).toBe(0);

			wrapped.transaction((tx) => {
				expect(() =>
					// @ts-expect-error -- the wrong use, as a caller without types can make it
					tx.transaction(async () => {}),
				).toThrow(TypeError);
			});
		});
	});
}
