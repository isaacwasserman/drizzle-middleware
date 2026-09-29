// withMiddleware (pg) on PGlite: the wrapped db, query results, a wrapped
// open transaction, and the guard.

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { defineRelations, entityKind, eq, sql } from "drizzle-orm-beta";
import {
	PgAsyncDatabase,
	PgDialect,
	integer,
	pgTable,
	serial,
	text,
} from "drizzle-orm-beta/pg-core";
import { drizzle } from "drizzle-orm-beta/pglite";
import { asDrizzleDialect, readMember } from "../src/internal/drizzle.ts";
import { withMiddleware } from "../src/pg.ts";

const users = pgTable("users", {
	id: serial("id").primaryKey(),
	name: text("name").notNull(),
});
const posts = pgTable("posts", {
	id: serial("id").primaryKey(),
	userId: integer("user_id").notNull(),
	title: text("title"),
});
const log = pgTable("log", { n: serial("n").primaryKey(), v: text("v") });
const relations = defineRelations({ users, posts });

// One PGlite database for the file, because each one takes about half a
// second to start. Each test gets an empty schema and the default settings.
const client = new PGlite();
const freshSchema = () =>
	client.exec("reset all; drop schema public cascade; create schema public");

async function createDb() {
	await freshSchema();
	const db = drizzle({ client, relations, schema: { users, posts } });
	await db.execute(
		sql`create table users (id serial primary key, name text not null)`,
	);
	await db.execute(
		sql`create table posts (id serial primary key, user_id integer not null, title text)`,
	);
	await db.execute(sql`create table log (n serial primary key, v text)`);
	return { client, db };
}

async function logged(db: Awaited<ReturnType<typeof createDb>>["db"]) {
	return (await db.select({ v: log.v }).from(log).orderBy(log.n)).map(
		(r) => r.v,
	);
}

const insertLog = (v: string) => sql`insert into log (v) values (${v})`;

describe("withMiddleware (pg)", () => {
	// The spies are on the shared client.
	afterEach(() => mock.restore());

	// -------------------------------------------------------------------
	// The wrapped db
	// -------------------------------------------------------------------

	test("keeps parseRqbJson of the input db", async () => {
		const { db } = await createDb();
		const dialect = readMember(db, "dialect");
		const session = readMember(db, "session");
		const flaggedDb = new (db.constructor as any)(
			dialect,
			session,
			relations,
			undefined,
			true,
		);
		const wrapped = withMiddleware(flaggedDb, () => ({})) as any;
		expect(wrapped.query.users.parseJson).toBe(true);
		const stacked = withMiddleware(wrapped, () => ({})) as any;
		expect(stacked.query.users.parseJson).toBe(true);
		expect((withMiddleware(db, () => ({})) as any).query.users.parseJson).toBe(
			false,
		);
	});

	test("fails closed for a db class with its own constructor", async () => {
		const { db } = await createDb();
		const session = readMember(db, "session");
		// Like `PrismaPgDatabase`: the constructor ignores the session that
		// withMiddleware passes.
		class CustomDb extends (PgAsyncDatabase as any) {
			static readonly [entityKind] = "CustomDb";
			constructor(_client: unknown) {
				super(new PgDialect(), session, {}, undefined);
			}
		}
		expect(() => withMiddleware(new CustomDb({}) as any, () => ({}))).toThrow(
			"cannot wrap CustomDb",
		);
	});

	test("rejects pg-proxy and Xata (no batch and no transactions)", () => {
		const { PgRemoteSession } = require("drizzle-orm-beta/pg-proxy/session");
		const { XataHttpSession } = require("drizzle-orm-beta/xata-http/session");
		const dialect = new PgDialect();
		for (const [Session, kind] of [
			[PgRemoteSession, "PgRemoteSession"],
			[XataHttpSession, "XataHttpSession"],
		]) {
			const db = new (PgAsyncDatabase as any)(
				dialect,
				new Session(() => {}, dialect, {}, undefined, {}),
				{},
				undefined,
			);
			expect(() => withMiddleware(db, () => ({}))).toThrow(
				`not compatible with ${kind}`,
			);
		}
	});

	// -------------------------------------------------------------------
	// Queries
	// -------------------------------------------------------------------

	test("no middleware: the query runs directly, without a transaction", async () => {
		const { client, db } = await createDb();
		await db.insert(users).values({ name: "Ada" });
		const transaction = spyOn(client, "transaction");
		const wrapped = withMiddleware(db, () => ({}));
		expect(await wrapped.select().from(users)).toEqual([
			{ id: 1, name: "Ada" },
		]);
		expect(transaction).not.toHaveBeenCalled();
	});

	test("query values reach the database unchanged", async () => {
		const { db } = await createDb();
		const name = 'it\'s a \\ "test" ☃ $1 --';
		const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));
		await wrapped.insert(users).values({ name });
		expect(
			await wrapped
				.select({ name: users.name })
				.from(users)
				.where(eq(users.name, name)),
		).toEqual([{ name }]);
	});

	test("middleware SQL objects can be reused unchanged", async () => {
		const { db } = await createDb();
		const before = insertLog("shared");
		const wrapped = withMiddleware(db, () => ({ before: [before] }));
		await wrapped.select().from(users);
		await wrapped.select().from(users);
		// The shared object still compiles to a parameterized query.
		const query = asDrizzleDialect(readMember(db, "dialect")).sqlToQuery(
			before,
		);
		expect(query.sql).toBe("insert into log (v) values ($1)");
		expect(query.params).toEqual(["shared"]);
		expect(await logged(db)).toEqual(["shared", "shared"]);
	});

	test("a left join without a match maps the joined table to null", async () => {
		const { db } = await createDb();
		await db.insert(users).values({ name: "Ada" });
		const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));
		expect(
			await wrapped
				.select()
				.from(users)
				.leftJoin(posts, eq(posts.userId, users.id)),
		).toEqual([{ users: { id: 1, name: "Ada" }, posts: null }]);
	});

	test("transaction-local state from before is visible to the query", async () => {
		const { db } = await createDb();
		await db.insert(users).values({ name: "Ada" });
		const wrapped = withMiddleware(db, () => ({
			before: [sql`select set_config('app.tenant', 'acme', true)`],
		}));
		expect(
			await wrapped
				.select({
					name: users.name,
					tenant: sql<string>`current_setting('app.tenant')`,
				})
				.from(users),
		).toEqual([{ name: "Ada", tenant: "acme" }]);
	});

	test("raw execute returns the same result as the unwrapped db", async () => {
		const { db } = await createDb();
		await db.insert(users).values({ name: "Ada" });
		const query = sql`select id, name from users`;
		const plain = await db.execute(query);
		const wrapped = await withMiddleware(db, () => ({
			before: [insertLog("b")],
		})).execute(query);
		expect(wrapped.rows).toEqual(plain.rows);
		expect(wrapped.fields).toEqual(plain.fields);
	});

	// -------------------------------------------------------------------
	// Transactions
	// -------------------------------------------------------------------

	test("setTransaction() on a tx kept after its transaction ends throws", async () => {
		const { db } = await createDb();
		let kept: any;
		await withMiddleware(db, () => ({
			before: [insertLog("b")],
		})).transaction(async (tx) => {
			kept = tx;
		});
		expect(() => kept.setTransaction({ accessMode: "read only" })).toThrow(
			"the transaction has ended",
		);
	});

	test("wrapped.transaction forwards the transaction config", async () => {
		const { db } = await createDb();
		const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));
		const level = await wrapped.transaction(
			async (tx) =>
				(
					await tx.execute<{ level: string }>(
						sql`select current_setting('transaction_isolation') as level`,
					)
				).rows[0]?.level,
			{ isolationLevel: "serializable" },
		);
		expect(level).toBe("serializable");
	});

	// Most drivers do not show when a transaction ends, so a wrapped
	// transaction could send units after its end. The types reject a
	// transaction too; this is for callers without types.
	test("rejects a transaction, raw or from a wrapped db", async () => {
		const { db } = await createDb();
		await db.transaction(async (tx) => {
			expect(() => withMiddleware(tx as never, () => ({}))).toThrow(TypeError);
		});
		await withMiddleware(db, () => ({})).transaction(async (tx) => {
			expect(() => withMiddleware(tx as never, () => ({}))).toThrow(TypeError);
		});
	});

	// -------------------------------------------------------------------
	// Fail-closed guard
	// -------------------------------------------------------------------

	test("unknown prepared-query members are blocked", async () => {
		const { db } = await createDb();
		const prepared = withMiddleware(db, () => ({}))
			.select()
			.from(users)
			.prepare("test_guard") as unknown as Record<string, unknown>;
		expect(() => prepared.client).toThrow("blocked access to `client`");
		expect(() => prepared.queryWithCache).toThrow(
			"blocked access to `queryWithCache`",
		);
	});
});
