// Security regressions. Each test is an audit finding from v1 (see
// docs/design.md, section 11).

import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { entityKind, eq, sql } from "drizzle-orm-beta";
import { Cache } from "drizzle-orm-beta/cache/core";
import { bytea, pgTable, serial, text } from "drizzle-orm-beta/pg-core";
import { drizzle } from "drizzle-orm-beta/pglite";
import { readMember } from "../src/internal/drizzle.ts";
import { withMiddleware as withPgMiddleware } from "../src/pg.ts";

const secrets = pgTable("secrets", {
	id: serial("id").primaryKey(),
	v: text("v"),
});
const files = pgTable("files", {
	id: serial("id").primaryKey(),
	data: bytea("data"),
});
const log = pgTable("log", { n: serial("n").primaryKey(), v: text("v") });

// One PGlite database for the file, because each one takes about half a
// second to start. Each test gets an empty schema and the default settings.
const client = new PGlite();
const freshSchema = () =>
	client.exec("reset all; drop schema public cascade; create schema public");

async function createDb() {
	await freshSchema();
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
		const db = drizzle({ client, cache: new MemoryCache() });
		expect(() => withLog(db)).toThrow("cache");
	});

	test("bytea, NaN and Date values give the same result as on the unwrapped db", async () => {
		const { db } = await createDb();
		const data = Buffer.from([0, 1, 39, 92, 255]);
		const [row] = await withLog(db).insert(files).values({ data }).returning();
		expect(row?.data).toEqual(data);
		const query = sql`select ${Number.NaN}::float8 as n, ${new Date(0)}::timestamptz as d`;
		const plain = await db.execute(query);
		expect((await withLog(db).execute(query)).rows).toEqual(plain.rows);
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
});
