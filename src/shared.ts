import type { SQL } from "drizzle-orm-beta";
import { Param, entityKind, sql as sqlTag } from "drizzle-orm-beta";

// @ts-ignore — exported at runtime but missing from .d.ts
import { mapResultRow } from "drizzle-orm-beta/utils";

export type Middleware = () => {
	before?: SQL[];
	after?: SQL[];
};

type InternalPreparedQuery = {
	execute: (...args: any[]) => any;
	run?: (...args: any[]) => any;
	setToken?: (token: unknown) => InternalPreparedQuery;
	joinsNotNullableMap?: Record<string, boolean>;
};

type InternalSession = {
	prepareQuery: (...args: any[]) => InternalPreparedQuery;
	prepareRelationalQuery?: (...args: any[]) => InternalPreparedQuery;
	prepareOneTimeRelationalQuery?: (...args: any[]) => InternalPreparedQuery;
	transaction: (fn: (tx: any) => any, config?: unknown) => any;
};

const EXEC_METHODS = new Set(["execute", "run", "all", "get", "values"]);

function resolveChunk(chunk: any, values: Record<string, unknown>): any {
	if (!chunk) return chunk;
	const kind: string | undefined = chunk.constructor?.[entityKind];
	if (kind === "Placeholder") return new Param(values[chunk.name]);
	if (
		kind === "Param" &&
		chunk.value?.constructor?.[entityKind] === "Placeholder"
	)
		return new Param(values[chunk.value.name], chunk.encoder);
	if (kind === "SQL") return resolvePlaceholders(chunk, values);
	if (Array.isArray(chunk))
		return chunk.map((c: any) => resolveChunk(c, values));
	return chunk;
}

export function resolvePlaceholders(
	sqlObj: SQL,
	values: Record<string, unknown>,
): SQL {
	const chunks: any[] = (sqlObj as any).queryChunks;
	const resolved = new (sqlObj.constructor as any)(
		chunks.map((c) => resolveChunk(c, values)),
	);
	return resolved;
}

export function inlineSql(sqlObj: SQL, dialect: any): string {
	// `inlineParams()` mutates SQL, and middleware SQL is commonly reused across
	// requests. Preserve it by compiling a shallow clone instead.
	const inline = Object.assign(
		Object.create(Object.getPrototypeOf(sqlObj)),
		sqlObj,
		{ shouldInlineParams: true },
	);
	return dialect.sqlToQuery(inline).sql;
}

function extractInnerResult(rawResult: any, beforeCount: number): any {
	if (!Array.isArray(rawResult)) return rawResult;

	// A batched response is either an array of result objects (node-postgres,
	// PGlite, HTTP clients) or an array of row arrays (SQLite and postgres.js).
	// A normal result is an array of rows, which must be left untouched.
	const first = rawResult[0];
	return Array.isArray(first) ||
		first?.rows !== undefined ||
		first?.results !== undefined
		? rawResult[beforeCount]
		: rawResult;
}

export function mapExtractedResult(
	extracted: any,
	capturedArgs: unknown[],
	joinsNotNullableMap: Record<string, boolean> | undefined,
): any {
	const fields = capturedArgs[1] as any[] | undefined;
	let customResultMapper: ((...args: unknown[]) => unknown) | undefined;
	for (let i = capturedArgs.length - 1; i >= 2; i--) {
		if (typeof capturedArgs[i] === "function") {
			customResultMapper = capturedArgs[i] as (...args: unknown[]) => unknown;
			break;
		}
	}

	if (!fields && !customResultMapper) return extracted;

	const rows = extracted?.rows ?? extracted?.results ?? extracted;

	if (customResultMapper) return customResultMapper(rows);
	return rows.map((row: any) =>
		mapResultRow(
			fields,
			Array.isArray(row) ? row : Object.values(row),
			joinsNotNullableMap,
		),
	);
}

export function wrapDialectCapture(dialect: any): {
	dialect: any;
	lastCapturedSql: SQL | undefined;
} {
	const state = { dialect, lastCapturedSql: undefined as SQL | undefined };
	state.dialect = new Proxy(dialect, {
		get(target, prop, receiver) {
			if (prop === "sqlToQuery") {
				return (sqlObj: SQL, invokeSource?: string) => {
					state.lastCapturedSql = sqlObj;
					return target.sqlToQuery(sqlObj, invokeSource);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	return state;
}

export interface MiddlewareConfig {
	rawPrepareArgs: () => any[];
	txPrepareArgs: () => any[];
	makeDbArgs: (d: any, dialect: any, session: any, schemaArg: any) => any[];
	isSync?: boolean;
	isTransactionInput?: boolean;
	execBatch?: (statements: string[], session: any) => any;
}

const RAW_QUERY_CONFIG = { arrayMode: false, fullResults: true };

// Drizzle exposes the native driver on `session.client` (or `httpClient` for
// Netlify). Prefer capabilities over a growing list of Drizzle session names.
export function executeBatch(statements: string[], session: any): any {
	const client = session.client;
	const joined = statements.join(";\n");

	if (client?.batch) {
		const queries = client.prepare
			? statements.map((statement) => client.prepare(statement))
			: statements.map((sql) => ({ sql, args: [] }));
		return client.batch(queries);
	}
	if (client?.exec) return client.exec(joined);
	if (client?.unsafe) return client.unsafe(joined);

	const httpClient =
		session.httpClient ??
		(client?.transaction && (client.query || typeof client === "function")
			? client
			: undefined);
	if (httpClient?.transaction) {
		const query = httpClient.query ?? client?.query ?? client;
		if (typeof query === "function") {
			return httpClient.transaction(
				statements.map((sql) => query(sql, [], RAW_QUERY_CONFIG)),
			);
		}
	}

	if (client?.query) return client.query(joined);
	if (client?.transaction && client?.prepare) {
		return client.transaction(async () => {
			const results = [];
			for (const sql of statements)
				results.push(await client.prepare(sql).execute());
			return results;
		})();
	}
}

// -----------------------------------------------------------------------
// Sync execution path — queries run individually within a sync tx.
// Used by sync SQLite drivers where multi-statement prepared queries
// only process the first statement.
// -----------------------------------------------------------------------

function execSyncSideEffect(
	sqlObj: SQL,
	dialect: any,
	txSession: InternalSession,
	config: MiddlewareConfig,
) {
	const query = dialect.sqlToQuery(sqlObj);
	const prepared = txSession.prepareQuery(query, ...config.txPrepareArgs());
	prepared.run?.() ?? (prepared as any).execute?.()?.sync?.();
}

function execSync(
	before: SQL[],
	after: SQL[],
	capturedArgs: unknown[],
	prepareMethod: string,
	session: InternalSession,
	dialect: any,
	config: MiddlewareConfig,
	storedToken: unknown,
	joinsNotNullableMap: Record<string, boolean> | undefined,
	prop: string,
	execArgs: any[],
) {
	return session.transaction((tx) => {
		const txSession = (tx as any).session as InternalSession;

		for (const s of before) execSyncSideEffect(s, dialect, txSession, config);

		const txPrepared = (txSession as any)[prepareMethod](...capturedArgs);
		if (storedToken && txPrepared.setToken) txPrepared.setToken(storedToken);
		if (joinsNotNullableMap)
			txPrepared.joinsNotNullableMap = joinsNotNullableMap;

		const result = txPrepared[prop](...execArgs);

		for (const s of after) execSyncSideEffect(s, dialect, txSession, config);

		return result;
	});
}

// -----------------------------------------------------------------------
// Sync execution path — transaction input variant.
// Before/after run individually through the existing transaction session;
// the inner query executes via its original prepared query.
// -----------------------------------------------------------------------

function execSyncInTransaction(
	before: SQL[],
	after: SQL[],
	session: InternalSession,
	dialect: any,
	config: MiddlewareConfig,
	target: InternalPreparedQuery,
	prop: string,
	execArgs: any[],
) {
	for (const s of before) execSyncSideEffect(s, dialect, session, config);
	const result = (target as any)[prop](...execArgs);
	for (const s of after) execSyncSideEffect(s, dialect, session, config);
	return result;
}

// -----------------------------------------------------------------------
// Async execution path — inlines all params, then delegates to
// config.execBatch which sends the statements in a single round trip
// using the driver's preferred mechanism (Simple Query, HTTP batch, etc).
// -----------------------------------------------------------------------

function execAsync(
	before: SQL[],
	after: SQL[],
	capturedSqlObj: SQL,
	capturedArgs: unknown[],
	session: InternalSession,
	dialect: any,
	config: MiddlewareConfig,
	storedToken: unknown,
	joinsNotNullableMap: Record<string, boolean> | undefined,
	execArgs: any[],
) {
	const placeholderValues = execArgs[0] as Record<string, unknown> | undefined;
	const resolvedSql = placeholderValues
		? resolvePlaceholders(capturedSqlObj, placeholderValues)
		: capturedSqlObj;

	const parts: string[] = [];
	for (const s of before) parts.push(inlineSql(s, dialect));
	parts.push(inlineSql(resolvedSql, dialect));
	for (const s of after) parts.push(inlineSql(s, dialect));

	let rawResult = config.execBatch?.(parts, session);
	if (rawResult === undefined) {
		const rawPrepared = session.prepareQuery(
			{ sql: parts.join(";\n"), params: [] },
			...config.rawPrepareArgs(),
		);
		if (storedToken && rawPrepared.setToken) rawPrepared.setToken(storedToken);
		rawResult = rawPrepared.execute();
	}
	return Promise.resolve(rawResult).then((result) => {
		const extracted = extractInnerResult(result, before.length);
		return mapExtractedResult(extracted, capturedArgs, joinsNotNullableMap);
	});
}

// -----------------------------------------------------------------------
// Async execution path — transaction input variant.
// Before/after are batched separately; the inner query executes via its
// original prepared query to stay within the input transaction.
// -----------------------------------------------------------------------

function execAsyncInTransaction(
	before: SQL[],
	after: SQL[],
	session: InternalSession,
	dialect: any,
	config: MiddlewareConfig,
	target: InternalPreparedQuery,
	prop: string,
	execArgs: any[],
) {
	const runBatch = async (stmts: SQL[]) => {
		const parts = stmts.map((s) => inlineSql(s, dialect));
		const result = config.execBatch?.(parts, session);
		if (result !== undefined) {
			await result;
			return;
		}
		for (const stmt of parts) {
			await session
				.prepareQuery({ sql: stmt, params: [] }, ...config.txPrepareArgs())
				.execute();
		}
	};

	return (async () => {
		if (before.length > 0) await runBatch(before);
		const result = await (target as any)[prop](...execArgs);
		if (after.length > 0) await runBatch(after);
		return result;
	})();
}

// -----------------------------------------------------------------------
// Proxy wrappers
// -----------------------------------------------------------------------

function wrapPreparedQuery(
	prepared: InternalPreparedQuery,
	capturedSqlObj: SQL,
	capturedArgs: unknown[],
	prepareMethod: string,
	session: InternalSession,
	dialect: any,
	middleware: Middleware,
	config: MiddlewareConfig,
): InternalPreparedQuery {
	let storedToken: unknown;

	return new Proxy(prepared, {
		get(target, prop, receiver) {
			if (
				typeof prop === "string" &&
				EXEC_METHODS.has(prop) &&
				typeof (target as any)[prop] === "function"
			) {
				return (...execArgs: any[]) => {
					const batch = middleware();
					const before = batch.before ?? [];
					const after = batch.after ?? [];

					if (before.length === 0 && after.length === 0) {
						return (target as any)[prop](...execArgs);
					}

					if (config.isTransactionInput) {
						if (config.isSync) {
							return execSyncInTransaction(
								before,
								after,
								session,
								dialect,
								config,
								target,
								prop,
								execArgs,
							);
						}
						return execAsyncInTransaction(
							before,
							after,
							session,
							dialect,
							config,
							target,
							prop,
							execArgs,
						);
					}

					if (config.isSync) {
						return execSync(
							before,
							after,
							capturedArgs,
							prepareMethod,
							session,
							dialect,
							config,
							storedToken,
							target.joinsNotNullableMap,
							prop,
							execArgs,
						);
					}

					return execAsync(
						before,
						after,
						capturedSqlObj,
						capturedArgs,
						session,
						dialect,
						config,
						storedToken,
						target.joinsNotNullableMap,
						execArgs,
					);
				};
			}

			if (prop === "setToken" && target.setToken) {
				return (token: unknown) => {
					storedToken = token;
					target.setToken?.(token);
					return receiver;
				};
			}

			return Reflect.get(target, prop, receiver);
		},
	});
}

function txBoundary(
	target: InternalSession,
	dialect: any,
	middleware: Middleware,
	config: MiddlewareConfig,
	fn: (tx: any) => any,
	txConfig?: unknown,
) {
	const handler = config.isSync
		? (tx: any) => {
				const txSession = (tx as any).session as InternalSession;
				const batch = middleware();

				for (const s of batch.before ?? [])
					execSyncSideEffect(s, dialect, txSession, config);

				const result = fn(tx);

				for (const s of batch.after ?? [])
					execSyncSideEffect(s, dialect, txSession, config);

				return result;
			}
		: async (tx: any) => {
				const txSession = (tx as any).session as InternalSession;
				const batch = middleware();

				for (const s of batch.before ?? []) {
					const q = dialect.sqlToQuery(s);
					await txSession.prepareQuery(q, ...config.txPrepareArgs()).execute();
				}

				const result = await fn(tx);

				for (const s of batch.after ?? []) {
					const q = dialect.sqlToQuery(s);
					await txSession.prepareQuery(q, ...config.txPrepareArgs()).execute();
				}

				return result;
			};

	return target.transaction(handler, txConfig);
}

export function wrapSession(
	session: InternalSession,
	dialectCapture: ReturnType<typeof wrapDialectCapture>,
	middleware: Middleware,
	config: MiddlewareConfig,
): InternalSession {
	const { dialect } = dialectCapture;

	return new Proxy(session, {
		get(target, prop, receiver) {
			if (prop === "prepareQuery") {
				return (...args: any[]) => {
					const sqlObj =
						dialectCapture.lastCapturedSql ??
						sqlTag.raw((args[0] as any)?.sql ?? "");
					dialectCapture.lastCapturedSql = undefined;
					const prepared = target.prepareQuery(...args);
					return wrapPreparedQuery(
						prepared,
						sqlObj,
						args,
						"prepareQuery",
						target,
						dialect,
						middleware,
						config,
					);
				};
			}
			if (
				(prop === "prepareRelationalQuery" ||
					prop === "prepareOneTimeRelationalQuery") &&
				typeof (target as any)[prop] === "function"
			) {
				return (...args: any[]) => {
					const sqlObj =
						dialectCapture.lastCapturedSql ??
						sqlTag.raw((args[0] as any)?.sql ?? "");
					dialectCapture.lastCapturedSql = undefined;
					const prepared = (target as any)[prop](...args);
					return wrapPreparedQuery(
						prepared,
						sqlObj,
						args,
						prop as string,
						target,
						dialect,
						middleware,
						config,
					);
				};
			}
			if (prop === "transaction") {
				return (fn: (tx: any) => any, txConfig?: unknown) =>
					txBoundary(target, dialect, middleware, config, fn, txConfig);
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

export function buildWrappedDb(
	db: any,
	middleware: Middleware,
	config: MiddlewareConfig,
): any {
	const dialectCapture = wrapDialectCapture(db.dialect);
	const wrappedSession = wrapSession(
		db.session,
		dialectCapture,
		middleware,
		config,
	);

	const schemaArg = db._.schema
		? {
				schema: db._.schema,
				fullSchema: db._.fullSchema,
				tableNamesMap: db._.tableNamesMap,
			}
		: undefined;

	const newDb = new db.constructor(
		...config.makeDbArgs(db, dialectCapture.dialect, wrappedSession, schemaArg),
	);
	if (db.$client) newDb.$client = db.$client;
	if (db.$cache) newDb.$cache = db.$cache;
	return newDb;
}
