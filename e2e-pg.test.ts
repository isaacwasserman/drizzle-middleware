import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { type Middleware, withMiddleware } from "./src/pg.ts";

const users = pgTable("users", {
	id: serial("id").primaryKey(),
	name: text("name").notNull(),
});

async function createTestDb() {
	const client = new PGlite();
	const db = drizzle(client);
	await db.execute(
		sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`,
	);
	return db;
}

describe("e2e: pglite", () => {
	test("middleware runs on insert", async () => {
		const log: string[] = [];
		const db = await createTestDb();

		const middleware: Middleware = async (next, _tx) => {
			log.push("before");
			const result = await next();
			log.push("after");
			return result;
		};

		const wrapped = withMiddleware(db, middleware);
		await wrapped.insert(users).values({ name: "Alice" });

		expect(log).toEqual(["before", "after"]);

		const rows = await db.select().from(users);
		expect(rows).toEqual([{ id: 1, name: "Alice" }]);
	});

	test("middleware runs on select", async () => {
		const log: string[] = [];
		const db = await createTestDb();
		await db.insert(users).values({ name: "Bob" });

		const middleware: Middleware = async (next, _tx) => {
			log.push("before");
			const result = await next();
			log.push("after");
			return result;
		};

		const wrapped = withMiddleware(db, middleware);
		const rows = await wrapped.select().from(users);

		expect(log).toEqual(["before", "after"]);
		expect(rows).toEqual([{ id: 1, name: "Bob" }]);
	});

	test("middleware runs on update", async () => {
		const log: string[] = [];
		const db = await createTestDb();
		await db.insert(users).values({ name: "Charlie" });

		const wrapped = withMiddleware(db, async (next) => {
			log.push("before");
			const r = await next();
			log.push("after");
			return r;
		});

		await wrapped.update(users).set({ name: "Chuck" }).where(eq(users.id, 1));

		expect(log).toEqual(["before", "after"]);

		const rows = await db.select().from(users);
		expect(rows).toEqual([{ id: 1, name: "Chuck" }]);
	});

	test("middleware runs on delete", async () => {
		const log: string[] = [];
		const db = await createTestDb();
		await db.insert(users).values({ name: "Dave" });

		const wrapped = withMiddleware(db, async (next) => {
			log.push("before");
			const r = await next();
			log.push("after");
			return r;
		});

		await wrapped.delete(users).where(eq(users.id, 1));

		expect(log).toEqual(["before", "after"]);

		const rows = await db.select().from(users);
		expect(rows).toHaveLength(0);
	});

	test("middleware wraps explicit transactions", async () => {
		const log: string[] = [];
		const db = await createTestDb();

		const wrapped = withMiddleware(db, async (next, _tx) => {
			log.push("middleware:before");
			const r = await next();
			log.push("middleware:after");
			return r;
		});

		await wrapped.transaction(async (tx) => {
			await tx.insert(users).values({ name: "Eve" });
			await tx.insert(users).values({ name: "Frank" });
		});

		expect(log).toEqual(["middleware:before", "middleware:after"]);

		const rows = await db.select().from(users);
		expect(rows).toHaveLength(2);
	});

	test("middleware can read/write in the same transaction as the query", async () => {
		const db = await createTestDb();
		const auditLog: Array<{ action: string; count: number }> = [];

		const wrapped = withMiddleware(db, async (next, tx) => {
			const before = await (tx as any)
				.select({ count: sql<number>`count(*)::int` })
				.from(users);
			const result = await next();
			const after = await (tx as any)
				.select({ count: sql<number>`count(*)::int` })
				.from(users);
			auditLog.push({
				action: "query",
				count: after[0].count - before[0].count,
			});
			return result;
		});

		await wrapped.insert(users).values({ name: "Grace" });

		expect(auditLog).toEqual([{ action: "query", count: 1 }]);
	});

	test("middleware can short-circuit and prevent the query", async () => {
		const db = await createTestDb();

		const wrapped = withMiddleware(db, async (_next, _tx) => {
			return undefined;
		});

		await wrapped.insert(users).values({ name: "Blocked" });

		const rows = await db.select().from(users);
		expect(rows).toHaveLength(0);
	});

	test("middleware error rolls back the transaction", async () => {
		const db = await createTestDb();

		const wrapped = withMiddleware(db, async (next) => {
			await next();
			throw new Error("rollback");
		});

		try {
			await wrapped.insert(users).values({ name: "Ghost" });
			expect.unreachable("should have thrown");
		} catch (e: any) {
			expect(e.message).toBe("rollback");
		}

		const rows = await db.select().from(users);
		expect(rows).toHaveLength(0);
	});

	test("chained middlewares both run in order", async () => {
		const log: string[] = [];
		const db = await createTestDb();

		const first: Middleware = async (next) => {
			log.push("first:before");
			const r = await next();
			log.push("first:after");
			return r;
		};

		const second: Middleware = async (next) => {
			log.push("second:before");
			const r = await next();
			log.push("second:after");
			return r;
		};

		const wrapped = withMiddleware(withMiddleware(db, first), second);
		await wrapped.insert(users).values({ name: "Heidi" });

		expect(log).toEqual([
			"first:before",
			"second:before",
			"second:after",
			"first:after",
		]);

		const rows = await db.select().from(users);
		expect(rows).toEqual([{ id: 1, name: "Heidi" }]);
	});

	test("multiple queries each trigger middleware independently", async () => {
		let count = 0;
		const db = await createTestDb();

		const wrapped = withMiddleware(db, async (next) => {
			count++;
			return next();
		});

		await wrapped.insert(users).values({ name: "A" });
		await wrapped.insert(users).values({ name: "B" });
		await wrapped.select().from(users);

		expect(count).toBe(3);
	});

	test("wrapped db preserves $client", async () => {
		const db = await createTestDb();
		const wrapped = withMiddleware(db, (next) => next());

		expect(wrapped.$client).toBeInstanceOf(PGlite);
	});
});
