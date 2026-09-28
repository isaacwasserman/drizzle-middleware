// the security regression suite. Each test is an audit finding from
// v1 (see docs/design.md, section 11). v2 must pass all of them.

import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { SQL } from "bun";
import { entityKind, eq, sql } from "drizzle-orm-beta";
import { drizzle as bunSqlDrizzle } from "drizzle-orm-beta/bun-sql/sqlite";
import { Cache } from "drizzle-orm-beta/cache/core";
import { bytea, pgTable, serial, text } from "drizzle-orm-beta/pg-core";
import { drizzle } from "drizzle-orm-beta/pglite";
import {
	integer,
	sqliteTable,
	text as stext,
} from "drizzle-orm-beta/sqlite-core";
import { readMember } from "../src/internal/drizzle.ts";
import { withMiddleware as withPgMiddleware } from "../src/pg.ts";
import { withMiddleware as withSqliteMiddleware } from "../src/sqlite.ts";
import { driverTest } from "./helpers/drivers.ts";

const secrets = pgTable("secrets", {
	id: serial("id").primaryKey(),
	v: text("v"),
});
const files = pgTable("files", {
	id: serial("id").primaryKey(),
	data: bytea("data"),
});
const log = pgTable("log", { n: serial("n").primaryKey(), v: text("v") });

async function createDb() {
	const client = new PGlite();
	const db = drizzle({ client });
	await db.execute(sql`create table secrets (id serial primary key, v text)`);
	await db.execute(sql`create table files (id serial primary key, data bytea)`);
	await db.execute(sql`create table log (n serial primary key, v text)`);
	await db.execute(sql`create table victims (x int)`);
	await db.insert(secrets).values({ v: "top secret" });
	return { client, db };
}
const withLog = <T>(db: T) =>
	withPgMiddleware(db as never, () => ({
		before: [sql`insert into log (v) values ('before')`],
	})) as T;

class MemoryCache extends Cache {
	static override readonly [entityKind]: string = "MemoryCache";
	strategy(): "all" {
		return "all";
	}
	override async get(): Promise<undefined> {
		return undefined;
	}
	override async put(): Promise<void> {}
	override async onMutate(): Promise<void> {}
}

describe("security", () => {
	test("a query after toSQL() runs its own SQL, not the previous query", async () => {
		const { db } = await createDb();
		const wrapped = withLog(db);
		wrapped.select().from(secrets).toSQL();
		// Drizzle's migrator and setTransaction() use session.execute().
		const session = readMember(wrapped, "session") as {
			execute(query: unknown): Promise<{ rows: unknown[] }>;
		};
		const result = await session.execute(sql`select 'harmless' as v`);
		expect(result.rows).toEqual([{ v: "harmless" }]);
	});

	test("a value cannot inject SQL, even with standard_conforming_strings off", async () => {
		const { client, db } = await createDb();
		await client.exec("set standard_conforming_strings = off");
		const wrapped = withLog(db);
		const payload = "\\'; DROP TABLE victims; --";
		await wrapped.select().from(secrets).where(eq(secrets.v, payload));
		const table = await client.query<{ ok: boolean }>(
			"select to_regclass('victims') is not null as ok",
		);
		expect(table.rows[0]?.ok).toBe(true);
	});

	test("a db with a Drizzle query cache is rejected", () => {
		const db = drizzle({ client: new PGlite(), cache: new MemoryCache() });
		expect(() => withLog(db)).toThrow("cache");
	});

	test("bytea values keep every byte", async () => {
		const { db } = await createDb();
		const data = Buffer.from([0, 1, 39, 92, 255]);
		const [row] = await withLog(db).insert(files).values({ data }).returning();
		expect(row?.data).toEqual(data);
	});

	test("a raw NaN value reaches the database as NaN", async () => {
		const { db } = await createDb();
		const result = await withLog(db).execute<{ v: number }>(
			sql`select ${Number.NaN}::float8 as v`,
		);
		expect(result.rows[0]?.v).toBeNaN();
	});

	test("a raw Date value gives the same result as on the unwrapped db", async () => {
		const { db } = await createDb();
		const query = sql`select ${new Date(0)}::timestamptz as v`;
		const plain = await db.execute(query);
		const wrapped = await withLog(db).execute(query);
		expect(wrapped.rows).toEqual(plain.rows);
	});

	test("setTransaction() on a wrapped open transaction runs first, without middleware", async () => {
		const { db } = await createDb();
		await db.transaction(async (tx) => {
			const wrapped = withLog(tx);
			await wrapped.setTransaction({ isolationLevel: "serializable" });
			const level = await wrapped.execute<{ level: string }>(
				sql`select current_setting('transaction_isolation') as level`,
			);
			expect(level.rows[0]?.level).toBe("serializable");
		});
	});

	driverTest("BunSQLiteSession")(
		"Bun SQL SQLite: a failing query rejects and rolls back the middleware",
		async () => {
			const users = sqliteTable("users", {
				id: integer("id").primaryKey(),
				name: stext("name"),
			});
			const client = new SQL({ adapter: "sqlite", filename: ":memory:" });
			const db = bunSqlDrizzle({ client });
			await db.run(sql`create table users (id integer primary key, name text)`);
			await db.run(sql`create table log (v text)`);
			await db.insert(users).values({ id: 1, name: "Ada" });
			const wrapped = withSqliteMiddleware(db, () => ({
				before: [sql`insert into log values ('before')`],
			}));
			await expect(
				Promise.resolve(wrapped.insert(users).values({ id: 1, name: "dup" })),
			).rejects.toThrow();
			expect(await db.all(sql`select v from log`)).toEqual([]);
		},
	);

	test("the middleware runs for every query, and only in its own unit", async () => {
		const { db } = await createDb();
		const wrapped = withLog(db);
		await wrapped.select().from(secrets);
		await wrapped.select().from(secrets);
		expect((await db.select({ v: log.v }).from(log)).map((r) => r.v)).toEqual([
			"before",
			"before",
		]);
	});
});
