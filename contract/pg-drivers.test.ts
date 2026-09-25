// Contract: the same behavior on every TCP Postgres driver, against a real
// Postgres. Replaces the v1 mock tests for postgres-js (array mode, native
// results, PostgresJsTransaction) and adds the round-trip check.
//
// Runs only when CONTRACT_PG_URL is set, e.g.
//   CONTRACT_PG_URL=postgres://postgres@127.0.0.1:5432/postgres bun test ./contract

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { defineRelations, eq, sql } from "drizzle-orm-beta";
import { drizzle as bunSql } from "drizzle-orm-beta/bun-sql";
import { drizzle as nodePg } from "drizzle-orm-beta/node-postgres";
import {
	bytea,
	integer,
	pgSchema,
	serial,
	text,
} from "drizzle-orm-beta/pg-core";
import { drizzle as postgresJs } from "drizzle-orm-beta/postgres-js";
import pg from "pg";
import postgres from "postgres";
import { startLatencyProxy } from "../test-helpers/latency-proxy.ts";
import { IMPL, withPgMiddleware as withMiddleware } from "./impl.ts";

const url = process.env.CONTRACT_PG_URL;
const LATENCY_MS = 50;

type Connected = { db: any; close(): Promise<void> };
type DriverCase = {
	name: string;
	/** `max: 1`, so session settings apply to the connection the query uses. */
	connect(url: string): Connected;
	/** Audit findings that v1 fails on this driver. */
	v1Bugs: string[];
};

function makeTables(schemaName: string) {
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
	const log = s.table("log", { n: serial("n").primaryKey(), v: text("v") });
	const files = s.table("files", {
		id: serial("id").primaryKey(),
		data: bytea("data"),
	});
	const relations = defineRelations({ users, posts }, (r) => ({
		users: { posts: r.many.posts({ from: r.users.id, to: r.posts.userId }) },
	}));
	return { users, posts, log, files, relations };
}

const drivers: DriverCase[] = [
	{
		name: "node-postgres",
		connect: (u) => {
			const pool = new pg.Pool({ connectionString: u, max: 1 });
			return { db: pool, close: () => pool.end() };
		},
		v1Bugs: ["injection", "bytea"],
	},
	{
		name: "postgres-js (prepare: true)",
		connect: (u) => {
			const client = postgres(u, { max: 1, onnotice: () => {} });
			return { db: client, close: () => client.end() };
		},
		v1Bugs: ["injection", "bytea", "results by position"],
	},
	{
		name: "postgres-js (prepare: false)",
		connect: (u) => {
			const client = postgres(u, {
				max: 1,
				prepare: false,
				onnotice: () => {},
			});
			return { db: client, close: () => client.end() };
		},
		v1Bugs: ["injection", "bytea", "results by position"],
	},
	{
		name: "Bun SQL",
		connect: (u) => {
			const client = new SQL({ url: u, max: 1 });
			return { db: client, close: () => client.close() };
		},
		v1Bugs: ["injection", "bytea"],
	},
];

function drizzleFor(driver: DriverCase, client: unknown, relations: unknown) {
	if (driver.name === "node-postgres")
		return nodePg({ client: client as pg.Pool, relations: relations as any });
	if (driver.name.startsWith("postgres-js"))
		return postgresJs({ client: client as any, relations: relations as any });
	return bunSql({ client: client as any, relations: relations as any });
}

const describeIfPg = url ? describe : describe.skip;

for (const driver of drivers) {
	describeIfPg(`contract: ${driver.name}`, () => {
		const schemaName = `contract_${driver.name.replace(/\W+/g, "_")}_${Date.now()}`;
		const t = makeTables(schemaName);
		let connected: Connected;
		let db: any;

		const contractTest = (
			name: string,
			fn: () => Promise<void>,
			v1Bug?: string,
		) => {
			if (
				IMPL === "v1" &&
				v1Bug &&
				driver.v1Bugs.includes(v1Bug) &&
				!process.env.CONTRACT_SHOW_V1_BUGS
			)
				test.failing(`${name} [v1 bug: ${v1Bug}]`, fn);
			else test(name, fn);
		};
		const insertLog = (v: string) =>
			sql`insert into ${t.log} (v) values (${v})`;
		const logged = async () =>
			(await db.select({ v: t.log.v }).from(t.log).orderBy(t.log.n)).map(
				(r: { v: string }) => r.v,
			);

		beforeAll(async () => {
			connected = driver.connect(url as string);
			db = drizzleFor(driver, connected.db, t.relations);
			await db.execute(sql.raw(`create schema "${schemaName}"`));
			await db.execute(
				sql.raw(
					`create table "${schemaName}".users (id serial primary key, name text not null)`,
				),
			);
			await db.execute(
				sql.raw(
					`create table "${schemaName}".posts (id serial primary key, user_id integer not null, name text)`,
				),
			);
			await db.execute(
				sql.raw(
					`create table "${schemaName}".log (n serial primary key, v text)`,
				),
			);
			await db.execute(
				sql.raw(
					`create table "${schemaName}".files (id serial primary key, data bytea)`,
				),
			);
			await db.execute(sql.raw(`create table "${schemaName}".victims (x int)`));
		});
		afterAll(async () => {
			await db.execute(sql.raw(`drop schema "${schemaName}" cascade`));
			await connected.close();
		});
		const reset = async () => {
			await db.execute(
				sql.raw(
					`truncate "${schemaName}".users, "${schemaName}".posts, "${schemaName}".log, "${schemaName}".files restart identity`,
				),
			);
		};

		contractTest("before, the query, and after run in order", async () => {
			await reset();
			const wrapped = withMiddleware(db, () => ({
				before: [insertLog("before")],
				after: [insertLog("after")],
			}));
			await wrapped.execute(insertLog("query"));
			expect(await logged()).toEqual(["before", "query", "after"]);
		});

		contractTest(
			"a failing after statement rolls back the whole unit",
			async () => {
				await reset();
				const wrapped = withMiddleware(db, () => ({
					before: [insertLog("before")],
					after: [sql`select 1/0`],
				}));
				await expect(
					Promise.resolve(wrapped.insert(t.users).values({ name: "Ada" })),
				).rejects.toThrow();
				expect(await logged()).toEqual([]);
				expect(await db.select().from(t.users)).toEqual([]);
			},
		);

		contractTest(
			"transaction-local state reaches the query and is gone after",
			async () => {
				const wrapped = withMiddleware(db, () => ({
					before: [sql`select set_config('app.tenant', ${"acme"}, true)`],
				}));
				const [row] = await wrapped
					.select({ tenant: sql<string>`current_setting('app.tenant', true)` })
					.from(sql`(select 1) as one`);
				expect(row.tenant).toBe("acme");
				const after = await db.execute(
					sql`select coalesce(current_setting('app.tenant', true), '') as v`,
				);
				expect(Array.from(after.rows ?? after)[0]).toMatchObject({ v: "" });
			},
		);

		contractTest(
			"several before statements, some without rows, keep the query's result",
			async () => {
				await reset();
				await db.insert(t.users).values({ name: "Ada" });
				const wrapped = withMiddleware(db, () => ({
					before: [
						sql`select set_config('app.tenant', ${"acme"}, true)`,
						insertLog("before"),
					],
				}));
				expect(
					await wrapped.select({ name: t.users.name }).from(t.users),
				).toEqual([{ name: "Ada" }]);
			},
			"results by position",
		);

		contractTest(
			"an after statement that returns rows does not replace the query's result",
			async () => {
				await reset();
				await db.insert(t.users).values({ name: "Ada" });
				const wrapped = withMiddleware(db, () => ({
					before: [insertLog("before")],
					after: [sql`select 'after' as name`],
				}));
				expect(
					await wrapped.select({ name: t.users.name }).from(t.users),
				).toEqual([{ name: "Ada" }]);
			},
		);

		contractTest("$count returns the count (positional rows)", async () => {
			await reset();
			await db.insert(t.users).values([{ name: "Ada" }, { name: "Bob" }]);
			const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));
			expect(await wrapped.$count(t.users)).toBe(2);
		});

		contractTest(
			"raw execute returns the same rows as the unwrapped db",
			async () => {
				await reset();
				await db.insert(t.users).values({ name: "Ada" });
				const query = sql`select id, name from ${t.users}`;
				const plain = await db.execute(query);
				const wrapped = await withMiddleware(db, () => ({
					before: [insertLog("b")],
				})).execute(query);
				expect(Array.from(wrapped.rows ?? wrapped)).toEqual(
					Array.from(plain.rows ?? plain),
				);
			},
		);

		contractTest(
			"a join with duplicate column labels maps correctly",
			async () => {
				await reset();
				await db.insert(t.users).values({ name: "Ada" });
				await db.insert(t.posts).values({ userId: 1, name: "post" });
				const wrapped = withMiddleware(db, () => ({
					before: [insertLog("b")],
				}));
				expect(
					await wrapped
						.select({ user: t.users.name, post: t.posts.name })
						.from(t.users)
						.innerJoin(t.posts, eq(t.posts.userId, t.users.id)),
				).toEqual([{ user: "Ada", post: "post" }]);
			},
		);

		contractTest("a relational query runs the middleware", async () => {
			await reset();
			await db.insert(t.users).values({ name: "Ada" });
			await db.insert(t.posts).values({ userId: 1, name: "post" });
			const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));
			expect(
				await wrapped.query.users.findMany({
					with: { posts: { columns: { name: true } } },
				}),
			).toEqual([{ id: 1, name: "Ada", posts: [{ name: "post" }] }]);
			expect(await logged()).toEqual(["b"]);
		});

		contractTest(
			"a wrapped open transaction runs before and after around each query, in it",
			async () => {
				await reset();
				await expect(
					db.transaction(async (tx: any) => {
						const wrapped = withMiddleware(tx, () => ({
							before: [insertLog("before")],
							after: [insertLog("after")],
						}));
						await wrapped.execute(insertLog("query"));
						await wrapped.query.users.findMany();
						throw new Error("roll back");
					}),
				).rejects.toThrow("roll back");
				expect(await logged()).toEqual([]);
			},
		);

		contractTest(
			"a nested transaction on a wrapped open transaction runs the middleware",
			async () => {
				await reset();
				await db.transaction(async (tx: any) => {
					const wrapped = withMiddleware(tx, () => ({
						before: [insertLog("before")],
					}));
					await wrapped.transaction(async (savepoint: any) => {
						await savepoint.execute(insertLog("in savepoint"));
					});
				});
				expect(await logged()).toEqual(["before", "in savepoint"]);
			},
		);

		contractTest(
			"a value cannot inject SQL, even with standard_conforming_strings off",
			async () => {
				await reset();
				await db.execute(sql`set standard_conforming_strings = off`);
				try {
					const wrapped = withMiddleware(db, () => ({
						before: [insertLog("b")],
					}));
					const payload = `\\'; DROP TABLE "${schemaName}".victims; --`;
					await wrapped.select().from(t.users).where(eq(t.users.name, payload));
				} finally {
					await db.execute(sql`set standard_conforming_strings = on`);
				}
				const table = await db.execute(
					sql.raw(
						`select to_regclass('"${schemaName}".victims') is not null as ok`,
					),
				);
				expect(Array.from(table.rows ?? table)[0]).toMatchObject({ ok: true });
			},
			"injection",
		);

		contractTest(
			"bytea values keep every byte",
			async () => {
				await reset();
				const data = Buffer.from([0, 1, 39, 92, 255]);
				const [row] = await withMiddleware(db, () => ({
					before: [insertLog("b")],
				}))
					.insert(t.files)
					.values({ data })
					.returning();
				expect(Buffer.from(row.data)).toEqual(data);
			},
			"bytea",
		);

		contractTest(
			"a wrapped query with middleware takes one round trip",
			async () => {
				const target = new URL(url as string);
				const proxy = await startLatencyProxy(
					{ host: target.hostname, port: Number(target.port || 5432) },
					LATENCY_MS,
				);
				const viaProxy = new URL(url as string);
				viaProxy.hostname = "127.0.0.1";
				viaProxy.port = String(proxy.port);
				const slow = driver.connect(viaProxy.toString());
				try {
					const wrapped = withMiddleware(
						drizzleFor(driver, slow.db, t.relations),
						() => ({
							before: [
								sql`select set_config('app.tenant', ${"acme"}, true)`,
								insertLog("before"),
							],
							after: [insertLog("after")],
						}),
					);
					const query = () =>
						wrapped.select().from(t.users).where(eq(t.users.name, "Ada"));
					// Warm up: the connection, and the driver's statement cache.
					await query();
					await query();
					const start = performance.now();
					await query();
					const elapsed = performance.now() - start;
					expect(elapsed).toBeLessThan(LATENCY_MS * 2);
				} finally {
					await slow.close();
					await proxy.close();
				}
			},
			"results by position",
		);
	});
}
