// Copied from the v1 suite (e2e-sqlite.test.ts). Only the imports changed.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { defineRelations, eq, sql } from "drizzle-orm-beta";
import { drizzle } from "drizzle-orm-beta/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm-beta/sqlite-core";
import { drizzle as drizzleProxy } from "drizzle-orm-beta/sqlite-proxy";
import { type Middleware, executeBatchTransaction } from "../src/v2/pg.ts";
import { withMiddleware } from "../src/v2/sqlite.ts";
import { driverDescribe } from "./helpers/drivers.ts";

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

describe("e2e: bun-sqlite middleware", () => {
	test("select returns correctly typed rows", () => {
		const db = createTestDb();
		db.insert(users).values({ name: "Alice" }).run();

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`INSERT INTO kv (key, value) VALUES ('flag', 'on') ON CONFLICT(key) DO UPDATE SET value = 'on'`,
			],
		}));

		const rows = wrapped.select().from(users).all();
		expect(rows).toEqual([{ id: 1, name: "Alice" }]);
	});

	test("before queries execute inside the transaction", () => {
		const db = createTestDb();

		const wrapped = withMiddleware(db, () => ({
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

		const wrapped = withMiddleware(db, () => ({
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

		const wrapped = withMiddleware(db, () => ({
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

		const wrapped = withMiddleware(db, () => ({
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

		const wrapped = withMiddleware(db, () => ({
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

		const wrapped = withMiddleware(db, () => ({
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

		const wrapped = withMiddleware(db, () => ({
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

		const wrapped = withMiddleware(db, () => {
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

		const wrapped = withMiddleware(db, () => ({
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

	test("wrapped db blocks $client", () => {
		const db = createTestDb();
		const wrapped = withMiddleware(db, () => ({}));
		expect(() => wrapped.$client).toThrow("blocked access to `$client`");
		expect(db.$client).toBeDefined();
	});
});

describe("e2e: bun-sqlite fail-closed guard", () => {
	const posts = sqliteTable("posts", {
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id").notNull(),
	});
	const relations = defineRelations({ users, posts }, (r) => ({
		users: { posts: r.many.posts({ from: r.users.id, to: r.posts.userId }) },
	}));

	function createRelationalDb() {
		const db = drizzle(":memory:", { relations, schema: { users, posts } });
		db.run(
			sql`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
		);
		db.run(
			sql`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL)`,
		);
		db.run(sql`CREATE TABLE mw_log (n INTEGER PRIMARY KEY AUTOINCREMENT)`);
		db.insert(users).values({ name: "Ada" }).run();
		db.insert(posts).values({ userId: 1 }).run();
		return db;
	}

	function middlewareRuns(db: ReturnType<typeof createRelationalDb>) {
		return db.get<{ n: number }>(sql`SELECT count(*) AS n FROM mw_log`)?.n;
	}

	test("blocks direct driver access through the wrapped session", () => {
		const db = createRelationalDb();
		const wrapped = withMiddleware(db, () => ({}));
		const session = (wrapped as any).session;

		expect(() => session.client).toThrow("blocked access to `client`");
		expect(() => session.exec("SELECT 1")).toThrow("blocked access to `exec`");
		expect(() => Object.getOwnPropertyDescriptor(session, "client")).toThrow(
			"blocked access to `client`",
		);
	});

	test("every supported query API still runs the middleware", async () => {
		const db = createRelationalDb();
		const wrapped = withMiddleware(db, () => ({
			before: [sql`INSERT INTO mw_log DEFAULT VALUES`],
		}));

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
		const prepared = wrapped
			.select()
			.from(users)
			.where(eq(users.id, sql.placeholder("id")))
			.prepare();
		expect(prepared.all({ id: 1 })).toEqual([{ id: 1, name: "Ada" }]);
		expect(await wrapped.$count(users)).toBe(1);
		wrapped.run(sql`SELECT 1`);
		wrapped.all(sql`SELECT 1`);
		wrapped.get(sql`SELECT 1`);
		wrapped.values(sql`SELECT 1`);
		expect(middlewareRuns(db)).toBe(9);

		// A transaction runs the middleware once, at its boundary.
		wrapped.transaction((tx) => {
			tx.select().from(users).all();
			tx.transaction((nested) => {
				nested.select().from(users).all();
			});
		});
		expect(middlewareRuns(db)).toBe(10);
	});

	test("nested transaction on a wrapped transaction runs the middleware", () => {
		const db = createRelationalDb();

		db.transaction((tx) => {
			const inner = withMiddleware(tx, () => ({
				before: [sql`INSERT INTO mw_log DEFAULT VALUES`],
			}));
			const outer = withMiddleware(inner, () => ({
				before: [sql`INSERT INTO mw_log DEFAULT VALUES`],
			}));
			outer.transaction((savepoint) => {
				savepoint.insert(users).values({ name: "Kept" }).run();
			});
			expect(() =>
				outer.transaction((savepoint) => {
					savepoint.insert(users).values({ name: "Dropped" }).run();
					throw new Error("roll back the savepoint");
				}),
			).toThrow("roll back the savepoint");
		});

		expect(db.select({ name: users.name }).from(users).all()).toEqual([
			{ name: "Ada" },
			{ name: "Kept" },
		]);
		// Both layers ran inside each savepoint. The rolled-back savepoint also
		// rolled back its middleware rows.
		expect(middlewareRuns(db)).toBe(2);
	});

	test("stacked middleware on a transaction runs each layer once", () => {
		const db = createRelationalDb();
		const order: string[] = [];

		db.transaction((tx) => {
			const inner = withMiddleware(tx, () => {
				order.push("inner");
				return { before: [sql`INSERT INTO mw_log DEFAULT VALUES`] };
			});
			const outer = withMiddleware(inner, () => {
				order.push("outer");
				return { before: [sql`INSERT INTO mw_log DEFAULT VALUES`] };
			});
			outer.select().from(users).all();
		});

		expect(order).toEqual(["outer", "inner"]);
		expect(middlewareRuns(db)).toBe(2);
	});
});

driverDescribe("SQLiteRemoteSession")(
	"e2e: sqlite-proxy sequential transaction",
	() => {
		// A proxy db whose remote side is a bun:sqlite database. The proxy sends
		// one statement per callback call; each call is logged.
		function createProxyDb() {
			const sqlite = new Database(":memory:");
			sqlite.run(
				"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
			);
			sqlite.run("CREATE TABLE mw_log (n INTEGER PRIMARY KEY AUTOINCREMENT)");
			sqlite.run("INSERT INTO users (name) VALUES ('Ada')");
			const calls: string[] = [];
			const db = drizzleProxy(async (query, params, method) => {
				calls.push(query);
				const statement = sqlite.query(query);
				if (method === "run") {
					statement.run(...(params as any[]));
					return { rows: [] };
				}
				const rows = statement.values(...(params as any[]));
				return { rows: method === "get" ? (rows[0] ?? []) : rows };
			});
			const logCount = () =>
				(
					sqlite.query("SELECT count(*) AS n FROM mw_log").get() as {
						n: number;
					}
				).n;
			return { db, calls, logCount };
		}

		test("runs before, the query, and after one at a time in a transaction", async () => {
			const { db, calls, logCount } = createProxyDb();
			const wrapped = withMiddleware(db, () => ({
				before: [sql`INSERT INTO mw_log DEFAULT VALUES`],
				after: [sql`INSERT INTO mw_log DEFAULT VALUES`],
			}));

			expect(await wrapped.select().from(users)).toEqual([
				{ id: 1, name: "Ada" },
			]);
			expect(calls).toEqual([
				"begin",
				"INSERT INTO mw_log DEFAULT VALUES",
				'select "id", "name" from "users"',
				"INSERT INTO mw_log DEFAULT VALUES",
				"commit",
			]);
			expect(logCount()).toBe(2);
		});

		test("a failed statement rolls back the whole envelope", async () => {
			const { db, calls, logCount } = createProxyDb();
			const wrapped = withMiddleware(db, () => ({
				before: [sql`INSERT INTO mw_log DEFAULT VALUES`],
				after: [sql`INSERT INTO missing_table DEFAULT VALUES`],
			}));

			await expect(
				Promise.resolve(wrapped.insert(users).values({ name: "Bob" })),
			).rejects.toThrow("missing_table");
			expect(calls.at(-1)).toBe("rollback");
			// Neither the middleware row nor the insert was kept.
			expect(logCount()).toBe(0);
			expect(await db.select().from(users)).toEqual([{ id: 1, name: "Ada" }]);
		});

		test("executeBatchTransaction runs in one transaction", async () => {
			const { db, calls } = createProxyDb();
			const wrapped = withMiddleware(db, () => ({
				before: [sql`INSERT INTO mw_log DEFAULT VALUES`],
			}));

			expect(
				await executeBatchTransaction([
					wrapped.insert(users).values({ name: "Bob" }).returning(),
					wrapped.select().from(users).where(eq(users.name, "Bob")),
				]),
			).toEqual([[{ id: 2, name: "Bob" }], [{ id: 2, name: "Bob" }]]);
			expect(calls[0]).toBe("begin");
			expect(calls.at(-1)).toBe("commit");
		});
	},
);
