// Behavior that the TCP Postgres drivers have and the other drivers do not:
// session settings, SQL injection, bytea, and one round trip per unit. The
// behavior that all drivers share is in drivers.test.ts.
//
// Runs only when TEST_PG_URL is set, e.g.
//   TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres bun test

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
import { withMiddleware } from "../src/pg.ts";
import { startLatencyProxy } from "./helpers/latency-proxy.ts";

const url = process.env.TEST_PG_URL;
// Enough for a pipelined client to send all its messages before a reply.
const LATENCY_MS = 10;

type Connected = { db: any; close(): Promise<void> };
type DriverCase = {
	name: string;
	/** `max: 1`, so session settings apply to the connection the query uses. */
	connect(url: string): Connected;
	/** False for a driver that has no one-round-trip mechanism (sequential). */
	oneRoundTrip: boolean;
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
		oneRoundTrip: true,
		connect: (u) => {
			const pool = new pg.Pool({ connectionString: u, max: 1 });
			return { db: pool, close: () => pool.end() };
		},
	},
	{
		name: "postgres-js (prepare: true)",
		oneRoundTrip: true,
		connect: (u) => {
			const client = postgres(u, { max: 1, onnotice: () => {} });
			return { db: client, close: () => client.end() };
		},
	},
	{
		name: "postgres-js (prepare: false)",
		oneRoundTrip: true,
		connect: (u) => {
			const client = postgres(u, {
				max: 1,
				prepare: false,
				onnotice: () => {},
			});
			return { db: client, close: () => client.end() };
		},
	},
	{
		name: "Bun SQL",
		oneRoundTrip: true,
		connect: (u) => {
			const client = new SQL({ url: u, max: 1 });
			return { db: client, close: () => client.close() };
		},
	},
	{
		name: "Bun SQL (prepare: false)",
		oneRoundTrip: false,
		connect: (u) => {
			const client = new SQL({ url: u, max: 1, prepare: false });
			return { db: client, close: () => client.close() };
		},
	},
];

function drizzleFor(driver: DriverCase, client: unknown, relations: unknown) {
	if (driver.name === "node-postgres")
		return nodePg({ client: client as pg.Pool, relations: relations as any });
	if (driver.name.startsWith("postgres-js"))
		return postgresJs({ client: client as any, relations: relations as any });
	return bunSql({ client: client as any, relations: relations as any });
}

for (const driver of drivers) {
	describe.skipIf(!url)(driver.name, () => {
		const schemaName = `test_${driver.name.replace(/\W+/g, "_")}_${Date.now()}`;
		const t = makeTables(schemaName);
		let connected: Connected;
		let db: any;

		const insertLog = (v: string) =>
			sql`insert into ${t.log} (v) values (${v})`;

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

		// A unit on a transaction handle would reserve another connection,
		// outside that transaction.
		(driver.name.startsWith("Bun SQL") ? test : test.skip)(
			"a transaction handle as the client is rejected",
			async () => {
				const client = new SQL({ url: url as string, max: 1 });
				try {
					await client.begin(async (tx) => {
						expect(() =>
							withMiddleware(bunSql({ client: tx as SQL }), () => ({})),
						).toThrow("transaction handle");
					});
				} finally {
					await client.close();
				}
			},
		);

		test("transaction-local state reaches the query and is gone after", async () => {
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
		});

		test("raw execute returns the same rows as the unwrapped db", async () => {
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
		});

		test("a value cannot inject SQL, even with standard_conforming_strings off", async () => {
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
		});

		// postgres-js retries a cached statement that the server rejects as out of
		// date. It writes the retry after everything already on the connection,
		// which can be after the unit's COMMIT.
		test("a statement that the driver retries cannot run outside its unit", async () => {
			await reset();
			const name = `retried_${Date.now()}`;
			await db.execute(
				sql.raw(
					`create table "${schemaName}".${name} (id serial primary key, v text, tenant text default current_setting('app.tenant', true))`,
				),
			);
			const retried = pgSchema(schemaName).table(name, {
				id: serial("id").primaryKey(),
				v: text("v"),
				tenant: text("tenant"),
			});
			const wrapped = withMiddleware(db, () => ({
				before: [sql`select set_config('app.tenant', 'acme', true)`],
			}));
			const insert = (v: string) =>
				wrapped.insert(retried).values({ v }).returning({ v: retried.v });
			// The statement is now prepared and cached on the connection.
			await insert("cached");
			// Its result type changes, so the cached plan is out of date.
			await db.execute(
				sql.raw(
					`alter table "${schemaName}".${name} alter column v type varchar(100)`,
				),
			);
			// The unit may fail, as it does with plain Drizzle on some drivers.
			await Promise.resolve(insert("after the change")).catch(() => {});
			// The connection is still usable.
			expect(await wrapped.select().from(t.users)).toEqual([]);
			// No row was written without the unit's middleware.
			expect(
				await db
					.select({ v: retried.v, tenant: retried.tenant })
					.from(retried)
					.where(sql`${retried.tenant} is distinct from 'acme'`),
			).toEqual([]);
		});

		test("bytea values keep every byte", async () => {
			await reset();
			const data = Buffer.from([0, 1, 39, 92, 255]);
			const [row] = await withMiddleware(db, () => ({
				before: [insertLog("b")],
			}))
				.insert(t.files)
				.values({ data })
				.returning();
			expect(Buffer.from(row.data)).toEqual(data);
		});

		type Proxy = Awaited<ReturnType<typeof startLatencyProxy>>;

		/** A db whose connection goes through a proxy that counts round trips. */
		async function withSlowDb(
			body: (slowDb: any, proxy: Proxy) => Promise<void>,
		) {
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
				await body(drizzleFor(driver, slow.db, t.relations), proxy);
			} finally {
				await slow.close();
				await proxy.close();
			}
		}

		const slowMiddleware = () => ({
			before: [
				sql`select set_config('app.tenant', ${"acme"}, true)`,
				insertLog("before"),
			],
			after: [insertLog("after")],
		});

		/** Runs `query` twice to warm up, then checks one round trip. */
		async function expectOneRoundTrip(
			proxy: Proxy,
			query: () => PromiseLike<unknown>,
		) {
			// Warm up: the connection, and the driver's statement cache.
			await query();
			await query();
			proxy.resetRoundTrips();
			await query();
			expect(proxy.roundTrips()).toBe(1);
		}

		(driver.oneRoundTrip ? test : test.skip)(
			"a wrapped query with middleware takes one round trip",
			() =>
				withSlowDb(async (slowDb, proxy) => {
					const wrapped = withMiddleware(slowDb, slowMiddleware);
					await expectOneRoundTrip(proxy, () =>
						wrapped.select().from(t.users).where(eq(t.users.name, "Ada")),
					);
				}),
		);

		// Only the first query carries middleware; later queries in the
		// transaction are plain Drizzle queries.
		(driver.oneRoundTrip ? test : test.skip)(
			"the first query in wrapped.transaction sends before with it, in one round trip",
			() =>
				withSlowDb(async (slowDb, proxy) => {
					const wrapped = withMiddleware(slowDb, slowMiddleware);
					let roundTrips = 0;
					const run = () =>
						wrapped.transaction(async (tx: any) => {
							proxy.resetRoundTrips();
							await tx.select().from(t.users).where(eq(t.users.name, "Ada"));
							roundTrips = proxy.roundTrips();
						});
					// Warm up: the connection, and the driver's statement cache.
					await run();
					await run();
					await run();
					expect(roundTrips).toBe(1);
				}),
		);
	});
}
