import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { entityKind, sql } from "drizzle-orm-beta";
import { CasingCache } from "drizzle-orm-beta/casing";
import { PgAsyncDatabase, integer, pgTable } from "drizzle-orm-beta/pg-core";
import {
	type BatchMiddleware,
	PG_DRIVER_KINDS,
	withBatchMiddleware,
} from "./src/beta/pg-batch.ts";

type Log = string[];

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withBatchMiddleware (beta/pg)", () => {
	test("returns a new db instance", () => {
		const db = mockDb([]);
		const wrapped = withBatchMiddleware(db, () => ({}));
		expect(wrapped).not.toBe(db);
	});

	test("preserves $client and $cache", () => {
		const db = mockDb([]);
		db.$client = { fake: "client" };
		db.$cache = { fake: "cache" };
		const wrapped = withBatchMiddleware(db, () => ({}));
		expect(wrapped.$client).toEqual({ fake: "client" });
		expect(wrapped.$cache).toEqual({ fake: "cache" });
	});

	test("fast path: no before/after skips transaction", async () => {
		const log: Log = [];
		const db = mockDb(log);
		const wrapped = withBatchMiddleware(db, () => ({}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		expect(log).toEqual(["prepareQuery:SELECT 1", "execute:SELECT 1"]);
		expect(log).not.toContain("tx:begin");
	});

	test("before + inner are concatenated into one statement", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const middleware: BatchMiddleware = () => ({
			before: [
				sql`SELECT set_config('a', 'one', true)`,
				sql`SELECT set_config('b', 'two', true)`,
			],
		});
		const wrapped = withBatchMiddleware(db, middleware);

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

		const middleware: BatchMiddleware = () => ({
			after: [sql`SELECT set_config('a', '', true)`],
		});
		const wrapped = withBatchMiddleware(db, middleware);

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

		const middleware: BatchMiddleware = () => ({
			before: [sql`SELECT set_config('role', 'app', true)`],
			after: [sql`SELECT set_config('role', '', true)`],
		});
		const wrapped = withBatchMiddleware(db, middleware);

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
		const middleware: BatchMiddleware = () => ({
			before: [sql`SELECT set_config('app.tenant', ${tenantId}, true)`],
		});
		const wrapped = withBatchMiddleware(db, middleware);

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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const middleware: BatchMiddleware = () => ({
			before: [
				sql`SELECT set_config('a', 'x', true)`,
				sql`SELECT set_config('b', 'y', true)`,
			],
			after: [sql`SELECT set_config('a', '', true)`],
		});
		const wrapped = withBatchMiddleware(db, middleware);

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
		const wrapped = withBatchMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const txConfig = { isolationLevel: "serializable" };
		await wrapped.session.transaction(async () => "ok", txConfig);

		expect(receivedConfig).toEqual(txConfig);
	});

	test("prepareRelationalQuery is also wrapped", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withBatchMiddleware(db, () => ({
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

	test("non-intercepted session properties pass through", () => {
		const log: Log = [];
		const db = mockDb(log);
		db.session.customProp = "hello";

		const wrapped = withBatchMiddleware(db, () => ({}));
		expect(wrapped.session.customProp).toBe("hello");
	});

	// -------------------------------------------------------------------
	// Result mapping
	// -------------------------------------------------------------------

	test("customResultMapper is applied to the extracted inner result", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withBatchMiddleware(db, () => ({
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

	test("result is returned unmodified when no fields/mapper", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withBatchMiddleware(db, () => ({
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
		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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
	// Driver coverage drift detection
	// -------------------------------------------------------------------

	test("PG_DRIVER_KINDS covers every PG session in drizzle-orm-beta", () => {
		const ABSTRACT_KINDS = new Set(["PgSession"]);
		const sessionKinds = new Set<string>();
		const dirs = readdirSync("node_modules/drizzle-orm-beta", {
			withFileTypes: true,
		});
		for (const d of dirs) {
			if (!d.isDirectory()) continue;
			let sessionSrc: string;
			try {
				sessionSrc = require("node:fs").readFileSync(
					`node_modules/drizzle-orm-beta/${d.name}/session.js`,
					"utf8",
				);
			} catch {
				continue;
			}
			if (
				!sessionSrc.includes("PgAsyncSession") &&
				!sessionSrc.includes("PgSession")
			)
				continue;
			const matches = sessionSrc.matchAll(
				/\[entityKind\]\s*=\s*"([^"]*Session[^"]*)"/g,
			);
			for (const m of matches) {
				if (!ABSTRACT_KINDS.has(m[1]!)) sessionKinds.add(m[1]!);
			}
		}

		const covered = new Set<string>(PG_DRIVER_KINDS);
		const uncovered = [...sessionKinds].filter((k) => !covered.has(k));
		const stale = [...covered].filter((k) => !sessionKinds.has(k));

		expect(uncovered).toEqual([]);
		expect(stale).toEqual([]);
	});
});
