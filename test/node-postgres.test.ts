import { Database } from "bun:sqlite";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	DrizzleQueryError,
	type Logger,
	TransactionRollbackError,
	defineRelations,
	eq,
	getTableName,
	sql,
} from "drizzle-orm-beta";
import { drizzle as drizzleSqlite } from "drizzle-orm-beta/bun-sqlite";
import { Cache, hashQuery } from "drizzle-orm-beta/cache/core";
import { drizzle } from "drizzle-orm-beta/node-postgres";
import {
	bigint,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
} from "drizzle-orm-beta/pg-core";
import pg from "pg";
import {
	type Middleware,
	MiddlewareError,
	withMiddleware,
} from "../src/node-postgres.ts";
import { DATABASE_URL, startProxy } from "./helpers.ts";

const users = pgTable("mw_users", {
	id: serial().primaryKey(),
	name: text().notNull(),
	tags: text().array(),
	meta: jsonb(),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).defaultNow(),
});
const posts = pgTable("mw_posts", {
	id: serial().primaryKey(),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id),
	title: text().notNull(),
});
const log = pgTable("mw_log", {
	id: serial().primaryKey(),
	stage: text().notNull(),
	tenant: text(),
	txid: bigint({ mode: "number" }).notNull(),
});
const parent = pgTable("mw_parent", { id: integer().primaryKey() });
const child = pgTable("mw_child", {
	id: integer().primaryKey(),
	parentId: integer("parent_id").notNull(),
});
const relations = defineRelations({ users, posts }, (r) => ({
	users: { posts: r.many.posts() },
	posts: {
		author: r.one.users({ from: r.posts.userId, to: r.users.id }),
	},
}));

/** A Drizzle cache in memory, with table invalidation. */
class MemoryCache extends Cache {
	readonly entries = new Map<string, { value: any; tables: string[] }>();
	readonly keys: string[] = [];
	readonly mutations: string[][] = [];
	constructor(private readonly mode: "all" | "explicit" = "all") {
		super();
	}
	override strategy() {
		return this.mode;
	}
	override async get(key: string): Promise<any[] | undefined> {
		return this.entries.get(key)?.value;
	}
	override async put(key: string, value: unknown, tables: string[]) {
		this.keys.push(key);
		this.entries.set(key, { value, tables });
	}
	override async onMutate(params: { tables?: string | string[] | any }) {
		const tables = [params.tables ?? []]
			.flat()
			.map((t: any) => (typeof t === "string" ? t : getTableName(t)));
		this.mutations.push(tables);
		for (const [key, entry] of this.entries) {
			if (entry.tables.some((t) => tables.includes(t)))
				this.entries.delete(key);
		}
	}
}

const tenantBefore = (tenant: string) =>
	sql`select set_config('app.tenant', ${tenant}, true)`;
const logBefore = sql`insert into mw_log (stage, tenant) values ('before', current_setting('app.tenant', true))`;
const logAfter = sql`insert into mw_log (stage) values ('after')`;

const auditing: Middleware = () => ({
	before: [tenantBefore("acme"), logBefore],
	after: [logAfter],
});

let proxy: Awaited<ReturnType<typeof startProxy>>;
let pool: pg.Pool;
let plain: ReturnType<typeof makeDb>;

function makeDb(p: pg.Pool, logger?: Logger) {
	return drizzle({ client: p, relations, logger });
}

async function logRows() {
	return plain.select().from(log).orderBy(log.id);
}

beforeAll(async () => {
	proxy = await startProxy(DATABASE_URL);
	pool = new pg.Pool({ connectionString: proxy.url, max: 1 });
	plain = makeDb(pool);
	await plain.execute(sql`
		drop table if exists mw_posts, mw_users, mw_log, mw_child, mw_parent cascade;
		create table mw_users (
			id serial primary key,
			name text not null,
			tags text[],
			meta jsonb,
			created_at timestamptz default now()
		);
		create table mw_posts (
			id serial primary key,
			user_id integer not null references mw_users(id),
			title text not null
		);
		create table mw_log (
			id serial primary key,
			stage text not null,
			tenant text,
			txid bigint not null default txid_current()
		);
		create table mw_parent (id integer primary key);
		create table mw_child (
			id integer primary key,
			parent_id integer not null references mw_parent(id) deferrable initially deferred
		);
	`);
});

beforeEach(async () => {
	await plain.execute(
		sql`truncate mw_posts, mw_users, mw_log, mw_child, mw_parent restart identity cascade`,
	);
});

afterAll(async () => {
	await pool.end();
	await proxy.close();
});

describe("withMiddleware accepts only a node-postgres db with a pg.Pool", () => {
	test("rejects drizzle.mock()", () => {
		expect(() => withMiddleware(drizzle.mock() as any, auditing)).toThrow(
			/pg\.Pool/,
		);
	});

	test("rejects a db with a pg.Client", () => {
		const client = new pg.Client({ connectionString: DATABASE_URL });
		const db = drizzle({ client });
		expect(() => withMiddleware(db as any, auditing)).toThrow(
			/only a db that uses a pg\.Pool/,
		);
	});

	test("rejects a db from another driver", () => {
		const db = drizzleSqlite({ client: new Database(":memory:") });
		expect(() => withMiddleware(db as any, auditing)).toThrow(
			/only a db from drizzle-orm\/node-postgres/,
		);
	});

	test("rejects a transaction of a db with a pg.Client", async () => {
		const client = new pg.Client({ connectionString: DATABASE_URL });
		await client.connect();
		const db = drizzle({ client });
		await db.transaction(async (tx) => {
			expect(() => withMiddleware(tx, auditing)).toThrow(
				/only a transaction on a client from a pg\.Pool/,
			);
		});
		await client.end();
	});

	test("rejects a transaction of a db with middleware", async () => {
		await withMiddleware(plain, auditing).transaction(async (tx) => {
			expect(() => withMiddleware(tx, auditing)).toThrow(
				/from a db with middleware/,
			);
		});
	});

	test("rejects a transaction of a db with middleware, also when the middleware is empty", async () => {
		await withMiddleware(plain, () => ({})).transaction(async (tx) => {
			expect(() => withMiddleware(tx, auditing)).toThrow(
				/from a db with middleware/,
			);
			await tx.transaction(async (nested) => {
				expect(() => withMiddleware(nested, auditing)).toThrow(
					/from a db with middleware/,
				);
			});
		});
	});

	test("rejects a db that already has middleware", () => {
		const db = withMiddleware(plain, auditing);
		expect(() => withMiddleware(db, auditing)).toThrow(
			/already has middleware/,
		);
	});

	test("rejects a cache option that is not a boolean", () => {
		expect(() => withMiddleware(plain, auditing, { cache: 1 as any })).toThrow(
			/must be a boolean/,
		);
	});

	test("rejects a middleware that is not a function", () => {
		expect(() => withMiddleware(plain, {} as any)).toThrow(
			/must be a function/,
		);
	});

	test("$client is the app's pool", () => {
		expect(withMiddleware(plain, auditing).$client).toBe(pool);
	});

	test("the db gives Drizzle a client with only query()", () => {
		const db = withMiddleware(plain, auditing);
		expect(() => (db as any).session.client.connect).toThrow(/client\.connect/);
	});
});

describe("a query outside a transaction", () => {
	test("runs BEGIN; before; query; after; COMMIT in one transaction", async () => {
		const db = withMiddleware(plain, auditing);
		const {
			rows: [row],
		} = await db.execute<{ tenant: string; txid: string }>(
			sql`select current_setting('app.tenant', true) as tenant, txid_current()::text as txid`,
		);
		expect(row?.tenant).toBe("acme");
		const rows = await logRows();
		expect(rows.map((r) => [r.stage, r.tenant])).toEqual([
			["before", "acme"],
			["after", null],
		]);
		expect(rows[0]?.txid).toBe(Number(row?.txid));
		expect(rows[1]?.txid).toBe(Number(row?.txid));
	});

	test("set_config(..., true) does not stay on the connection", async () => {
		const db = withMiddleware(plain, auditing);
		await db.select().from(users);
		const {
			rows: [row],
		} = await plain.execute<{ tenant: string | null }>(
			sql`select current_setting('app.tenant', true) as tenant`,
		);
		expect(row?.tenant ?? "").toBe("");
	});

	test("each kind of query uses one round trip", async () => {
		const db = withMiddleware(plain, auditing);
		await plain.insert(users).values({ name: "a" });
		await plain.insert(posts).values({ userId: 1, title: "t" });
		const queries: Array<() => Promise<unknown>> = [
			() => db.select().from(users),
			() => db.select().from(users).where(eq(users.id, 1)),
			() =>
				db.select().from(users).innerJoin(posts, eq(posts.userId, users.id)),
			() => db.insert(users).values({ name: "b" }).returning(),
			() => db.update(users).set({ name: "c" }).where(eq(users.id, 2)),
			() => db.delete(users).where(eq(users.id, 2)),
			() => db.query.users.findMany({ with: { posts: true } }),
			() => db.$count(users),
			() => db.execute(sql`select 1`),
		];
		for (const query of queries) {
			expect(await proxy.count(query)).toBe(1);
		}
	});

	test("gives the same results as plain Drizzle", async () => {
		const db = withMiddleware(plain, auditing);
		await plain.insert(users).values([
			{ name: "a", tags: ["x", "y"], meta: { n: 1, list: [true] } },
			{ name: "b", tags: [], meta: null },
		]);
		await plain.insert(posts).values([
			{ userId: 1, title: "p1" },
			{ userId: 1, title: "p2" },
		]);
		const reads = (d: typeof plain) => [
			() => d.select().from(users).orderBy(users.id),
			() =>
				d
					.select({ user: users, post: posts })
					.from(users)
					.leftJoin(posts, eq(posts.userId, users.id))
					.orderBy(users.id, posts.id),
			() =>
				d.query.users.findMany({
					with: { posts: { orderBy: { id: "asc" } } },
					orderBy: { id: "asc" },
				}),
			() =>
				d.query.posts.findFirst({ with: { author: true }, where: { id: 2 } }),
			() => d.$count(posts, eq(posts.userId, 1)),
			() => d.execute(sql`select ${42}::int as n, ${"x"} as s`),
			() =>
				d
					.select()
					.from(users)
					.where(eq(users.id, sql.placeholder("id")))
					.prepare("by_id")
					.execute({ id: 1 }),
		];
		const expected = await Promise.all(reads(plain).map((read) => read()));
		const actual = await Promise.all(reads(db).map((read) => read()));
		expect(actual).toEqual(expected);
	});

	test("writes return the same results as plain Drizzle", async () => {
		const db = withMiddleware(plain, auditing);
		const inserted = await db
			.insert(users)
			.values({ name: "a", tags: ["t"], meta: { k: "v" } })
			.returning();
		expect(inserted).toEqual([
			{
				id: 1,
				name: "a",
				tags: ["t"],
				meta: { k: "v" },
				createdAt: expect.any(String),
			},
		]);
		const updated = await db
			.update(users)
			.set({ name: "b" })
			.where(eq(users.id, 1))
			.returning({ name: users.name });
		expect(updated).toEqual([{ name: "b" }]);
		const result = await db.delete(users).where(eq(users.id, 1));
		expect(result.rowCount).toBe(1);
		expect(result.command).toBe("DELETE");
	});

	test("a failed query commits nothing and throws as plain Drizzle does", async () => {
		const db = withMiddleware(plain, auditing);
		const error = await db
			.insert(posts)
			.values({ userId: 999, title: "x" })
			.catch((e) => e);
		expect(error).toBeInstanceOf(DrizzleQueryError);
		expect(error.cause).toBeInstanceOf(pg.DatabaseError);
		expect(error.cause.code).toBe("23503");
		expect(await logRows()).toEqual([]);
	});

	test("a failed before statement stops the query", async () => {
		const db = withMiddleware(plain, () => ({
			before: [logBefore, sql`select 1/0`],
		}));
		const error = await db
			.insert(users)
			.values({ name: "a" })
			.catch((e) => e);
		expect(error.cause).toBeInstanceOf(MiddlewareError);
		expect(error.cause.stage).toBe("before");
		expect(error.cause.index).toBe(1);
		expect(error.cause.cause.code).toBe("22012");
		expect(await plain.select().from(users)).toEqual([]);
		expect(await logRows()).toEqual([]);
	});

	test("a failed after statement undoes the query", async () => {
		const db = withMiddleware(plain, () => ({ after: [sql`select 1/0`] }));
		const error = await db
			.insert(users)
			.values({ name: "a" })
			.catch((e) => e);
		expect(error.cause).toBeInstanceOf(MiddlewareError);
		expect(error.cause.stage).toBe("after");
		expect(await plain.select().from(users)).toEqual([]);
	});

	test("a failed COMMIT throws and commits nothing", async () => {
		const db = withMiddleware(plain, auditing);
		const error = await db
			.insert(child)
			.values({ id: 1, parentId: 1 })
			.catch((e) => e);
		expect(error.cause).toBeInstanceOf(MiddlewareError);
		expect(error.cause.stage).toBe("commit");
		expect(error.cause.cause.code).toBe("23503");
		expect(await plain.select().from(child)).toEqual([]);
		expect(await logRows()).toEqual([]);
	});

	test("a value that cannot be serialized sends nothing", async () => {
		const db = withMiddleware(plain, auditing);
		const bad = {
			toPostgres() {
				throw new Error("cannot serialize");
			},
		};
		let error: any;
		const trips = await proxy.count(async () => {
			error = await db.execute(sql`select ${bad}`).catch((e) => e);
		});
		expect(error.cause.message).toBe("cannot serialize");
		expect(trips).toBe(0);
		expect(await logRows()).toEqual([]);
	});

	test("named prepared statements work, and a reused name sends nothing", async () => {
		const db = withMiddleware(plain, auditing);
		await plain.insert(users).values([{ name: "a" }, { name: "b" }]);
		const byId = db
			.select({ name: users.name })
			.from(users)
			.where(eq(users.id, sql.placeholder("id")))
			.prepare("mw_by_id");
		expect(await byId.execute({ id: 1 })).toEqual([{ name: "a" }]);
		expect(await byId.execute({ id: 2 })).toEqual([{ name: "b" }]);

		const other = db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.name, sql.placeholder("name")))
			.prepare("mw_by_id");
		let error: any;
		const trips = await proxy.count(async () => {
			error = await other.execute({ name: "a" }).catch((e) => e);
		});
		expect(error.cause.message).toMatch(/'mw_by_id' is already used/);
		expect(trips).toBe(0);
		expect(await logRows()).toHaveLength(4);
	});

	test.each([
		"commit",
		"COMMIT AND CHAIN",
		"  /* a /* nested */ comment */ -- line\n Commit",
		"end",
		"abort",
		"rollback",
		"rollback work and no chain",
		"rollback prepared 'x'",
		"begin",
		"start transaction",
		"prepare transaction 'x'",
		";commit",
		" ; /* x */ ;; rollback",
	])("rejects the transaction control statement %p", async (text) => {
		const db = withMiddleware(plain, auditing);
		const error = await db.execute(sql.raw(text)).catch((e) => e);
		expect(error.cause.message).toMatch(
			/is not allowed through a db with middleware/,
		);
		expect(await logRows()).toEqual([]);
	});

	test("rejects COPY, which would stop the pipeline", async () => {
		const db = withMiddleware(plain, auditing);
		for (const text of [
			"copy mw_users (name) from stdin",
			"; COPY mw_users to stdout",
		]) {
			const error = await db.execute(sql.raw(text)).catch((e) => e);
			expect(error.cause.message).toMatch(/COPY is not allowed/);
		}
		const error = await db
			.transaction((tx) => tx.execute(sql`copy mw_users (name) from stdin`))
			.catch((e) => e);
		expect(error.cause.message).toMatch(/COPY is not allowed/);
		expect(pool.idleCount).toBe(1);
	});

	test("app type parsers do not apply to middleware results", async () => {
		const numeric = pg.types.builtins.NUMERIC;
		const original = pg.types.getTypeParser(numeric, "text");
		pg.types.setTypeParser(numeric, () => {
			throw new Error("strict parser");
		});
		try {
			const db = withMiddleware(plain, () => ({
				before: [logBefore],
				after: [sql`select 0.5::numeric`],
			}));
			await db.insert(users).values({ name: "a" });
			expect(await logRows()).toHaveLength(1);
		} finally {
			pg.types.setTypeParser(numeric, original);
		}
	});

	test("rejects transaction control in before and after", async () => {
		for (const middleware of [
			() => ({ before: [sql`commit`] }),
			() => ({ after: [sql`end`] }),
		]) {
			const db = withMiddleware(plain, middleware);
			const error = await db
				.select()
				.from(users)
				.catch((e) => e);
			expect(error.cause.message).toMatch(/is not allowed/);
		}
	});

	test("a text with a second statement fails and commits nothing", async () => {
		const db = withMiddleware(plain, auditing);
		const error = await db
			.execute(sql`insert into mw_users (name) values ('a'); commit`)
			.catch((e) => e);
		expect(error.cause.code).toBe("42601");
		expect(await plain.select().from(users)).toEqual([]);
		expect(await logRows()).toEqual([]);
	});

	test("calls the middleware once for each query", async () => {
		let calls = 0;
		const db = withMiddleware(plain, () => {
			calls++;
			return { before: [tenantBefore("t")] };
		});
		await db.select().from(users);
		await db.select().from(users);
		expect(calls).toBe(2);
	});

	test("a middleware that throws sends nothing", async () => {
		const db = withMiddleware(plain, () => {
			throw new Error("no tenant");
		});
		let error: any;
		const trips = await proxy.count(async () => {
			error = await db
				.select()
				.from(users)
				.catch((e) => e);
		});
		expect(error.cause.message).toBe("no tenant");
		expect(trips).toBe(0);
	});

	test("rejects a middleware result that is not SQL", async () => {
		const db = withMiddleware(plain, () => ({ before: ["select 1" as any] }));
		const error = await db
			.select()
			.from(users)
			.catch((e) => e);
		expect(error.cause.message).toMatch(/before\[0\] is not a Drizzle SQL/);
	});

	test("empty middleware runs the query as plain Drizzle does", async () => {
		const db = withMiddleware(plain, () => ({}));
		expect(await proxy.count(() => db.select().from(users))).toBe(1);
		// Plain Drizzle sends a text without parameters as a simple query.
		const result: any = await db.execute(sql`select 1 as a; select 2 as b`);
		expect(result.map((r: any) => r.rows)).toEqual([[{ a: 1 }], [{ b: 2 }]]);
	});

	test("concurrent queries each see their own middleware", async () => {
		const wide = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
		const base = makeDb(wide);
		const tenants = Array.from({ length: 30 }, (_, i) => `t${i}`);
		const results = await Promise.all(
			tenants.map((tenant) =>
				withMiddleware(base, () => ({
					before: [tenantBefore(tenant)],
				})).execute<{
					tenant: string;
				}>(
					sql`select pg_sleep(0.001), current_setting('app.tenant', true) as tenant`,
				),
			),
		);
		expect(results.map((r) => r.rows[0]?.tenant)).toEqual(tenants);
		await wide.end();
	});

	test("the client goes back to the pool idle after failures", async () => {
		const db = withMiddleware(plain, auditing);
		for (let i = 0; i < 3; i++) {
			await db.execute(sql`select 1/0`).catch(() => {});
			await db
				.insert(child)
				.values({ id: i, parentId: 1 })
				.catch(() => {});
		}
		expect(pool.totalCount).toBe(1);
		expect(pool.idleCount).toBe(1);
		const {
			rows: [row],
		} = await plain.execute<{ status: string }>(
			sql`select current_setting('app.tenant', true) as status`,
		);
		expect(row?.status ?? "").toBe("");
		expect(await logRows()).toEqual([]);
	});

	// query_timeout acts only on the client: the server has the whole unit and
	// commits it, as it would commit a plain query.
	test("a client-side timeout destroys the client; the unit stays whole", async () => {
		const timed = new pg.Pool({
			connectionString: DATABASE_URL,
			max: 1,
			query_timeout: 200,
		});
		const db = withMiddleware(makeDb(timed), auditing);
		const error = await db.execute(sql`select pg_sleep(1)`).catch((e) => e);
		expect(String(error.cause?.message ?? error.message)).toMatch(/timeout/i);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(timed.totalCount).toBe(0);
		const rows = await logRows();
		expect(rows.map((r) => r.stage)).toEqual(["before", "after"]);
		expect(rows[0]?.txid).toBe(rows[1]?.txid as number);
		await timed.end();
	});

	describe("a connection that the server ends", () => {
		beforeAll(async () => {
			await plain.execute(sql`
				drop table if exists mw_slow;
				create table mw_slow (v int);
				create or replace function mw_slow_fn() returns trigger language plpgsql
					as $$ begin perform pg_sleep(2); return null; end $$;
				create constraint trigger mw_slow_t after insert on mw_slow
					deferrable initially deferred for each row execute function mw_slow_fn();
			`);
		});

		async function killDuring(
			run: (db: ReturnType<typeof makeDb>) => Promise<unknown>,
		) {
			const name = `mw_kill_${Math.random().toString(36).slice(2)}`;
			const victim = new pg.Pool({
				connectionString: DATABASE_URL,
				max: 1,
				application_name: name,
			});
			// Ends the victim's backend once it runs the statement that sleeps.
			const kill = (async () => {
				for (let i = 0; i < 200; i++) {
					const { rows } = await plain.execute<{ killed: boolean }>(
						sql`select pg_terminate_backend(pid) as killed from pg_stat_activity
							where application_name = ${name} and state = 'active' and wait_event = 'PgSleep'`,
					);
					if (rows[0]?.killed) return;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				throw new Error("the victim's backend was not found");
			})();
			const error: any = await run(makeDb(victim)).catch((e) => e);
			await kill;
			const counts = [victim.totalCount, victim.idleCount];
			await victim.end();
			return { error, counts };
		}

		test("during the query: rejects and destroys the client", async () => {
			const { error, counts } = await killDuring((db) =>
				withMiddleware(db, auditing).execute(sql`select pg_sleep(2)`),
			);
			expect(error.cause.message).toMatch(/terminating connection/);
			expect(counts).toEqual([0, 0]);
		});

		test("during COMMIT: rejects and destroys the client", async () => {
			const { error, counts } = await killDuring((db) =>
				withMiddleware(db, auditing).execute(
					sql`insert into mw_slow values (1)`,
				),
			);
			expect(error.cause).toBeInstanceOf(MiddlewareError);
			expect(error.cause.stage).toBe("commit");
			expect(counts).toEqual([0, 0]);
		});

		test("during a transaction's COMMIT: rejects and destroys the client", async () => {
			const { error, counts } = await killDuring((db) =>
				withMiddleware(db, auditing).transaction(async (tx) => {
					await tx.execute(sql`insert into mw_slow values (1)`);
				}),
			);
			expect(error).toBeInstanceOf(MiddlewareError);
			expect(error.stage).toBe("commit");
			expect(counts).toEqual([0, 0]);
		});
	});

	test("the logger sees only the app's query", async () => {
		const logged: string[] = [];
		const db = withMiddleware(
			makeDb(pool, { logQuery: (query) => logged.push(query) }),
			auditing,
		);
		await db.select({ id: users.id }).from(users);
		expect(logged).toEqual(['select "id" from "mw_users"']);
	});
});

describe("db.transaction()", () => {
	test("runs before after BEGIN and after before COMMIT, in one transaction", async () => {
		const db = withMiddleware(plain, auditing);
		const txid = await db.transaction(async (tx) => {
			await tx
				.insert(log)
				.values({ stage: "query", txid: sql`txid_current()` });
			const {
				rows: [row],
			} = await tx.execute<{ tenant: string; txid: string }>(
				sql`select current_setting('app.tenant', true) as tenant, txid_current()::text as txid`,
			);
			expect(row?.tenant).toBe("acme");
			return Number(row?.txid);
		});
		const rows = await logRows();
		expect(rows.map((r) => r.stage)).toEqual(["before", "query", "after"]);
		expect(rows.every((r) => r.txid === txid)).toBe(true);
	});

	test("the middleware adds no round trips", async () => {
		const db = withMiddleware(plain, auditing);
		const none = await proxy.count(() => db.transaction(async () => {}));
		const one = await proxy.count(() =>
			db.transaction(async (tx) => {
				await tx.select().from(users);
			}),
		);
		const two = await proxy.count(() =>
			db.transaction(async (tx) => {
				await tx.select().from(users);
				await tx.insert(users).values({ name: "a" });
			}),
		);
		expect([none, one, two]).toEqual([1, 2, 3]);
	});

	test("a transaction without queries still runs the middleware", async () => {
		const db = withMiddleware(plain, auditing);
		await db.transaction(async () => {});
		expect((await logRows()).map((r) => r.stage)).toEqual(["before", "after"]);
	});

	test("an error in the callback rolls back everything", async () => {
		const db = withMiddleware(plain, auditing);
		const error = await db
			.transaction(async (tx) => {
				await tx.insert(users).values({ name: "a" });
				throw new Error("app error");
			})
			.catch((e) => e);
		expect(error.message).toBe("app error");
		expect(await plain.select().from(users)).toEqual([]);
		expect(await logRows()).toEqual([]);
	});

	test("an error before the first query sends nothing", async () => {
		const db = withMiddleware(plain, auditing);
		const trips = await proxy.count(() =>
			db
				.transaction(async () => {
					throw new Error("early");
				})
				.catch(() => {}),
		);
		expect(trips).toBe(0);
	});

	test("tx.rollback() rolls back everything", async () => {
		const db = withMiddleware(plain, auditing);
		await db
			.transaction(async (tx) => {
				await tx.insert(users).values({ name: "a" });
				tx.rollback();
			})
			.catch(() => {});
		expect(await plain.select().from(users)).toEqual([]);
		expect(await logRows()).toEqual([]);
	});

	test("uses the transaction config", async () => {
		const db = withMiddleware(plain, () => ({ before: [tenantBefore("t")] }));
		const level = await db.transaction(
			async (tx) => {
				const {
					rows: [row],
				} = await tx.execute<{ level: string; ro: string }>(
					sql`select current_setting('transaction_isolation') as level, current_setting('transaction_read_only') as ro`,
				);
				return row;
			},
			{ isolationLevel: "serializable", accessMode: "read only" },
		);
		expect(level).toEqual({ level: "serializable", ro: "on" });
	});

	test("rejects an unknown transaction config before it sends anything", async () => {
		const db = withMiddleware(plain, auditing);
		let error: any;
		const trips = await proxy.count(async () => {
			error = await db
				.transaction(async () => {}, {
					isolationLevel: "serializable; drop table mw_users" as any,
				})
				.catch((e) => e);
		});
		expect(error.message).toMatch(/unknown isolation level/);
		expect(trips).toBe(0);
	});

	test("nested transactions use savepoints inside the middleware's transaction", async () => {
		const db = withMiddleware(plain, auditing);
		await db.transaction(async (tx) => {
			await tx.transaction(async (inner) => {
				await inner.insert(users).values({ name: "kept" });
			});
			await tx
				.transaction(async (inner) => {
					await inner.insert(users).values({ name: "undone" });
					throw new Error("inner");
				})
				.catch(() => {});
		});
		expect((await plain.select().from(users)).map((u) => u.name)).toEqual([
			"kept",
		]);
		expect((await logRows()).map((r) => r.stage)).toEqual(["before", "after"]);
	});

	test("rejects transaction control from the app inside the transaction", async () => {
		const db = withMiddleware(plain, auditing);
		const error = await db
			.transaction(async (tx) => {
				await tx.insert(users).values({ name: "a" });
				await tx.execute(sql`commit`);
			})
			.catch((e) => e);
		expect(error.cause.message).toMatch(/COMMIT is not allowed/);
		expect(await plain.select().from(users)).toEqual([]);
	});

	test("a first query that fails on the client keeps BEGIN and before for the next query", async () => {
		const db = withMiddleware(plain, auditing);
		const bad = {
			toPostgres() {
				throw new Error("cannot serialize");
			},
		};
		const tenant = await db.transaction(async (tx) => {
			await tx.execute(sql`select ${bad}`).catch(() => {});
			await tx.insert(users).values({ name: "a" });
			const { rows } = await tx.execute<{ t: string }>(
				sql`select current_setting('app.tenant', true) as t`,
			);
			return rows[0]?.t;
		});
		expect(tenant).toBe("acme");
		const rows = await logRows();
		expect(rows.map((r) => r.stage)).toEqual(["before", "after"]);
		expect(rows[0]?.txid).toBe(rows[1]?.txid as number);
	});

	test("a first query with a reused statement name keeps BEGIN and before", async () => {
		const db = withMiddleware(plain, auditing);
		await db.execute(sql`select 1`);
		const first = db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, sql.placeholder("id")))
			.prepare("mw_tx_name");
		await first.execute({ id: 1 });
		const tenant = await db.transaction(async (tx) => {
			await tx
				.select({ name: users.name })
				.from(users)
				.where(eq(users.name, sql.placeholder("n")))
				.prepare("mw_tx_name")
				.execute({ n: "a" })
				.catch(() => {});
			const { rows } = await tx.execute<{ t: string }>(
				sql`select current_setting('app.tenant', true) as t`,
			);
			return rows[0]?.t;
		});
		expect(tenant).toBe("acme");
	});

	test("a query after the transaction ends throws", async () => {
		const db = withMiddleware(plain, auditing);
		let kept: any;
		await db.transaction(async (tx) => {
			kept = tx;
		});
		const error = await kept
			.select()
			.from(users)
			.catch((e: any) => e);
		expect(error.cause.message).toMatch(/this transaction has ended/);
	});

	test("an error that the callback catches makes the transaction fail", async () => {
		const db = withMiddleware(plain, auditing);
		const error = await db
			.transaction(async (tx) => {
				await tx.insert(users).values({ name: "a" });
				await tx.execute(sql`select 1/0`).catch(() => {});
			})
			.catch((e) => e);
		expect(error).toBeInstanceOf(MiddlewareError);
		expect(error.stage).toBe("after");
		expect(await plain.select().from(users)).toEqual([]);
		expect(await logRows()).toEqual([]);
	});

	test("a caught error fails the transaction also with no after statements", async () => {
		const db = withMiddleware(plain, () => ({ before: [logBefore] }));
		const error = await db
			.transaction(async (tx) => {
				await tx.execute(sql`select 1/0`).catch(() => {});
			})
			.catch((e) => e);
		expect(error).toBeInstanceOf(MiddlewareError);
		expect(error.stage).toBe("commit");
		expect(await logRows()).toEqual([]);
	});

	test("a failed before statement fails the first query and the transaction", async () => {
		const db = withMiddleware(plain, () => ({ before: [sql`select 1/0`] }));
		const error = await db
			.transaction(async (tx) => {
				await tx.insert(users).values({ name: "a" });
			})
			.catch((e) => e);
		expect(error.cause).toBeInstanceOf(MiddlewareError);
		expect(error.cause.stage).toBe("before");
		expect(await plain.select().from(users)).toEqual([]);
	});

	test("a failed COMMIT throws", async () => {
		const db = withMiddleware(plain, auditing);
		const error = await db
			.transaction(async (tx) => {
				await tx.insert(child).values({ id: 1, parentId: 1 });
			})
			.catch((e) => e);
		expect(error).toBeInstanceOf(MiddlewareError);
		expect(error.stage).toBe("commit");
		expect(await logRows()).toEqual([]);
	});

	test("concurrent queries in the callback run after before", async () => {
		const db = withMiddleware(plain, auditing);
		const tenants = await db.transaction(async (tx) =>
			Promise.all(
				Array.from({ length: 5 }, () =>
					tx.execute<{ t: string }>(
						sql`select current_setting('app.tenant', true) as t`,
					),
				),
			),
		);
		expect(tenants.map((r) => r.rows[0]?.t)).toEqual(Array(5).fill("acme"));
	});

	test("empty middleware runs a plain Drizzle transaction", async () => {
		const db = withMiddleware(plain, () => ({}));
		const trips = await proxy.count(() =>
			db.transaction(async (tx) => {
				await tx.select().from(users);
			}),
		);
		expect(trips).toBe(3);
	});

	test("the client goes back to the pool idle", async () => {
		const db = withMiddleware(plain, auditing);
		await db.transaction(async () => {});
		await db
			.transaction(async () => {
				throw new Error("x");
			})
			.catch(() => {});
		await db
			.transaction(async (tx) => {
				await tx.execute(sql`select 1/0`).catch(() => {});
			})
			.catch(() => {});
		expect(pool.totalCount).toBe(1);
		expect(pool.idleCount).toBe(1);
	});
});

describe("the query cache", () => {
	const tenantSelect = (db: ReturnType<typeof makeDb>) =>
		db
			.select({
				name: users.name,
				tenant: sql<string>`current_setting('app.tenant', true)`,
			})
			.from(users)
			.orderBy(users.id);

	function cachedDb(middleware: Middleware, cache = new MemoryCache()) {
		const base = drizzle({ client: pool, relations, cache });
		return { db: withMiddleware(base, middleware), cache };
	}

	test("a hit for the same middleware values sends nothing", async () => {
		await plain.insert(users).values({ name: "a" });
		const { db, cache } = cachedDb(() => ({ before: [tenantBefore("acme")] }));
		const first = await tenantSelect(db);
		let second: unknown;
		const trips = await proxy.count(async () => {
			second = await tenantSelect(db);
		});
		expect(first).toEqual([{ name: "a", tenant: "acme" }]);
		expect(second).toEqual(first);
		expect(trips).toBe(0);
		expect(cache.keys).toHaveLength(1);
	});

	test("other middleware values use another key", async () => {
		await plain.insert(users).values({ name: "a" });
		const cache = new MemoryCache();
		const { db: acme } = cachedDb(
			() => ({ before: [tenantBefore("acme")] }),
			cache,
		);
		const { db: other } = cachedDb(
			() => ({ before: [tenantBefore("other")] }),
			cache,
		);
		expect(await tenantSelect(acme)).toEqual([{ name: "a", tenant: "acme" }]);
		expect(await tenantSelect(other)).toEqual([{ name: "a", tenant: "other" }]);
		expect(new Set(cache.keys).size).toBe(2);
	});

	test("the key is not the key of the query alone", async () => {
		const { db, cache } = cachedDb(() => ({ before: [tenantBefore("acme")] }));
		await tenantSelect(db);
		const { sql: text, params } = tenantSelect(db).toSQL();
		expect(cache.keys[0]).not.toBe(await hashQuery(text, params));
	});

	test("a miss calls the middleware once and runs one unit", async () => {
		let calls = 0;
		const { db } = cachedDb(() => {
			calls++;
			return { before: [tenantBefore(`t${calls}`)], after: [logAfter] };
		});
		const trips = await proxy.count(() => tenantSelect(db));
		expect(trips).toBe(1);
		expect(calls).toBe(1);
		expect((await logRows()).map((r) => r.stage)).toEqual(["after"]);
	});

	test("a hit does not run before or after", async () => {
		const { db } = cachedDb(auditing);
		await tenantSelect(db);
		await tenantSelect(db);
		expect((await logRows()).map((r) => r.stage)).toEqual(["before", "after"]);
	});

	test("a write through the db invalidates its tables", async () => {
		const { db, cache } = cachedDb(() => ({ before: [tenantBefore("acme")] }));
		expect(await tenantSelect(db)).toEqual([]);
		await db.insert(users).values({ name: "a" });
		expect(cache.mutations).toEqual([["mw_users"]]);
		expect(await tenantSelect(db)).toEqual([{ name: "a", tenant: "acme" }]);
	});

	test("$withCache({ tag }) throws", async () => {
		const { db, cache } = cachedDb(() => ({ before: [tenantBefore("acme")] }));
		const error = await tenantSelect(db)
			.$withCache({ tag: "users" })
			.catch((e) => e);
		expect(error.message).toMatch(/\$withCache\(\{ tag \}\) is not supported/);
		expect(cache.keys).toEqual([]);
	});

	test("the explicit strategy caches only queries that ask for it", async () => {
		const { db, cache } = cachedDb(
			() => ({ before: [tenantBefore("acme")] }),
			new MemoryCache("explicit"),
		);
		await tenantSelect(db);
		expect(cache.keys).toEqual([]);
		await tenantSelect(db).$withCache();
		expect(cache.keys).toHaveLength(1);
	});

	test("queries that Drizzle does not cache run as units", async () => {
		const { db, cache } = cachedDb(auditing);
		await db.execute(sql`select 1`);
		await db.query.users.findMany();
		expect(cache.keys).toEqual([]);
		expect(await logRows()).toHaveLength(4);
	});

	test("a failed query is not stored and throws as without the cache", async () => {
		const { db, cache } = cachedDb(() => ({ before: [sql`select 1/0`] }));
		const error = await tenantSelect(db).catch((e) => e);
		expect(error).toBeInstanceOf(DrizzleQueryError);
		expect(error.cause).toBeInstanceOf(MiddlewareError);
		expect(cache.keys).toEqual([]);
	});

	test("empty middleware uses the same key as plain Drizzle", async () => {
		const { db, cache } = cachedDb(() => ({}));
		await tenantSelect(db);
		const { sql: text, params } = tenantSelect(db).toSQL();
		expect(cache.keys).toEqual([await hashQuery(text, params)]);
	});

	test("reads in db.transaction() do not use the cache; writes invalidate", async () => {
		const { db, cache } = cachedDb(() => ({ before: [tenantBefore("acme")] }));
		await tenantSelect(db);
		expect(cache.keys).toHaveLength(1);
		const trips = await proxy.count(() =>
			db.transaction(async (tx) => {
				expect(await tenantSelect(tx as any)).toEqual([]);
				await tx.insert(users).values({ name: "a" });
				expect(await tenantSelect(tx as any)).toEqual([
					{ name: "a", tenant: "acme" },
				]);
			}),
		);
		expect(trips).toBe(4);
		expect(cache.keys).toHaveLength(1);
		expect(cache.mutations).toEqual([["mw_users"]]);
	});

	test("{ cache: false }: reads skip the cache, writes invalidate it", async () => {
		const cache = new MemoryCache();
		const base = drizzle({ client: pool, relations, cache });
		const db = withMiddleware(base, auditing, { cache: false });
		await tenantSelect(base);
		expect(cache.keys).toHaveLength(1);
		const trips = await proxy.count(async () => {
			await tenantSelect(db);
			await tenantSelect(db).$withCache({ tag: "users" });
		});
		expect(trips).toBe(2);
		expect(cache.keys).toHaveLength(1);
		expect(await logRows()).toHaveLength(4);
		await db.insert(users).values({ name: "a" });
		expect(cache.mutations).toEqual([["mw_users"]]);
		expect(cache.entries.size).toBe(0);
		await db.transaction(async (tx) => {
			await tenantSelect(tx as any);
		});
		expect(cache.keys).toHaveLength(1);
	});

	test("{ cache: false } on a db without a cache changes nothing", async () => {
		const db = withMiddleware(plain, auditing, { cache: false });
		expect(await proxy.count(() => tenantSelect(db))).toBe(1);
	});
});

describe("withMiddleware on the app's transaction", () => {
	/** Runs fn in a transaction that is always rolled back, as a test harness does. */
	async function inTestTransaction(
		fn: (
			tx: Parameters<Parameters<typeof plain.transaction>[0]>[0],
		) => Promise<void>,
	) {
		await plain
			.transaction(async (tx) => {
				await fn(tx);
				tx.rollback();
			})
			.catch((error) => {
				if (!(error instanceof TransactionRollbackError)) throw error;
			});
	}

	const txLogRows = (tx: any) => tx.select().from(log).orderBy(log.id);

	test("runs SAVEPOINT; before; query; after; RELEASE in one round trip", async () => {
		await inTestTransaction(async (testTx) => {
			const db = withMiddleware(testTx, auditing);
			let row: any;
			const trips = await proxy.count(async () => {
				({
					rows: [row],
				} = await db.execute(
					sql`select current_setting('app.tenant', true) as tenant, txid_current()::text as txid`,
				));
			});
			expect(trips).toBe(1);
			expect(row.tenant).toBe("acme");
			const rows = await txLogRows(testTx);
			expect(rows.map((r: any) => [r.stage, r.txid])).toEqual([
				["before", Number(row.txid)],
				["after", Number(row.txid)],
			]);
		});
		expect(await logRows()).toEqual([]);
	});

	test("gives the same results as on a db", async () => {
		await inTestTransaction(async (testTx) => {
			await testTx.insert(users).values([{ name: "a" }, { name: "b" }]);
			await testTx.insert(posts).values({ userId: 1, title: "p" });
			const db = withMiddleware(testTx, auditing);
			const reads = (d: any) => [
				() => d.select().from(users).orderBy(users.id),
				() =>
					d.query.users.findMany({
						with: { posts: true },
						orderBy: { id: "asc" },
					}),
				() => d.$count(users),
			];
			const expected = [];
			for (const read of reads(testTx)) expected.push(await read());
			const actual = [];
			for (const read of reads(db)) actual.push(await read());
			expect(actual).toEqual(expected);
		});
	});

	test("a failed unit is undone and the app's transaction goes on", async () => {
		await inTestTransaction(async (testTx) => {
			const db = withMiddleware(testTx, auditing);
			const error = await db
				.insert(posts)
				.values({ userId: 999, title: "x" })
				.catch((e) => e);
			expect(error.cause.code).toBe("23503");
			const failedAfter = await withMiddleware(testTx, () => ({
				after: [sql`select 1/0`],
			}))
				.insert(users)
				.values({ name: "undone" })
				.catch((e) => e);
			expect(failedAfter.cause).toBeInstanceOf(MiddlewareError);
			expect(await txLogRows(testTx)).toEqual([]);
			expect(await testTx.select().from(users)).toEqual([]);
			await db.insert(users).values({ name: "kept" });
			expect((await testTx.select().from(users)).map((u) => u.name)).toEqual([
				"kept",
			]);
		});
	});

	test("tx.transaction() puts before and after around a savepoint", async () => {
		await inTestTransaction(async (testTx) => {
			const db = withMiddleware(testTx, auditing);
			const trips = await proxy.count(() =>
				db.transaction(async (tx) => {
					await tx.insert(users).values({ name: "a" });
					await tx.transaction(async (inner) => {
						await inner.insert(users).values({ name: "b" });
					});
				}),
			);
			// SAVEPOINT+before+insert, savepoint sp, insert, release sp, after+RELEASE.
			expect(trips).toBe(5);
			expect((await txLogRows(testTx)).map((r: any) => r.stage)).toEqual([
				"before",
				"after",
			]);
			expect(await testTx.$count(users)).toBe(2);
		});
	});

	test("tx.transaction() ignores the config, as Drizzle's nested transactions do", async () => {
		await inTestTransaction(async (testTx) => {
			const db = withMiddleware(testTx, auditing);
			// The type of a nested transaction has no config, as in Drizzle.
			const level = await (db.transaction as any)(
				async (tx: any) => {
					const { rows } = await tx.execute(
						sql`select current_setting('transaction_isolation') as level`,
					);
					return rows[0]?.level;
				},
				{ isolationLevel: "serializable" },
			);
			expect(level).toBe("read committed");
		});
	});

	test("an error in tx.transaction() rolls back to the savepoint", async () => {
		await inTestTransaction(async (testTx) => {
			const db = withMiddleware(testTx, auditing);
			await db
				.transaction(async (tx) => {
					await tx.insert(users).values({ name: "a" });
					throw new Error("app error");
				})
				.catch(() => {});
			const caught = await db
				.transaction(async (tx) => {
					await tx.execute(sql`select 1/0`).catch(() => {});
				})
				.catch((e) => e);
			expect(caught).toBeInstanceOf(MiddlewareError);
			expect(await testTx.select().from(users)).toEqual([]);
			expect(await txLogRows(testTx)).toEqual([]);
		});
	});

	test("works on a nested transaction of the app", async () => {
		await inTestTransaction(async (testTx) => {
			await testTx.transaction(async (nested) => {
				const db = withMiddleware(nested, auditing);
				await db.insert(users).values({ name: "a" });
				await db.transaction(async (tx) => {
					await tx.insert(users).values({ name: "b" });
				});
			});
			expect(await testTx.$count(users)).toBe(2);
			expect(await testTx.$count(log)).toBe(4);
		});
	});

	test.each(["savepoint x", "release savepoint x", "rollback to savepoint x"])(
		"rejects %p as a query",
		async (text) => {
			await inTestTransaction(async (testTx) => {
				const db = withMiddleware(testTx, auditing);
				const error = await db.execute(sql.raw(text)).catch((e) => e);
				expect(error.cause.message).toMatch(/could end the savepoint/);
			});
		},
	);

	test("a kept transaction throws when the pool gave its client out again", async () => {
		let kept: any;
		let client: any;
		await inTestTransaction(async (testTx) => {
			kept = withMiddleware(testTx, auditing);
			client = (testTx as any).session.client;
		});
		// The pool has one client: a new checkout gets the same one.
		const checkout = await pool.connect();
		expect(checkout).toBe(client);
		await checkout.query("begin");
		const error = await kept
			.select()
			.from(users)
			.catch((e: any) => e);
		expect(error.cause.message).toMatch(/this transaction has ended/);
		await checkout.query("rollback");
		checkout.release();
	});

	test("a kept transaction throws after the app's transaction ends", async () => {
		let kept: any;
		await inTestTransaction(async (testTx) => {
			kept = withMiddleware(testTx, auditing);
		});
		const outside = await kept
			.select()
			.from(users)
			.catch((e: any) => e);
		expect(outside.cause.message).toMatch(/this transaction has ended/);
		// The pool has one client: the next transaction gets the same one.
		await inTestTransaction(async () => {
			const inside = await kept
				.select()
				.from(users)
				.catch((e: any) => e);
			expect(inside.cause.message).toMatch(/this transaction has ended/);
			const scoped = await kept
				.transaction(async () => {})
				.catch((e: any) => e);
			expect(scoped.message).toMatch(/this transaction has ended/);
		});
	});

	test("rejects a transaction that already has middleware", async () => {
		await inTestTransaction(async (testTx) => {
			const db = withMiddleware(testTx, auditing);
			expect(() => withMiddleware(db, auditing)).toThrow(
				/already has middleware/,
			);
		});
	});

	test("rejects a nested transaction of a transaction with middleware", async () => {
		await inTestTransaction(async (testTx) => {
			for (const middleware of [auditing, () => ({})]) {
				await withMiddleware(testTx, middleware).transaction(async (tx) => {
					expect(() => withMiddleware(tx, auditing)).toThrow(
						/from a db with middleware/,
					);
				});
			}
		});
	});

	test("turns pipeline mode back off, also with the app's queries in between", async () => {
		await inTestTransaction(async (testTx) => {
			const client = (testTx as any).session.client;
			const db = withMiddleware(testTx, auditing);
			const results = await Promise.all([
				db.select().from(users),
				testTx.select().from(users),
				db.insert(users).values({ name: "a" }).returning(),
				testTx.$count(users),
			]);
			expect(results[2]).toHaveLength(1);
			expect(client.pipeline).toBe(false);
		});
	});

	test("keeps pipeline mode while the app's queries still wait for answers", async () => {
		await inTestTransaction(async (testTx) => {
			const client = (testTx as any).session.client;
			const db = withMiddleware(testTx, auditing);
			// The unit ends while the slow query runs and the fast one waits.
			const results = await Promise.all([
				db.select().from(users),
				testTx.execute(sql`select pg_sleep(0.1)`),
				testTx.execute(sql`select 1 as one`),
			]);
			expect(results[2].rows).toEqual([{ one: 1 }]);
			expect(client.pipeline).toBe(false);
		});
	});

	test("empty middleware runs queries as plain Drizzle does", async () => {
		await inTestTransaction(async (testTx) => {
			const db = withMiddleware(testTx, () => ({}));
			expect(await proxy.count(() => db.select().from(users))).toBe(1);
			await db.transaction(async (tx) => {
				await tx.insert(users).values({ name: "a" });
			});
			expect(await testTx.$count(users)).toBe(1);
		});
	});

	test("reads do not use the cache; writes invalidate", async () => {
		const cache = new MemoryCache();
		const base = drizzle({ client: pool, relations, cache });
		await base
			.transaction(async (testTx) => {
				const db = withMiddleware(testTx, auditing);
				await db.select().from(users);
				await db.insert(users).values({ name: "a" });
				testTx.rollback();
			})
			.catch(() => {});
		expect(cache.keys).toEqual([]);
		expect(cache.mutations).toEqual([["mw_users"]]);
	});
});
