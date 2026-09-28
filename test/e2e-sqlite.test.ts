// End-to-end behavior on the two sync SQLite drivers: bun:sqlite and
// better-sqlite3.
import { describe, expect, test } from "bun:test";
import { defineRelations, eq, sql } from "drizzle-orm-beta";
import { drizzle as betterSqlite3 } from "drizzle-orm-beta/better-sqlite3";
import { drizzle as bunSqlite } from "drizzle-orm-beta/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm-beta/sqlite-core";
import { withMiddleware } from "../src/sqlite.ts";

const users = sqliteTable("users", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
});

const kvStore = sqliteTable("kv", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

// The two sync SQLite drivers run the same tests. Both take
// `drizzle(":memory:", config)`; better-sqlite3's db type is used as bun's.
const SYNC_DRIVERS = [
	{ name: "bun-sqlite", drizzle: bunSqlite },
	{
		name: "better-sqlite3",
		drizzle: betterSqlite3 as unknown as typeof bunSqlite,
	},
];

for (const driver of SYNC_DRIVERS) {
	const drizzle = driver.drizzle;

	function createTestDb() {
		const db = drizzle(":memory:");
		db.run(
			sql`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
		);
		db.run(sql`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		return db;
	}

	describe(`e2e: ${driver.name} middleware`, () => {
		test("before and after run around the query, in order, in one transaction", () => {
			const db = createTestDb();
			const wrapped = withMiddleware(db, () => ({
				before: [sql`INSERT INTO kv (key, value) VALUES ('before', ${"acme"})`],
				after: [sql`INSERT INTO kv (key, value) VALUES ('after', 'done')`],
			}));

			// The query sees the `before` row, and not yet the `after` row.
			expect(wrapped.select({ key: kvStore.key }).from(kvStore).all()).toEqual([
				{ key: "before" },
			]);
			expect(db.select().from(kvStore).orderBy(kvStore.key).all()).toEqual([
				{ key: "after", value: "done" },
				{ key: "before", value: "acme" },
			]);

			// A failing statement rolls back the whole unit: the query's insert
			// and the `before` row are not kept.
			const failing = withMiddleware(db, () => ({
				before: [sql`INSERT INTO kv (key, value) VALUES ('rolled back', 'x')`],
				after: [sql`INSERT INTO kv (key, value) VALUES ('bad', NULL)`],
			}));
			expect(() =>
				failing.insert(users).values({ name: "Bob" }).run(),
			).toThrow();
			expect(db.select().from(users).all()).toEqual([]);
			expect(db.select().from(kvStore).all()).toHaveLength(2);
		});

		test("insert, update and delete run with middleware and return their results", () => {
			const db = createTestDb();
			const wrapped = withMiddleware(db, () => ({
				before: [
					sql`INSERT INTO kv (key, value) VALUES ('op', 'x') ON CONFLICT(key) DO NOTHING`,
				],
			}));

			expect(
				wrapped.insert(users).values({ name: "Frank" }).returning().all(),
			).toEqual([{ id: 1, name: "Frank" }]);
			wrapped.update(users).set({ name: "Gwen" }).where(eq(users.id, 1)).run();
			expect(db.select().from(users).all()).toEqual([{ id: 1, name: "Gwen" }]);
			wrapped.delete(users).where(eq(users.id, 1)).run();
			expect(db.select().from(users).all()).toEqual([]);
		});

		test("db.transaction runs before and after once, around the whole transaction", () => {
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
		});
	});

	describe(`e2e: ${driver.name} fail-closed guard`, () => {
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
			expect(() => session.exec("SELECT 1")).toThrow(
				"blocked access to `exec`",
			);
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

		test("a rolled-back savepoint does not undo the transaction's before", () => {
			const db = createTestDb();
			const wrapped = withMiddleware(db, () => ({
				before: [sql`INSERT INTO kv (key, value) VALUES ('tenant', 'acme')`],
			}));
			const tenant = (q: Pick<typeof db, "select">) =>
				q.select({ value: kvStore.value }).from(kvStore).all();
			wrapped.transaction((tx) => {
				expect(() =>
					tx.transaction((savepoint) => {
						expect(tenant(savepoint)).toEqual([{ value: "acme" }]);
						throw new Error("roll back the savepoint");
					}),
				).toThrow("roll back the savepoint");
				expect(tenant(tx)).toEqual([{ value: "acme" }]);
			});
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
}
