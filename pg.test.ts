import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { defineRelations, entityKind, eq, sql } from "drizzle-orm-beta";
import { CasingCache } from "drizzle-orm-beta/casing";
import { NeonHttpSession } from "drizzle-orm-beta/neon-http/session";
import {
	PgAsyncDatabase,
	PgAsyncTransaction,
	PgDialect,
	integer,
	pgTable,
} from "drizzle-orm-beta/pg-core";
import { PrismaPgSession } from "drizzle-orm-beta/prisma/pg/session";
import {
	PREPARED_ALLOWED,
	PREPARED_DENIED,
	SESSION_ALLOWED,
	SESSION_DENIED,
} from "./src/pg-guard.ts";
import {
	type Middleware,
	executeBatchTransaction,
	withMiddleware,
} from "./src/pg.ts";
import { fakePrisma } from "./test-helpers/fake-prisma.ts";
import { reviewDrizzleMembers } from "./test-helpers/member-review.ts";

type Log = string[];

const EXPECTED_SESSION_KINDS = new Set([
	"NodePgSession",
	"NeonSession",
	"VercelPgSession",
	"NetlifyDbSession",
	"NetlifyDbWsSession",
	"PgliteSession",
	"PostgresJsSession",
	"EffectPgSession",
	"NeonHttpSession",
	"XataHttpSession",
	"PgRemoteSession",
]);

const users = pgTable("users", {
	id: integer("id").notNull(),
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockPreparedQuery(log: Log, id: string) {
	const pq: any = {
		execute: async () => {
			log.push(`execute:${id}`);
			return [{ id: 1 }];
		},
		joinsNotNullableMap: undefined as Record<string, boolean> | undefined,
		setToken(token: unknown) {
			log.push(`setToken:${id}:${String(token)}`);
			return this;
		},
	};
	return pq;
}

function createMockSession(log: Log) {
	const session: Record<string, any> = {
		prepareQuery: (...args: unknown[]) => {
			const q = args[0] as { sql?: string };
			const id = q?.sql ?? "query";
			log.push(`prepareQuery:${id}`);
			return createMockPreparedQuery(log, id);
		},
		prepareRelationalQuery: (...args: unknown[]) => {
			const q = args[0] as { sql?: string };
			const id = q?.sql ?? "relQuery";
			log.push(`prepareRelationalQuery:${id}`);
			return createMockPreparedQuery(log, id);
		},
		transaction: async (
			fn: (tx: unknown) => Promise<unknown>,
			_config?: unknown,
		) => {
			log.push("tx:begin");
			const txSession = createMockSession(log);
			const tx = { session: txSession };
			const result = await fn(tx);
			log.push("tx:end");
			return result;
		},
	};
	return session;
}

const mockDialect = {
	casing: new CasingCache(undefined),
	escapeName(name: string) {
		return `"${name}"`;
	},
	escapeParam(num: number) {
		return `$${num + 1}`;
	},
	escapeString(str: string) {
		return `'${str.replace(/'/g, "''")}'`;
	},
	sqlToQuery(s: any) {
		return s.toQuery({
			casing: mockDialect.casing,
			escapeName: mockDialect.escapeName,
			escapeParam: mockDialect.escapeParam,
			escapeString: mockDialect.escapeString,
		});
	},
};

function mockDb(log: Log) {
	return new (PgAsyncDatabase as any)(
		mockDialect,
		createMockSession(log),
		{},
		undefined,
	);
}

function getCombinedPrepare(log: Log): string {
	const entry = log.find(
		(value) => value.startsWith("prepareQuery:") && value.includes(";\n"),
	);
	if (!entry)
		throw new Error(`No combined query found in log: ${log.join(", ")}`);
	return entry;
}

// A copy of Drizzle's `PrismaPgDatabase` (the real module imports
// `@prisma/client`). Its constructor builds its own session.
class PrismaPgDatabase extends (PgAsyncDatabase as any) {
	static readonly [entityKind] = "PrismaPgDatabase";
	constructor(client: unknown) {
		const dialect = new PgDialect();
		super(
			dialect,
			new PrismaPgSession(dialect, client as any, {}),
			{},
			undefined,
		);
	}
}

// ---------------------------------------------------------------------------
// Member review for the fail-closed guard
// ---------------------------------------------------------------------------

function reviewDrizzlePgMembers() {
	return reviewDrizzleMembers({
		coreDir: "pg-core",
		sessionBases: ["PgAsyncSession"],
		preparedBases: ["PgAsyncPreparedQuery"],
		// The Effect classes extend these directly and are not supported.
		sessionAncestors: ["PgSession"],
		preparedAncestors: ["PgBasePreparedQuery"],
		session: {
			allowed: SESSION_ALLOWED,
			denied: SESSION_DENIED,
			intercepted: new Set([
				"prepareQuery",
				"prepareRelationalQuery",
				"prepareOneTimeRelationalQuery",
				"transaction",
			]),
		},
		prepared: {
			allowed: PREPARED_ALLOWED,
			denied: PREPARED_DENIED,
			intercepted: new Set(["execute", "all", "values", "setToken"]),
		},
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withMiddleware (pg)", () => {
	test("returns a new db instance", () => {
		const db = mockDb([]);
		const wrapped = withMiddleware(db, () => ({}));
		expect(wrapped).not.toBe(db);
	});

	test("blocks $client and preserves $cache", () => {
		const db = mockDb([]);
		db.$client = { fake: "client" };
		db.$cache = { fake: "cache" };
		const wrapped = withMiddleware(db, () => ({}));
		expect(() => wrapped.$client).toThrow(
			"blocked access to `$client` on a wrapped db",
		);
		expect(wrapped.$cache).toEqual({ fake: "cache" });
		// The unwrapped db keeps its client, and a wrapped db can be wrapped.
		expect(db.$client).toEqual({ fake: "client" });
		expect(() => withMiddleware(wrapped, () => ({})).$client).toThrow(
			"blocked access to `$client`",
		);
	});

	test("keeps parseRqbJson of the input db and transaction", () => {
		const relations = defineRelations({ users });
		const db = new (PgAsyncDatabase as any)(
			mockDialect,
			createMockSession([]),
			relations,
			undefined,
			true,
		);
		const tx = new (PgAsyncTransaction as any)(
			mockDialect,
			createMockSession([]),
			relations,
			undefined,
			1,
			true,
		);

		for (const input of [db, tx]) {
			const wrapped = withMiddleware(input, () => ({})) as any;
			expect(wrapped.query.users.parseJson).toBe(true);
			// Stacked layers keep it too.
			const stacked = withMiddleware(wrapped, () => ({})) as any;
			expect(stacked.query.users.parseJson).toBe(true);
		}
		const plain = withMiddleware(
			new (PgAsyncDatabase as any)(
				mockDialect,
				createMockSession([]),
				relations,
				undefined,
			),
			() => ({}),
		) as any;
		expect(plain.query.users.parseJson).toBe(false);
	});

	// -------------------------------------------------------------------
	// Prisma: sequential transaction fallback
	// -------------------------------------------------------------------

	test("Prisma PG: runs each statement in order in a Prisma transaction", async () => {
		const log: Log = [];
		const db = new PrismaPgDatabase(fakePrisma(log)) as any;
		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT set_config('app.tenant', ${"acme"}, true)`],
			after: [sql`SELECT set_config('app.tenant', '', true)`],
		})) as any;

		// The wrapped db keeps the Prisma db class.
		expect(wrapped).toBeInstanceOf(PrismaPgDatabase);
		expect(await wrapped.select().from(users).where(eq(users.id, 7))).toEqual([
			{ id: 1 },
		]);
		expect(log).toEqual([
			"begin",
			`tx: SELECT set_config('app.tenant', $1, true) ["acme"]`,
			'tx: select "id" from "users" where "users"."id" = $1 [7]',
			"tx: SELECT set_config('app.tenant', '', true)",
			"commit",
		]);
	});

	test("Prisma PG: stacked layers run in onion order", async () => {
		const log: Log = [];
		const db = new PrismaPgDatabase(fakePrisma(log)) as any;
		const inner = withMiddleware(db, () => ({
			before: [sql`SELECT 'inner before'`],
			after: [sql`SELECT 'inner after'`],
		}));
		const outer = withMiddleware(inner, () => ({
			before: [sql`SELECT 'outer before'`],
			after: [sql`SELECT 'outer after'`],
		})) as any;

		await outer.execute(sql`SELECT 1`);
		expect(log).toEqual([
			"begin",
			"tx: SELECT 'outer before'",
			"tx: SELECT 'inner before'",
			"tx: SELECT 1",
			"tx: SELECT 'inner after'",
			"tx: SELECT 'outer after'",
			"commit",
		]);
	});

	test("Prisma PG: a failed statement rolls back the whole envelope", async () => {
		const log: Log = [];
		const db = new PrismaPgDatabase(fakePrisma(log, "audit")) as any;
		const wrapped = withMiddleware(db, () => ({
			after: [sql`INSERT INTO audit VALUES (1)`],
		})) as any;

		// `execute()` returns a thenable; adopt it as a promise for `rejects`.
		await expect(
			Promise.resolve(wrapped.execute(sql`DELETE FROM users`)),
		).rejects.toThrow("failed: audit");
		expect(log).toEqual([
			"begin",
			"tx: DELETE FROM users",
			"tx: INSERT INTO audit VALUES (1)",
			"rollback",
		]);
	});

	test("Prisma PG: no middleware runs the query directly", async () => {
		const log: Log = [];
		const db = new PrismaPgDatabase(fakePrisma(log)) as any;
		const wrapped = withMiddleware(db, () => ({})) as any;

		await wrapped.execute(sql`SELECT 1`);
		expect(log).toEqual(["prisma: SELECT 1"]);
	});

	test("Prisma PG: executeBatchTransaction runs in a Prisma transaction", async () => {
		const log: Log = [];
		const db = new PrismaPgDatabase(fakePrisma(log)) as any;
		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 'before'`],
		})) as any;

		expect(
			await executeBatchTransaction([
				wrapped.select().from(users),
				wrapped.select().from(users).where(eq(users.id, 2)),
			]),
		).toEqual([[{ id: 1 }], [{ id: 1 }]]);
		// Without middleware, the queries still run one at a time.
		await executeBatchTransaction([db.select().from(users)]);

		expect(log).toEqual([
			"begin",
			"tx: SELECT 'before'",
			'tx: select "id" from "users"',
			'tx: select "id" from "users" where "users"."id" = $1 [2]',
			"commit",
			"begin",
			'tx: select "id" from "users"',
			"commit",
		]);
	});

	test("rejects pg-proxy and Xata (no batch and no transactions)", () => {
		const { PgRemoteSession } = require("drizzle-orm-beta/pg-proxy/session");
		const { XataHttpSession } = require("drizzle-orm-beta/xata-http/session");
		for (const [Session, kind] of [
			[PgRemoteSession, "PgRemoteSession"],
			[XataHttpSession, "XataHttpSession"],
		]) {
			const db = new (PgAsyncDatabase as any)(
				mockDialect,
				new Session(() => {}, mockDialect, {}, undefined, {}),
				{},
				undefined,
			);
			expect(() => withMiddleware(db, () => ({}))).toThrow(
				`withMiddleware is not compatible with ${kind}`,
			);
		}
	});

	test("fails closed for a db class with its own constructor", () => {
		// Like `PrismaPgDatabase`: the constructor builds its own session and
		// ignores the session that withMiddleware passes.
		class CustomDb extends (PgAsyncDatabase as any) {
			static readonly [entityKind] = "CustomDb";
			constructor(_client: unknown) {
				super(mockDialect, createMockSession([]), {}, undefined);
			}
		}
		const db = new CustomDb({});
		expect(() => withMiddleware(db as any, () => ({}))).toThrow(
			"cannot wrap CustomDb",
		);
	});

	test("fast path: no before/after skips transaction", async () => {
		const log: Log = [];
		const db = mockDb(log);
		const wrapped = withMiddleware(db, () => ({}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		expect(log).toEqual(["prepareQuery:SELECT 1", "execute:SELECT 1"]);
		expect(log).not.toContain("tx:begin");
	});

	test("before + inner are concatenated into one statement", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const middleware: Middleware = () => ({
			before: [
				sql`SELECT set_config('a', 'one', true)`,
				sql`SELECT set_config('b', 'two', true)`,
			],
		});
		const wrapped = withMiddleware(db, middleware);

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT 1",
		});
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
		const combined = getCombinedPrepare(log);
		expect(combined).toContain("set_config('a'");
		expect(combined).toContain("set_config('b'");
		expect(combined).toContain("SELECT 1");
		expect(combined).toContain(";\n");
	});

	test("inner + after are concatenated into one statement", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const middleware: Middleware = () => ({
			after: [sql`SELECT set_config('a', '', true)`],
		});
		const wrapped = withMiddleware(db, middleware);

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT 1",
		});
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
		const combined = getCombinedPrepare(log);
		expect(combined).toContain("SELECT 1");
		expect(combined).toContain("set_config('a'");
	});

	test("before + inner + after all in one statement, correct order", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const middleware: Middleware = () => ({
			before: [sql`SELECT set_config('role', 'app', true)`],
			after: [sql`SELECT set_config('role', '', true)`],
		});
		const wrapped = withMiddleware(db, middleware);

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT users",
		});
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
		const combined = getCombinedPrepare(log);
		const beforeIdx = combined.indexOf("'app'");
		const innerIdx = combined.indexOf("SELECT users");
		const afterIdx = combined.indexOf("''");
		expect(beforeIdx).toBeLessThan(innerIdx);
		expect(innerIdx).toBeLessThan(afterIdx);
	});

	test("before query params are inlined", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const tenantId = "tenant-42";
		const middleware: Middleware = () => ({
			before: [sql`SELECT set_config('app.tenant', ${tenantId}, true)`],
		});
		const wrapped = withMiddleware(db, middleware);

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT 1",
		});
		await prepared.execute();

		const combined = getCombinedPrepare(log);
		expect(combined).toContain("'tenant-42'");
	});

	test("inlineSql does not leak shouldInlineParams onto middleware SQL", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const beforeSql = sql`SELECT set_config('a', ${"x"}, true)`;
		const afterSql = sql`SELECT set_config('a', ${"y"}, true)`;
		expect((beforeSql as any).shouldInlineParams).toBe(false);
		expect((afterSql as any).shouldInlineParams).toBe(false);

		const wrapped = withMiddleware(db, () => ({
			before: [beforeSql],
			after: [afterSql],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		expect((beforeSql as any).shouldInlineParams).toBe(false);
		expect((afterSql as any).shouldInlineParams).toBe(false);
	});

	test("inner query params are inlined via dialect capture", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const innerSql = sql`SELECT * FROM users WHERE id = ${42} AND name = ${"alice"}`;
		const query = (wrapped as any).dialect.sqlToQuery(innerSql);
		const prepared = wrapped.session.prepareQuery(query);
		await prepared.execute();

		const combined = getCombinedPrepare(log);
		expect(combined).toContain("42");
		expect(combined).toContain("'alice'");
		expect(combined).not.toContain("$1");
		expect(combined).not.toContain("$2");
	});

	test("setToken is forwarded to the batched prepared query", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT 1",
		});
		prepared.setToken("tok-123");
		await prepared.execute();

		const tokenEntries = log.filter((l) => l.startsWith("setToken:"));
		expect(tokenEntries.length).toBeGreaterThanOrEqual(1);
		expect(tokenEntries.some((l) => l.includes("tok-123"))).toBe(true);
	});

	test("joinsNotNullableMap is copied to the batched prepared query", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT 1",
		});
		prepared.joinsNotNullableMap = { users: true };
		await prepared.execute();

		const execEntries = log.filter((l) => l.startsWith("execute:"));
		expect(execEntries.length).toBe(1);
	});

	// -------------------------------------------------------------------
	// Placeholder resolution
	// -------------------------------------------------------------------

	test("placeholder values are resolved and inlined into concatenated query", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
		}));

		const innerSql = sql`SELECT * FROM users WHERE id = ${sql.placeholder("userId")}`;
		const query = (wrapped as any).dialect.sqlToQuery(innerSql);
		const prepared = wrapped.session.prepareQuery(query);
		await prepared.execute({ userId: 42 });

		expect(log).not.toContain("tx:begin");
		const combined = getCombinedPrepare(log);
		expect(combined).toContain("42");
		expect(combined).not.toContain("$1");
	});

	test("placeholder query uses single round trip, not tx fallback", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
			after: [sql`SELECT set_config('a', '', true)`],
		}));

		const innerSql = sql`SELECT * FROM users WHERE id = ${sql.placeholder("userId")} AND name = ${sql.placeholder("name")}`;
		const query = (wrapped as any).dialect.sqlToQuery(innerSql);
		const prepared = wrapped.session.prepareQuery(query);
		await prepared.execute({ userId: 7, name: "alice" });

		expect(log).not.toContain("tx:begin");
		expect(log.filter((l) => l.startsWith("execute:")).length).toBe(1);

		const combined = getCombinedPrepare(log);
		expect(combined).toContain("7");
		expect(combined).toContain("'alice'");
	});

	test("user-managed transaction: before/after run individually at boundaries", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const middleware: Middleware = () => ({
			before: [
				sql`SELECT set_config('a', 'x', true)`,
				sql`SELECT set_config('b', 'y', true)`,
			],
			after: [sql`SELECT set_config('a', '', true)`],
		});
		const wrapped = withMiddleware(db, middleware);

		await wrapped.session.transaction(async (tx: any) => {
			log.push("user:callback");
			return "done";
		});

		expect(log[0]).toBe("tx:begin");

		const beforeEntries = log.filter(
			(l) =>
				l.startsWith("execute:") &&
				l.includes("set_config") &&
				log.indexOf(l) < log.indexOf("user:callback"),
		);
		expect(beforeEntries.length).toBe(2);

		const afterEntries = log.filter(
			(l) =>
				l.startsWith("execute:") &&
				l.includes("''") &&
				log.indexOf(l) > log.indexOf("user:callback"),
		);
		expect(afterEntries.length).toBe(1);
	});

	test("transaction config is forwarded", async () => {
		let receivedConfig: unknown = null;
		const log: Log = [];

		const session = {
			prepareQuery: (...args: unknown[]) => createMockPreparedQuery(log, "q"),
			prepareRelationalQuery: (...args: unknown[]) =>
				createMockPreparedQuery(log, "q"),
			transaction: async (
				fn: (tx: unknown) => Promise<unknown>,
				config?: unknown,
			) => {
				receivedConfig = config;
				const tx = { session: createMockSession(log) };
				return fn(tx);
			},
		};

		const db = new (PgAsyncDatabase as any)(
			mockDialect,
			session,
			{},
			undefined,
		);
		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const txConfig = { isolationLevel: "serializable" };
		await wrapped.session.transaction(async () => "ok", txConfig);

		expect(receivedConfig).toEqual(txConfig);
	});

	test("prepareRelationalQuery is also wrapped", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
		}));

		const prepared = wrapped.session.prepareRelationalQuery({
			sql: "SELECT rel",
		});
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
		const combined = getCombinedPrepare(log);
		expect(combined).toContain("SELECT rel");
		expect(combined).toContain("set_config");
	});

	// -------------------------------------------------------------------
	// Fail-closed member guard
	// -------------------------------------------------------------------

	test("allowed session members pass through", () => {
		const log: Log = [];
		const db = mockDb(log);
		db.session.dialect = mockDialect;
		db.session.options = { logger: "x" };

		const wrapped = withMiddleware(db, () => ({}));
		expect(wrapped.session.options).toEqual({ logger: "x" });
		expect(wrapped.session.dialect).toBe(mockDialect);
	});

	test("unknown session members are blocked", () => {
		const log: Log = [];
		const db = mockDb(log);
		db.session.client = { query: () => log.push("client:query") };
		db.session.customProp = "hello";

		const wrapped = withMiddleware(db, () => ({}));
		for (const prop of ["client", "customProp"]) {
			expect(() => wrapped.session[prop]).toThrow(
				`blocked access to \`${prop}\` on a wrapped session`,
			);
			expect(() =>
				Object.getOwnPropertyDescriptor(wrapped.session, prop),
			).toThrow(`blocked access to \`${prop}\``);
		}
		expect(log).toEqual([]);
	});

	test("unknown prepared-query members are blocked", () => {
		const log: Log = [];
		const db = mockDb(log);
		const wrapped = withMiddleware(db, () => ({}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		expect(() => prepared.executeRqbV2).toThrow(
			"blocked access to `executeRqbV2` on a wrapped prepared query",
		);
		expect(() => prepared.client).toThrow("blocked access to `client`");
		expect(prepared.joinsNotNullableMap).toBeUndefined();
	});

	test("NeonHttpSession.batch is blocked (it skips the middleware)", async () => {
		const sent: string[] = [];
		const client: any = (query: string) => {
			sent.push(query);
			return Promise.resolve({ rows: [], fields: [] });
		};
		client.query = client;
		client.transaction = (queries: unknown[]) => Promise.all(queries);

		const db = new (PgAsyncDatabase as any)(
			mockDialect,
			new NeonHttpSession(client, mockDialect as any, {} as any, undefined),
			{},
			undefined,
		);
		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT set_config('app.tenant', 'x', true)`],
		}));

		expect(() => wrapped.session.batch([])).toThrow(
			"blocked access to `batch` on a wrapped session",
		);
		expect(sent).toEqual([]);
	});

	// -------------------------------------------------------------------
	// Result mapping
	// -------------------------------------------------------------------

	test("customResultMapper is applied to the extracted inner result", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const mapper = (rows: any[]) =>
			rows.map((r: any) => ({ mapped: true, ...r }));

		const prepared = wrapped.session.prepareQuery(
			{ sql: "SELECT 1" },
			undefined, // fields
			undefined, // name
			false, // isResponseInArrayMode
			mapper, // customResultMapper — capturedArgs[4]
		);
		const result = await prepared.execute();

		expect(result).toEqual([{ mapped: true, id: 1 }]);
	});

	test("custom positional mappers request postgres-js array mode", async () => {
		const log: Log = [];
		const session = createMockSession(log);
		let valuesCalled = false;
		session.client = {
			unsafe: (_query: string) => {
				const result = Promise.resolve([[], [["30"]]]);
				return Object.assign(result, {
					values: () => {
						valuesCalled = true;
						return result;
					},
				});
			},
		};
		const db = new (PgAsyncDatabase as any)(
			mockDialect,
			session,
			{},
			undefined,
		);
		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const count = await wrapped.session
			.prepareQuery(
				{ sql: "SELECT count(*) FROM users" },
				undefined,
				undefined,
				true, // isResponseInArrayMode
				(rows: unknown[][]) => Number(rows[0]?.[0] ?? 0),
			)
			.execute();

		expect(count).toBe(30);
		expect(valuesCalled).toBe(true);
	});

	test("unmapped queries preserve postgres-js native object results", async () => {
		const log: Log = [];
		const session = createMockSession(log);
		let valuesCalled = false;
		session.client = {
			unsafe: (_query: string) => {
				const result = Promise.resolve([[], [{ count: "30" }]]);
				return Object.assign(result, {
					values: () => {
						valuesCalled = true;
						return result;
					},
				});
			},
		};
		const db = new (PgAsyncDatabase as any)(
			mockDialect,
			session,
			{},
			undefined,
		);
		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const result = await wrapped.session
			.prepareQuery(
				{ sql: "SELECT count(*) FROM users" },
				undefined,
				undefined,
				true, // ignored by Drizzle when there is no fields/mapper mapping step
			)
			.execute();

		expect(result).toEqual([{ count: "30" }]);
		expect(valuesCalled).toBe(false);
	});

	test("customResultMapper is applied for relational queries (prepareRelationalQuery)", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const mapper = (rows: unknown[]) =>
			rows.map((r: any) => ({ mapped: true, ...r }));

		const prepared = wrapped.session.prepareRelationalQuery(
			{ sql: "SELECT rel" },
			undefined, // fields
			undefined, // name
			mapper, // customResultMapper — capturedArgs[3]
		);
		const result = await prepared.execute();

		expect(result).toEqual([{ mapped: true, id: 1 }]);
	});

	test("result is returned unmodified when no fields/mapper", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT 1",
		});
		const result = await prepared.execute();

		expect(result).toEqual([{ id: 1 }]);
	});

	test("object-mode rows are mapped to selected fields", async () => {
		const log: Log = [];
		const db = mockDb(log);
		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const prepared = wrapped.session.prepareQuery(
			{ sql: "SELECT id FROM users" },
			[{ path: ["id"], field: users.id }],
		);
		const result = await prepared.execute();

		expect(result).toEqual([{ id: 1 }]);
	});

	// -------------------------------------------------------------------
	// After-only extraction
	// -------------------------------------------------------------------

	test("after-only: inner result is extracted from multi-statement response", async () => {
		const log: Log = [];

		class NodePgLikeSession {
			static [entityKind] = "NodePgSession";

			client = {
				// Real node-postgres accepts either a string or a
				// `{ text, rowMode }` config object; mirror both.
				async query(input: string | { text: string; rowMode?: string }) {
					const sqlStr = typeof input === "string" ? input : input.text;
					const arrayMode =
						typeof input === "object" && input.rowMode === "array";
					log.push(`client.query:${sqlStr}`);
					const stmtCount = (sqlStr.match(/;\n/g) || []).length + 1;
					const row = () => (arrayMode ? [1] : { id: 1 });
					if (stmtCount > 1) {
						return Array.from({ length: stmtCount }, () => [row()]);
					}
					return [row()];
				},
			};

			prepareQuery(...args: unknown[]) {
				const q = args[0] as { sql?: string };
				const sqlStr = q?.sql ?? "query";
				log.push(`prepareQuery:${sqlStr}`);
				const stmtCount = (sqlStr.match(/;\n/g) || []).length + 1;
				return {
					execute: async () => {
						log.push(`execute:${sqlStr}`);
						if (stmtCount > 1) {
							return Array.from({ length: stmtCount }, (_, i) => [
								{ id: i + 1 },
							]);
						}
						return [{ id: 1 }];
					},
					joinsNotNullableMap: undefined,
					setToken(token: unknown) {
						return this;
					},
				};
			}

			async transaction(
				fn: (tx: unknown) => Promise<unknown>,
				_config?: unknown,
			) {
				log.push("tx:begin");
				const tx = { session: new NodePgLikeSession() };
				const result = await fn(tx);
				log.push("tx:end");
				return result;
			}
		}

		const db = new (PgAsyncDatabase as any)(
			mockDialect,
			new NodePgLikeSession(),
			{},
			undefined,
		);

		const wrapped = withMiddleware(db, () => ({
			after: [sql`SELECT set_config('a', '', true)`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		const result = await prepared.execute();

		expect(result).toEqual([{ id: 1 }]);
	});

	// -------------------------------------------------------------------
	// Round-trip count validation
	// -------------------------------------------------------------------

	test("standalone: 3 before + inner = 1 execute and no explicit tx", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`SELECT set_config('a', 'x', true)`,
				sql`SELECT set_config('b', 'y', true)`,
				sql`SELECT set_config('c', 'z', true)`,
			],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
		expect(log.filter((value) => value.startsWith("execute:")).length).toBe(1);
		getCombinedPrepare(log);
	});

	test("standalone: inner + 3 after = 1 execute and no explicit tx", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			after: [
				sql`SELECT set_config('a', '', true)`,
				sql`SELECT set_config('b', '', true)`,
				sql`SELECT set_config('c', '', true)`,
			],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
		expect(log.filter((value) => value.startsWith("execute:")).length).toBe(1);
		getCombinedPrepare(log);
	});

	test("standalone: 3 before + inner + 3 after = 1 execute and no explicit tx", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`SELECT set_config('a', 'x', true)`,
				sql`SELECT set_config('b', 'y', true)`,
				sql`SELECT set_config('c', 'z', true)`,
			],
			after: [
				sql`SELECT set_config('a', '', true)`,
				sql`SELECT set_config('b', '', true)`,
				sql`SELECT set_config('c', '', true)`,
			],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
		expect(log.filter((value) => value.startsWith("execute:")).length).toBe(1);
		getCombinedPrepare(log);
	});

	test("user tx: 3 before queries = 3 prepareQuery calls (no concatenation)", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [
				sql`SELECT set_config('a', 'x', true)`,
				sql`SELECT set_config('b', 'y', true)`,
				sql`SELECT set_config('c', 'z', true)`,
			],
		}));

		await wrapped.session.transaction(async () => "ok");

		const txStart = log.indexOf("tx:begin");
		const txEnd = log.indexOf("tx:end");
		const prepareCallsInTx = log.filter(
			(l, i) => i > txStart && i < txEnd && l.startsWith("prepareQuery:"),
		);
		expect(prepareCallsInTx.length).toBe(3);
	});

	// -------------------------------------------------------------------
	// Transaction as input db
	// -------------------------------------------------------------------

	function mockTxDb(log: Log) {
		return new (PgAsyncTransaction as any)(
			mockDialect,
			createMockSession(log),
			{},
			undefined,
			0,
		);
	}

	test("tx input: before + inner execute separately, correct order", async () => {
		const log: Log = [];
		const txDb = mockTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		const execEntries = log.filter((l) => l.startsWith("execute:"));
		expect(execEntries.length).toBe(2);
		const beforeIdx = log.findIndex(
			(l) => l.startsWith("execute:") && l.includes("set_config"),
		);
		const innerIdx = log.findIndex((l) => l === "execute:SELECT 1");
		expect(beforeIdx).toBeLessThan(innerIdx);
	});

	test("tx input: inner + after execute separately, correct order", async () => {
		const log: Log = [];
		const txDb = mockTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			after: [sql`SELECT set_config('a', '', true)`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		const execEntries = log.filter((l) => l.startsWith("execute:"));
		expect(execEntries.length).toBe(2);
		const innerIdx = log.findIndex((l) => l === "execute:SELECT 1");
		const afterIdx = log.findIndex(
			(l) => l.startsWith("execute:") && l.includes("set_config"),
		);
		expect(innerIdx).toBeLessThan(afterIdx);
	});

	test("tx input: before + inner + after, all separate, correct order", async () => {
		const log: Log = [];
		const txDb = mockTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('role', 'app', true)`],
			after: [sql`SELECT set_config('role', '', true)`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT users" });
		await prepared.execute();

		const execEntries = log.filter((l) => l.startsWith("execute:"));
		expect(execEntries.length).toBe(3);
		const beforeIdx = log.findIndex(
			(l) => l.startsWith("execute:") && l.includes("'app'"),
		);
		const innerIdx = log.findIndex(
			(l) => l.startsWith("execute:") && l.includes("SELECT users"),
		);
		const afterIdx = log.findIndex(
			(l) => l.startsWith("execute:") && l.includes("''"),
		);
		expect(beforeIdx).toBeLessThan(innerIdx);
		expect(innerIdx).toBeLessThan(afterIdx);
	});

	test("tx input: no before/after uses fast path", async () => {
		const log: Log = [];
		const txDb = mockTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		expect(log).toEqual(["prepareQuery:SELECT 1", "execute:SELECT 1"]);
	});

	test("tx input: does not concatenate before+inner into one statement", async () => {
		const log: Log = [];
		const txDb = mockTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		const combined = log.find(
			(l) => l.startsWith("prepareQuery:") && l.includes(";\n"),
		);
		expect(combined).toBeUndefined();
	});

	test("tx input: multiple before queries each get their own execute", async () => {
		const log: Log = [];
		const txDb = mockTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [
				sql`SELECT set_config('a', 'x', true)`,
				sql`SELECT set_config('b', 'y', true)`,
				sql`SELECT set_config('c', 'z', true)`,
			],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		const execEntries = log.filter((l) => l.startsWith("execute:"));
		expect(execEntries.length).toBe(4);
	});

	test("tx input: result comes from the inner query, not before/after", async () => {
		const log: Log = [];
		const txDb = mockTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
			after: [sql`SELECT set_config('a', '', true)`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		const result = await prepared.execute();

		expect(result).toEqual([{ id: 1 }]);
	});

	test("tx input: no explicit tx opened (no tx:begin)", async () => {
		const log: Log = [];
		const txDb = mockTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
			after: [sql`SELECT set_config('a', '', true)`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
	});

	// -------------------------------------------------------------------
	// Driver-specific transaction subclasses
	// -------------------------------------------------------------------

	function mockPostgresJsTxDb(log: Log) {
		const {
			PostgresJsTransaction,
		} = require("drizzle-orm-beta/postgres-js/session");
		return new PostgresJsTransaction(
			mockDialect,
			createMockSession(log),
			undefined,
			{},
			0,
		);
	}

	test("PostgresJsTransaction: nested transaction (savepoint) runs the middleware", async () => {
		const log: Log = [];
		const session = createMockSession(log);
		// postgres-js opens a savepoint on the transaction's `client`.
		session.options = {};
		session.client = {
			savepoint: async (fn: (client: unknown) => Promise<unknown>) => {
				log.push("savepoint");
				const result = await fn({
					unsafe: async (query: string) => {
						log.push(`unsafe:${query}`);
						return [];
					},
				});
				log.push("release");
				return result;
			},
		};
		const {
			PostgresJsTransaction,
		} = require("drizzle-orm-beta/postgres-js/session");
		const txDb = new PostgresJsTransaction(
			mockDialect,
			session,
			undefined,
			{},
			0,
		);

		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('app.tenant', 'x', true)`],
		}));
		await wrapped.transaction(async (savepoint: any) => {
			await savepoint.execute(sql`SELECT 1`);
		});

		expect(log).toEqual([
			"savepoint",
			"unsafe:SELECT set_config('app.tenant', 'x', true)",
			"unsafe:SELECT 1",
			"release",
		]);
	});

	test("PostgresJsTransaction: detected as transaction input", () => {
		const log: Log = [];
		const txDb = mockPostgresJsTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
		}));
		expect(wrapped).not.toBe(txDb);
	});

	test("PostgresJsTransaction: before + inner execute separately", async () => {
		const log: Log = [];
		const txDb = mockPostgresJsTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		const execEntries = log.filter((l: string) => l.startsWith("execute:"));
		expect(execEntries.length).toBe(2);
		const beforeIdx = log.findIndex(
			(l: string) => l.startsWith("execute:") && l.includes("set_config"),
		);
		const innerIdx = log.findIndex((l: string) => l === "execute:SELECT 1");
		expect(beforeIdx).toBeLessThan(innerIdx);
	});

	test("PostgresJsTransaction: before + inner + after, correct order", async () => {
		const log: Log = [];
		const txDb = mockPostgresJsTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('role', 'app', true)`],
			after: [sql`SELECT set_config('role', '', true)`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT users" });
		await prepared.execute();

		const execEntries = log.filter((l: string) => l.startsWith("execute:"));
		expect(execEntries.length).toBe(3);
		const beforeIdx = log.findIndex(
			(l: string) => l.startsWith("execute:") && l.includes("'app'"),
		);
		const innerIdx = log.findIndex(
			(l: string) => l.startsWith("execute:") && l.includes("SELECT users"),
		);
		const afterIdx = log.findIndex(
			(l: string) => l.startsWith("execute:") && l.includes("''"),
		);
		expect(beforeIdx).toBeLessThan(innerIdx);
		expect(innerIdx).toBeLessThan(afterIdx);
	});

	test("PostgresJsTransaction: no explicit tx opened (no tx:begin)", async () => {
		const log: Log = [];
		const txDb = mockPostgresJsTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
	});

	test("PostgresJsTransaction: relational query also works", async () => {
		const log: Log = [];
		const txDb = mockPostgresJsTxDb(log);
		const wrapped = withMiddleware(txDb, () => ({
			before: [sql`SELECT set_config('a', 'x', true)`],
		}));

		const prepared = wrapped.session.prepareRelationalQuery({
			sql: "SELECT rel",
		});
		await prepared.execute();

		const execEntries = log.filter((l: string) => l.startsWith("execute:"));
		expect(execEntries.length).toBe(2);
	});

	test("covers every PG session in drizzle-orm-beta", () => {
		const sessionKinds = new Set<string>();
		for (const dir of readdirSync("node_modules/drizzle-orm-beta", {
			withFileTypes: true,
		})) {
			if (!dir.isDirectory()) continue;
			try {
				const source = require("node:fs").readFileSync(
					`node_modules/drizzle-orm-beta/${dir.name}/session.js`,
					"utf8",
				);
				if (!source.includes("PgAsyncSession") && !source.includes("PgSession"))
					continue;
				for (const match of source.matchAll(
					/\[entityKind\]\s*=\s*"([^"]*Session[^"]*)"/g,
				)) {
					if (match[1] !== "PgSession") sessionKinds.add(match[1]!);
				}
			} catch {
				// The driver does not expose a runtime session module.
			}
		}

		expect(sessionKinds).toEqual(EXPECTED_SESSION_KINDS);
	});

	test("every Drizzle PG session and prepared-query member is reviewed", () => {
		const { unknown, overlap, leakyMethods, classNames, unparsed } =
			reviewDrizzlePgMembers();
		expect(unparsed).toEqual([]);

		// The parser must find the drivers, or the checks below prove nothing.
		for (const name of [
			"PgAsyncSession",
			"NodePgSession",
			"NeonHttpSession",
			"PostgresJsPreparedQuery",
			"PglitePreparedQuery",
		])
			expect(classNames).toContain(name);

		// A new member must be added to the allowed or the denied list in
		// src/pg-guard.ts after review. Until then the guard blocks it.
		expect(unknown).toEqual([]);
		expect(overlap).toEqual([]);
		// An allowed method that is not intercepted must read only allowed
		// members, so it cannot reach the driver.
		expect(leakyMethods).toEqual([]);
	});
});
