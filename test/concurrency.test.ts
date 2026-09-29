// Many units at once. Each unit sets its own tenant in `before` and reads it
// back in the query, so any mix-up between units shows as a wrong tenant.
// The sync SQLite drivers cannot run units concurrently, so they are not here.
//
// The real-driver cases run only when TEST_PG_URL is set.

import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { SQL } from "bun";
import { sql } from "drizzle-orm-beta";
import { drizzle as bunSql } from "drizzle-orm-beta/bun-sql";
import { drizzle as bunSqlSqlite } from "drizzle-orm-beta/bun-sql/sqlite";
import { drizzle as nodePg } from "drizzle-orm-beta/node-postgres";
import { drizzle as pglite } from "drizzle-orm-beta/pglite";
import { drizzle as postgresJs } from "drizzle-orm-beta/postgres-js";
import pg from "pg";
import postgres from "postgres";
import { withMiddleware as withPg } from "../src/pg.ts";
import { withMiddleware as withSqlite } from "../src/sqlite.ts";

const url = process.env.TEST_PG_URL;

/** One database under test, and how a unit sets and reads its tenant. */
interface Target {
	name: string;
	open(): Promise<{ db: any; close(): Promise<void> }>;
	wrap(db: any, tenant: string, fail?: boolean): any;
	/** The query that reads the tenant that `before` set. */
	readTenant(db: any): Promise<unknown>;
}

const pgTenant = (db: any) =>
	db
		.execute(sql`select current_setting('app.tenant', true) as tenant`)
		.then((r: any) => Array.from(r.rows ?? r)[0] as { tenant: string });

const pgTarget = (
	name: string,
	open: () => Promise<{ db: any; close(): Promise<void> }>,
): Target => ({
	name,
	open,
	wrap: (db, tenant, fail) =>
		withPg(db, () => ({
			before: [sql`select set_config('app.tenant', ${tenant}, true)`],
			after: fail ? [sql`select 1/0`] : [],
		})),
	readTenant: async (db) => (await pgTenant(db)).tenant,
});

const pgUrlTargets: Target[] = url
	? [
			pgTarget("node-postgres", async () => {
				const pool = new pg.Pool({ connectionString: url, max: 10 });
				return { db: nodePg({ client: pool }), close: () => pool.end() };
			}),
			// One connection: Drizzle opens transactions on the shared client.
			pgTarget("node-postgres (pg.Client)", async () => {
				const client = new pg.Client({ connectionString: url });
				await client.connect();
				return { db: nodePg({ client }), close: () => client.end() };
			}),
			pgTarget("postgres-js (prepare: true)", async () => {
				const client = postgres(url, { max: 10, onnotice: () => {} });
				return { db: postgresJs({ client }), close: () => client.end() };
			}),
			pgTarget("postgres-js (prepare: false)", async () => {
				const client = postgres(url, {
					max: 10,
					prepare: false,
					onnotice: () => {},
				});
				return { db: postgresJs({ client }), close: () => client.end() };
			}),
			pgTarget("Bun SQL", async () => {
				const client = new SQL({ url, max: 10 });
				return { db: bunSql({ client }), close: () => client.close() };
			}),
			// One connection: Drizzle opens transactions on the reserved connection.
			pgTarget("Bun SQL (reserved connection)", async () => {
				const pool = new SQL({ url, max: 10 });
				const reserved = await pool.reserve();
				return {
					db: bunSql({ client: reserved }),
					close: async () => {
						reserved.release();
						await pool.close();
					},
				};
			}),
			pgTarget("Bun SQL (prepare: false)", async () => {
				const client = new SQL({ url, max: 10, prepare: false });
				return { db: bunSql({ client }), close: () => client.close() };
			}),
		]
	: [];

const targets: Target[] = [
	pgTarget("PGlite", async () => {
		const client = new PGlite();
		return { db: pglite({ client }), close: () => client.close() };
	}),
	...pgUrlTargets,
	{
		name: "Bun SQL SQLite",
		open: async () => {
			const client = new SQL({ adapter: "sqlite", filename: ":memory:" });
			const db = bunSqlSqlite({ client });
			await db.run(sql`create table ctx (tenant text not null)`);
			return { db, close: () => client.close() };
		},
		// SQLite has no session settings: `before` writes the tenant into a
		// table, and `after` removes it. Only the unit's own row is visible,
		// or the units are not isolated.
		wrap: (db, tenant, fail) =>
			withSqlite(db, () => ({
				before: [sql`insert into ctx (tenant) values (${tenant})`],
				after: [
					sql`delete from ctx where tenant = ${tenant}`,
					...(fail ? [sql`insert into ctx (tenant) values (null)`] : []),
				],
			})),
		readTenant: async (db) => {
			const rows = await db.all(sql`select tenant from ctx`);
			return rows.length === 1 ? rows[0].tenant : `rows: ${rows.length}`;
		},
	},
];

for (const target of targets) {
	describe(`concurrency: ${target.name}`, () => {
		test("concurrent units each see only their own before", async () => {
			const { db, close } = await target.open();
			try {
				const tenants = Array.from({ length: 200 }, (_, i) => `t${i}`);
				const seen = await Promise.all(
					tenants.map((t) => target.readTenant(target.wrap(db, t))),
				);
				expect(seen).toEqual(tenants);
			} finally {
				await close();
			}
		});

		test("failing units do not affect the others, and leave the pool usable", async () => {
			const { db, close } = await target.open();
			try {
				const tenants = Array.from({ length: 100 }, (_, i) => `t${i}`);
				const settled = await Promise.allSettled(
					tenants.map((t, i) =>
						target.readTenant(target.wrap(db, t, i % 5 === 0)),
					),
				);
				settled.forEach((s, i) => {
					if (i % 5 === 0) expect(s.status).toBe("rejected");
					else expect(s).toEqual({ status: "fulfilled", value: tenants[i] });
				});
				// No connection is left stuck or in a transaction.
				const after = await Promise.all(
					tenants
						.slice(0, 30)
						.map((t) => target.readTenant(target.wrap(db, `again ${t}`))),
				);
				expect(after).toEqual(tenants.slice(0, 30).map((t) => `again ${t}`));
			} finally {
				await close();
			}
		});

		test("concurrent transactions each see their own before in every query", async () => {
			const { db, close } = await target.open();
			try {
				const tenants = Array.from({ length: 30 }, (_, i) => `t${i}`);
				const seen = await Promise.all(
					tenants.map((t) =>
						target
							.wrap(db, t)
							.transaction(async (tx: any) => [
								await target.readTenant(tx),
								await target.readTenant(tx),
								await target.readTenant(tx),
							]),
					),
				);
				expect(seen).toEqual(tenants.map((t) => [t, t, t]));
			} finally {
				await close();
			}
		});

		test("concurrent queries in one transaction all wait for before", async () => {
			const { db, close } = await target.open();
			try {
				const seen = await target
					.wrap(db, "shared")
					.transaction((tx: any) =>
						Promise.all(
							Array.from({ length: 10 }, () => target.readTenant(tx)),
						),
					);
				expect(seen).toEqual(Array.from({ length: 10 }, () => "shared"));
			} finally {
				await close();
			}
		});
	});
}
