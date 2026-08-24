import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { type SyncMiddleware, withMiddleware } from "./src/sqlite.ts";

const users = sqliteTable("users", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
});

function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite);
	db.run(
		sql`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
	);
	return db;
}

describe("e2e: bun:sqlite", () => {
	test("middleware runs on insert", () => {
		const log: string[] = [];
		const db = createTestDb();

		const middleware: SyncMiddleware = (next, _tx) => {
			log.push("before");
			const result = next();
			log.push("after");
			return result;
		};

		const wrapped = withMiddleware(db, middleware);
		wrapped.insert(users).values({ name: "Alice" }).run();

		expect(log).toEqual(["before", "after"]);

		const rows = db.select().from(users).all();
		expect(rows).toEqual([{ id: 1, name: "Alice" }]);
	});

	test("middleware runs on select", () => {
		const log: string[] = [];
		const db = createTestDb();
		db.insert(users).values({ name: "Bob" }).run();

		const middleware: SyncMiddleware = (next, _tx) => {
			log.push("before");
			const result = next();
			log.push("after");
			return result;
		};

		const wrapped = withMiddleware(db, middleware);
		const rows = wrapped.select().from(users).all();

		expect(log).toEqual(["before", "after"]);
		expect(rows).toEqual([{ id: 1, name: "Bob" }]);
	});

	test("middleware runs on update", () => {
		const log: string[] = [];
		const db = createTestDb();
		db.insert(users).values({ name: "Charlie" }).run();

		const wrapped = withMiddleware(db, (next) => {
			log.push("before");
			const r = next();
			log.push("after");
			return r;
		});

		wrapped.update(users).set({ name: "Chuck" }).where(eq(users.id, 1)).run();

		expect(log).toEqual(["before", "after"]);

		const rows = db.select().from(users).all();
		expect(rows).toEqual([{ id: 1, name: "Chuck" }]);
	});

	test("middleware runs on delete", () => {
		const log: string[] = [];
		const db = createTestDb();
		db.insert(users).values({ name: "Dave" }).run();

		const wrapped = withMiddleware(db, (next) => {
			log.push("before");
			const r = next();
			log.push("after");
			return r;
		});

		wrapped.delete(users).where(eq(users.id, 1)).run();

		expect(log).toEqual(["before", "after"]);

		const rows = db.select().from(users).all();
		expect(rows).toHaveLength(0);
	});

	test("middleware wraps explicit transactions", () => {
		const log: string[] = [];
		const db = createTestDb();

		const wrapped = withMiddleware(db, (next, _tx) => {
			log.push("middleware:before");
			const r = next();
			log.push("middleware:after");
			return r;
		});

		wrapped.transaction((tx) => {
			tx.insert(users).values({ name: "Eve" }).run();
			tx.insert(users).values({ name: "Frank" }).run();
		});

		expect(log).toEqual(["middleware:before", "middleware:after"]);

		const rows = db.select().from(users).all();
		expect(rows).toHaveLength(2);
	});

	test("middleware can read/write in the same transaction as the query", () => {
		const db = createTestDb();
		const auditLog: Array<{ action: string; count: number }> = [];

		const wrapped = withMiddleware(db, (next, tx) => {
			const before = (tx as any)
				.select({ count: sql<number>`count(*)` })
				.from(users)
				.get();
			const result = next();
			const after = (tx as any)
				.select({ count: sql<number>`count(*)` })
				.from(users)
				.get();
			auditLog.push({
				action: "query",
				count: after.count - before.count,
			});
			return result;
		});

		wrapped.insert(users).values({ name: "Grace" }).run();

		expect(auditLog).toEqual([{ action: "query", count: 1 }]);
	});

	test("middleware can short-circuit and prevent the query", () => {
		const db = createTestDb();

		const wrapped = withMiddleware(db, (_next, _tx) => {
			return undefined;
		});

		wrapped.insert(users).values({ name: "Blocked" }).run();

		const rows = db.select().from(users).all();
		expect(rows).toHaveLength(0);
	});

	test("middleware error rolls back the transaction", () => {
		const db = createTestDb();

		const wrapped = withMiddleware(db, (next) => {
			next();
			throw new Error("rollback");
		});

		expect(() => {
			wrapped.insert(users).values({ name: "Ghost" }).run();
		}).toThrow("rollback");

		const rows = db.select().from(users).all();
		expect(rows).toHaveLength(0);
	});

	test("chained middlewares both run in order", () => {
		const log: string[] = [];
		const db = createTestDb();

		const first: SyncMiddleware = (next) => {
			log.push("first:before");
			const r = next();
			log.push("first:after");
			return r;
		};

		const second: SyncMiddleware = (next) => {
			log.push("second:before");
			const r = next();
			log.push("second:after");
			return r;
		};

		const wrapped = withMiddleware(withMiddleware(db, first), second);
		wrapped.insert(users).values({ name: "Heidi" }).run();

		expect(log).toEqual([
			"first:before",
			"second:before",
			"second:after",
			"first:after",
		]);

		const rows = db.select().from(users).all();
		expect(rows).toEqual([{ id: 1, name: "Heidi" }]);
	});

	test("multiple queries each trigger middleware independently", () => {
		let count = 0;
		const db = createTestDb();

		const wrapped = withMiddleware(db, (next) => {
			count++;
			return next();
		});

		wrapped.insert(users).values({ name: "A" }).run();
		wrapped.insert(users).values({ name: "B" }).run();
		wrapped.select().from(users).all();

		expect(count).toBe(3);
	});

	test("wrapped db preserves $client", () => {
		const db = createTestDb();
		const wrapped = withMiddleware(db, (next) => next());

		expect(wrapped.$client).toBeInstanceOf(Database);
	});
});
