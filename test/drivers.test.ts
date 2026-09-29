// The behavior that must be the same on every supported driver. Each test
// runs once for each driver. Driver-specific behavior (round trips, the
// inline encoder, the Bun SQL SQLite queue) has its own test file.
//
// The TCP Postgres drivers run only when TEST_PG_URL is set.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { SQL } from "bun";
import { defineRelations, eq, sql } from "drizzle-orm-beta";
import { drizzle as betterSqlite3 } from "drizzle-orm-beta/better-sqlite3";
import { drizzle as bunSql } from "drizzle-orm-beta/bun-sql";
import { drizzle as bunSqlSqlite } from "drizzle-orm-beta/bun-sql/sqlite";
import { drizzle as bunSqlite } from "drizzle-orm-beta/bun-sqlite";
import { drizzle as nodePg } from "drizzle-orm-beta/node-postgres";
import { integer, pgSchema, serial, text } from "drizzle-orm-beta/pg-core";
import { drizzle as pglite } from "drizzle-orm-beta/pglite";
import { drizzle as postgresJs } from "drizzle-orm-beta/postgres-js";
import {
	integer as sqliteInteger,
	sqliteTable,
	text as sqliteText,
} from "drizzle-orm-beta/sqlite-core";
import pg from "pg";
import postgres from "postgres";
import {
	executeBatchTransaction,
	withMiddleware as withPg,
} from "../src/pg.ts";
import { withMiddleware as withSqlite } from "../src/sqlite.ts";

const url = process.env.TEST_PG_URL;

// A Bun SQL reserved connection is one connection, like a pg.Client.
const bunPool = url ? new SQL({ url, max: 2 }) : undefined;
const bunReserved = bunPool ? await bunPool.reserve() : undefined;

// -----------------------------------------------------------------------
// Tables: the same columns in both dialects
// -----------------------------------------------------------------------

function pgTables(schemaName: string) {
	const s = pgSchema(schemaName);
	const users = s.table("users", {
		id: serial("id").primaryKey(),
		name: text("name").notNull(),
	});
	const posts = s.table("posts", {
		id: serial("id").primaryKey(),
		userId: integer("user_id").notNull(),
		name: text("name"),
	});
	const log = s.table("log", {
		n: serial("n").primaryKey(),
		v: text("v").notNull(),
	});
	return { users, posts, log };
}

function sqliteTables() {
	const users = sqliteTable("users", {
		id: sqliteInteger("id").primaryKey({ autoIncrement: true }),
		name: sqliteText("name").notNull(),
	});
	const posts = sqliteTable("posts", {
		id: sqliteInteger("id").primaryKey({ autoIncrement: true }),
		userId: sqliteInteger("user_id").notNull(),
		name: sqliteText("name"),
	});
	const log = sqliteTable("log", {
		n: sqliteInteger("n").primaryKey({ autoIncrement: true }),
		v: sqliteText("v").notNull(),
	});
	return { users, posts, log };
}

type Tables = ReturnType<typeof pgTables> | ReturnType<typeof sqliteTables>;

const relationsOf = (t: Tables) =>
	defineRelations({ users: t.users, posts: t.posts }, (r) => ({
		users: { posts: r.many.posts({ from: r.users.id, to: r.posts.userId }) },
	}));

// -----------------------------------------------------------------------
// Drivers
// -----------------------------------------------------------------------

interface Opened {
	db: any;
	close(): Promise<void>;
}

interface DriverCase {
	name: string;
	dialect: "pg" | "sqlite";
	/** bun:sqlite and better-sqlite3: transaction callbacks must be sync. */
	sync: boolean;
	/** Opens a Drizzle db with this config (`relations` and `schema`). */
	open(config: object): Opened;
}

const PG_DDL = (s: string) => [
	`create schema "${s}"`,
	`create table "${s}".users (id serial primary key, name text not null)`,
	`create table "${s}".posts (id serial primary key, user_id integer not null, name text)`,
	`create table "${s}".log (n serial primary key, v text not null)`,
];

const SQLITE_DDL = [
	"create table users (id integer primary key autoincrement, name text not null)",
	"create table posts (id integer primary key autoincrement, user_id integer not null, name text)",
	"create table log (n integer primary key autoincrement, v text not null)",
];

const tcpPg = (
	name: string,
	connect: (u: string) => { client: unknown; close(): Promise<void> },
	make: (client: any, config: object) => unknown,
): DriverCase => ({
	name,
	dialect: "pg",
	sync: false,
	open: (config) => {
		const { client, close } = connect(url as string);
		return { db: make(client, config), close };
	},
});

const drivers: DriverCase[] = [
	{
		name: "PGlite",
		dialect: "pg",
		sync: false,
		open: (config) => {
			const client = new PGlite();
			return {
				db: pglite({ client, ...config }),
				close: () => client.close(),
			};
		},
	},
	...(url
		? [
				tcpPg(
					"node-postgres",
					(u) => {
						const pool = new pg.Pool({ connectionString: u, max: 2 });
						return { client: pool, close: () => pool.end() };
					},
					(client, config) => nodePg({ client, ...config }),
				),
				{
					name: "node-postgres (pg.Client)",
					dialect: "pg",
					sync: false,
					open: (config) => {
						const client = new pg.Client({ connectionString: url });
						const connected = client.connect();
						return {
							db: nodePg({ client, ...config }),
							close: async () => {
								await connected;
								await client.end();
							},
						};
					},
				} satisfies DriverCase,
				tcpPg(
					"postgres-js (prepare: true)",
					(u) => {
						const client = postgres(u, { max: 2, onnotice: () => {} });
						return { client, close: () => client.end() };
					},
					(client, config) => postgresJs({ client, ...config }),
				),
				tcpPg(
					"postgres-js (prepare: false)",
					(u) => {
						const client = postgres(u, {
							max: 2,
							prepare: false,
							onnotice: () => {},
						});
						return { client, close: () => client.end() };
					},
					(client, config) => postgresJs({ client, ...config }),
				),
				tcpPg(
					"Bun SQL",
					(u) => {
						const client = new SQL({ url: u, max: 2 });
						return { client, close: () => client.close() };
					},
					(client, config) => bunSql({ client, ...config }),
				),
				{
					name: "Bun SQL (reserved connection)",
					dialect: "pg",
					sync: false,
					open: (config) => ({
						db: bunSql({ client: bunReserved as SQL, ...config }),
						close: async () => {
							bunReserved?.release();
							await bunPool?.close();
						},
					}),
				} satisfies DriverCase,
				tcpPg(
					"Bun SQL (prepare: false)",
					(u) => {
						const client = new SQL({ url: u, max: 2, prepare: false });
						return { client, close: () => client.close() };
					},
					(client, config) => bunSql({ client, ...config }),
				),
			]
		: []),
	{
		name: "bun:sqlite",
		dialect: "sqlite",
		sync: true,
		open: (config) => ({
			db: bunSqlite(":memory:", { ...config }),
			close: async () => {},
		}),
	},
	{
		name: "better-sqlite3",
		dialect: "sqlite",
		sync: true,
		open: (config) => ({
			db: betterSqlite3(":memory:", { ...config }),
			close: async () => {},
		}),
	},
	{
		name: "Bun SQL SQLite",
		dialect: "sqlite",
		sync: false,
		open: (config) => {
			const client = new SQL({ adapter: "sqlite", filename: ":memory:" });
			return {
				db: bunSqlSqlite({ client, ...config }),
				close: () => client.close(),
			};
		},
	},
];

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

for (const driver of drivers) {
	describe(driver.name, () => {
		const schemaName = `drivers_${driver.name.replace(/\W+/g, "_")}_${Date.now()}`;
		const t: any =
			driver.dialect === "pg" ? pgTables(schemaName) : sqliteTables();
		const withMiddleware: (db: any, m: () => object) => any =
			driver.dialect === "pg" ? withPg : withSqlite;
		let opened: Opened;
		let db: any;

		/** A raw statement on the unwrapped db. */
		const raw = (query: ReturnType<typeof sql>) =>
			driver.dialect === "pg" ? db.execute(query) : db.run(query);
		const insertLog = (v: string) =>
			sql`insert into ${t.log} (v) values (${v})`;
		const failingStatement = sql`insert into ${t.log} (v) values (null)`;
		const logged = async (from: any = db): Promise<string[]> =>
			(await from.select({ v: t.log.v }).from(t.log).orderBy(t.log.n)).map(
				(r: { v: string }) => r.v,
			);

		beforeAll(async () => {
			opened = driver.open({
				relations: relationsOf(t),
				schema: { users: t.users, posts: t.posts },
			});
			db = opened.db;
			const ddl = driver.dialect === "pg" ? PG_DDL(schemaName) : SQLITE_DDL;
			for (const statement of ddl) await raw(sql.raw(statement));
		});
		afterAll(async () => {
			if (driver.dialect === "pg")
				await raw(sql.raw(`drop schema "${schemaName}" cascade`));
			await opened.close();
		});
		const reset = async () => {
			if (driver.dialect === "pg")
				await raw(
					sql.raw(
						`truncate "${schemaName}".users, "${schemaName}".posts, "${schemaName}".log restart identity`,
					),
				);
			else
				for (const table of ["users", "posts", "log", "sqlite_sequence"])
					await raw(sql.raw(`delete from ${table}`));
		};

		// ---------------------------------------------------------------
		// Units
		// ---------------------------------------------------------------

		test("before, the query, and after run in order; the query sees only before", async () => {
			await reset();
			const wrapped = withMiddleware(db, () => ({
				before: [insertLog("before")],
				after: [insertLog("after")],
			}));
			expect(await logged(wrapped)).toEqual(["before"]);
			expect(await logged()).toEqual(["before", "after"]);
		});

		test("a failing statement rolls back the whole unit", async () => {
			await reset();
			const wrapped = withMiddleware(db, () => ({
				before: [insertLog("before")],
				after: [failingStatement],
			}));
			await expect(
				Promise.resolve(wrapped.insert(t.users).values({ name: "Ada" })),
			).rejects.toThrow();
			expect(await db.select().from(t.users)).toEqual([]);
			expect(await logged()).toEqual([]);
		});

		test("insert, update and delete run the middleware and return their results", async () => {
			await reset();
			const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));
			expect(
				await wrapped.insert(t.users).values({ name: "Ada" }).returning(),
			).toEqual([{ id: 1, name: "Ada" }]);
			await wrapped
				.update(t.users)
				.set({ name: "Eve" })
				.where(eq(t.users.id, 1));
			expect(await db.select().from(t.users)).toEqual([{ id: 1, name: "Eve" }]);
			await wrapped.delete(t.users).where(eq(t.users.id, 1));
			expect(await db.select().from(t.users)).toEqual([]);
			expect(await logged()).toEqual(["b", "b", "b"]);
		});

		test("every query API runs the middleware once", async () => {
			await reset();
			await db.insert(t.users).values({ name: "Ada" });
			await db.insert(t.posts).values({ userId: 1, name: "post" });
			const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));

			expect(
				await wrapped.query.users.findMany({
					with: { posts: { columns: { name: true } } },
				}),
			).toEqual([{ id: 1, name: "Ada", posts: [{ name: "post" }] }]);
			expect(await wrapped.query.users.findFirst()).toEqual({
				id: 1,
				name: "Ada",
			});
			expect(await wrapped._query.users.findMany()).toEqual([
				{ id: 1, name: "Ada" },
			]);
			const byId = wrapped
				.select({ name: t.users.name })
				.from(t.users)
				.where(eq(t.users.id, sql.placeholder("id")))
				.prepare("drivers_by_id");
			const runPrepared = (values: object) =>
				driver.dialect === "pg" ? byId.execute(values) : byId.all(values);
			expect(await runPrepared({ id: 1 })).toEqual([{ name: "Ada" }]);
			expect(await runPrepared({ id: 2 })).toEqual([]);
			expect(await wrapped.$count(t.users)).toBe(1);
			// Each raw API of the dialect.
			const rawApis =
				driver.dialect === "pg" ? ["execute"] : ["run", "all", "get", "values"];
			for (const api of rawApis) await wrapped[api](sql`select 1`);
			expect((await logged()).length).toBe(6 + rawApis.length);
		});

		test("the result is the query's, not a middleware statement's", async () => {
			await reset();
			await db.insert(t.users).values({ name: "Ada" });
			const wrapped = withMiddleware(db, () => ({
				before: [sql`select 'before' as name`, insertLog("before")],
				after: [sql`select 'after' as name`],
			}));
			expect(
				await wrapped.select({ name: t.users.name }).from(t.users),
			).toEqual([{ name: "Ada" }]);
		});

		test("a join with duplicate column names maps both columns", async () => {
			await reset();
			await db.insert(t.users).values({ name: "Ada" });
			await db.insert(t.posts).values({ userId: 1, name: "post" });
			const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));
			expect(
				await wrapped
					.select()
					.from(t.users)
					.innerJoin(t.posts, eq(t.posts.userId, t.users.id)),
			).toEqual([
				{
					users: { id: 1, name: "Ada" },
					posts: { id: 1, userId: 1, name: "post" },
				},
			]);
		});

		test("stacked layers each run once: before outermost first, after innermost first", async () => {
			await reset();
			const inner = withMiddleware(db, () => ({
				before: [insertLog("inner before")],
				after: [insertLog("inner after")],
			}));
			const outer = withMiddleware(inner, () => ({
				before: [insertLog("outer before")],
				after: [insertLog("outer after")],
			}));
			await outer.insert(t.users).values({ name: "Ada" });
			expect(await logged()).toEqual([
				"outer before",
				"inner before",
				"inner after",
				"outer after",
			]);
		});

		test("blocks $client and direct driver access", () => {
			const wrapped = withMiddleware(db, () => ({}));
			expect(() => wrapped.$client).toThrow("blocked access to `$client`");
			expect(() => wrapped.session.client).toThrow(
				"blocked access to `client`",
			);
			expect(() =>
				Object.getOwnPropertyDescriptor(wrapped.session, "client"),
			).toThrow("blocked access to `client`");
		});

		// ---------------------------------------------------------------
		// executeBatchTransaction
		// ---------------------------------------------------------------

		test("executeBatchTransaction runs the queries and the middleware as one unit", async () => {
			await reset();
			const wrapped = withMiddleware(db, () => ({
				before: [insertLog("before")],
				after: [insertLog("after")],
			}));
			const [inserted, names] = await executeBatchTransaction([
				wrapped.insert(t.users).values({ name: "Ada" }).returning(),
				wrapped.select({ name: t.users.name }).from(t.users),
			]);
			expect(inserted).toEqual([{ id: 1, name: "Ada" }]);
			expect(names).toEqual([{ name: "Ada" }]);
			expect(await logged()).toEqual(["before", "after"]);

			// A failing query rolls back the whole batch.
			await expect(
				Promise.resolve().then(() =>
					executeBatchTransaction([
						wrapped.insert(t.users).values({ name: "Bob" }),
						// The same primary key as Ada's row.
						wrapped
							.insert(t.users)
							.values({ id: 1, name: "Duplicate" }),
					]),
				),
			).rejects.toThrow();
			expect(await db.select().from(t.users)).toHaveLength(1);
			expect(await logged()).toEqual(["before", "after"]);
		});

		test("executeBatchTransaction runs every stacked layer once", async () => {
			await reset();
			const inner = withMiddleware(db, () => ({
				before: [insertLog("inner")],
			}));
			const outer = withMiddleware(inner, () => ({
				before: [insertLog("outer")],
			}));
			await executeBatchTransaction([
				outer.select().from(t.users),
				outer.select().from(t.users),
			]);
			expect(await logged()).toEqual(["outer", "inner"]);
		});

		// ---------------------------------------------------------------
		// Transactions. On a sync driver the callback must be sync, so these
		// tests have a sync body there.
		// ---------------------------------------------------------------

		test("wrapped.transaction runs before once, with the first query, and after before the commit", async () => {
			await reset();
			const wrapped = withMiddleware(db, () => ({
				before: [insertLog("before")],
				after: [insertLog("after")],
			}));
			const seen = driver.sync
				? wrapped.transaction((tx: any) => {
						tx.insert(t.users).values({ name: "Ada" }).run();
						tx.insert(t.users).values({ name: "Bob" }).run();
						return tx.select({ v: t.log.v }).from(t.log).all();
					})
				: await wrapped.transaction(async (tx: any) => {
						await tx.insert(t.users).values({ name: "Ada" });
						await tx.insert(t.users).values({ name: "Bob" });
						return tx.select({ v: t.log.v }).from(t.log);
					});
			expect(seen).toEqual([{ v: "before" }]);
			expect(await logged()).toEqual(["before", "after"]);
			expect(await db.select().from(t.users)).toHaveLength(2);
		});

		test("a rolled-back savepoint does not undo the transaction's before", async () => {
			await reset();
			const wrapped = withMiddleware(db, () => ({
				before: [insertLog("before")],
			}));
			const rollBack = new Error("roll back the savepoint");
			// The first query of the transaction runs inside the savepoint.
			const seen: unknown[] = [];
			if (driver.sync)
				wrapped.transaction((tx: any) => {
					expect(() =>
						tx.transaction((savepoint: any) => {
							seen.push(savepoint.select({ v: t.log.v }).from(t.log).all());
							throw rollBack;
						}),
					).toThrow(rollBack);
					seen.push(tx.select({ v: t.log.v }).from(t.log).all());
				});
			else
				await wrapped.transaction(async (tx: any) => {
					await expect(
						tx.transaction(async (savepoint: any) => {
							seen.push(await savepoint.select({ v: t.log.v }).from(t.log));
							throw rollBack;
						}),
					).rejects.toThrow(rollBack);
					seen.push(await tx.select({ v: t.log.v }).from(t.log));
				});
			expect(seen).toEqual([[{ v: "before" }], [{ v: "before" }]]);
		});

		test("executeBatchTransaction in wrapped.transaction uses the transaction's before", async () => {
			await reset();
			const wrapped = withMiddleware(db, () => ({
				before: [insertLog("before")],
			}));
			const batch = (tx: any) =>
				executeBatchTransaction([
					tx.insert(t.users).values({ name: "Ada" }).returning(),
					tx.select({ v: t.log.v }).from(t.log),
				]);
			let result: Promise<unknown[]> = Promise.resolve([]);
			if (driver.sync)
				// On a sync driver the batch runs at once, in the transaction. Its
				// promise must not be the callback's result.
				wrapped.transaction((tx: any) => {
					tx.select().from(t.users).all();
					result = batch(tx);
				});
			else
				await wrapped.transaction(async (tx: any) => {
					await tx.select().from(t.users);
					result = batch(tx);
					await result;
				});
			const [inserted, seen] = await result;
			expect(inserted).toEqual([{ id: 1, name: "Ada" }]);
			expect(seen).toEqual([{ v: "before" }]);
			expect(await logged()).toEqual(["before"]);
		});

		// A savepoint opens on the unwrapped transaction, so no stacked layer
		// runs twice. A rolled-back savepoint also rolls back its statements.
		test("savepoints in wrapped.transaction on a stacked db run each layer once", async () => {
			await reset();
			const wrapped = withMiddleware(
				withMiddleware(db, () => ({ before: [insertLog("inner")] })),
				() => ({ before: [insertLog("outer")] }),
			);
			const rollBack = new Error("roll back the savepoint");
			if (driver.sync)
				wrapped.transaction((tx: any) => {
					tx.transaction((savepoint: any) => {
						savepoint.run(insertLog("kept"));
					});
					expect(() =>
						tx.transaction((savepoint: any) => {
							savepoint.run(insertLog("dropped"));
							throw rollBack;
						}),
					).toThrow(rollBack);
				});
			else
				await wrapped.transaction(async (tx: any) => {
					await tx.transaction(async (savepoint: any) => {
						await savepoint.insert(t.log).values({ v: "kept" });
					});
					await expect(
						tx.transaction(async (savepoint: any) => {
							await savepoint.insert(t.log).values({ v: "dropped" });
							throw rollBack;
						}),
					).rejects.toThrow(rollBack);
				});
			expect(await logged()).toEqual(["outer", "inner", "kept"]);
		});

		// A sync driver cannot leave work running when its callback returns.
		test.skipIf(driver.sync)(
			"a query that starts after the callback settles cannot run outside the transaction",
			async () => {
				await reset();
				const wrapped = withMiddleware(db, () => ({
					before: [insertLog("before")],
				}));
				const failed = new Error("validation failed");
				// Still running on the connection when the other branch fails.
				const slow =
					driver.dialect === "pg"
						? sql`select pg_sleep(0.1)`
						: sql`with recursive c(x) as (select 1 union all select x + 1 from c where x < 300000) select count(*) from c`;
				let late: Promise<string> = Promise.resolve("not sent");
				const run = wrapped.transaction(async (tx: any) => {
					await Promise.all([
						(async () => {
							await tx.select().from(t.users);
							throw failed;
						})(),
						(async () => {
							await (driver.dialect === "pg" ? tx.execute(slow) : tx.all(slow));
							// Promise.all has rejected; this branch goes on.
							late = Promise.resolve(
								tx.insert(t.users).values({ name: "late" }),
							).then(
								() => "ran",
								(error: Error) => error.message,
							);
						})(),
					]);
				});
				await expect(run).rejects.toThrow(failed);
				await Bun.sleep(20);
				expect(await late).toContain("the transaction has ended");
				expect(await db.select().from(t.users)).toEqual([]);
				expect(await logged()).toEqual([]);
			},
		);

		test.skipIf(driver.sync)(
			"work that starts before the callback returns finishes inside the transaction",
			async () => {
				await reset();
				const wrapped = withMiddleware(db, () => ({
					before: [insertLog("before")],
				}));
				let floating: Promise<unknown> = Promise.resolve();
				// Not awaited: the callback returns while the insert is on its way.
				await wrapped.transaction(async (tx: any) => {
					floating = Promise.resolve(
						tx.insert(t.log).values({ v: "floating" }),
					);
				});
				await floating;
				expect(await logged()).toEqual(["before", "floating"]);

				// When the callback fails, the same work rolls back with it.
				await reset();
				const failed = new Error("roll back");
				await expect(
					wrapped.transaction(async (tx: any) => {
						floating = Promise.resolve(
							tx.insert(t.log).values({ v: "floating" }),
						);
						throw failed;
					}),
				).rejects.toThrow(failed);
				await floating.catch(() => {});
				expect(await logged()).toEqual([]);
			},
		);

		test("a tx kept after wrapped.transaction ends cannot send queries", async () => {
			await reset();
			const wrapped = withMiddleware(db, () => ({
				before: [insertLog("before")],
			}));
			let kept: any;
			if (driver.sync)
				wrapped.transaction((tx: any) => {
					kept = tx;
				});
			else
				await wrapped.transaction(async (tx: any) => {
					kept = tx;
				});
			const runs = (await logged()).length;
			await expect(
				Promise.resolve().then(() => kept.select().from(t.users)),
			).rejects.toThrow("the transaction has ended");
			expect((await logged()).length).toBe(runs);
		});
	});
}
