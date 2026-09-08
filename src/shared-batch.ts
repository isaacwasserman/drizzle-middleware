import type { SQL } from "drizzle-orm-beta";
import { Param, entityKind, sql as sqlTag } from "drizzle-orm-beta";

// @ts-ignore — exported at runtime but missing from .d.ts
import { mapResultRow } from "drizzle-orm-beta/utils";

export type BatchMiddleware = () => {
	before?: SQL[];
	after?: SQL[];
};

export type ExtractInnerResult = (
	rawResult: any,
	beforeCount: number,
	afterCount: number,
	session: any,
) => any;

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
	const prev = (sqlObj as any).shouldInlineParams;
	(sqlObj as any).shouldInlineParams = true;
	const result = dialect.sqlToQuery(sqlObj).sql;
	(sqlObj as any).shouldInlineParams = prev;
	return result;
}

export function mapExtractedResult(
	extracted: any,
	capturedArgs: unknown[],
	joinsNotNullableMap: Record<string, boolean> | undefined,
): any {
	const fields = capturedArgs[1] as any[] | undefined;
	const customResultMapper = capturedArgs[4] as
		| ((...args: any[]) => any)
		| undefined;

	if (!fields && !customResultMapper) return extracted;

	const rows = extracted?.rows ?? extracted;

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

export interface BatchConfig {
	extractInnerResult: ExtractInnerResult;
	rawPrepareArgs: () => any[];
	txPrepareArgs: () => any[];
	makeDbArgs: (d: any, dialect: any, session: any, schemaArg: any) => any[];
	isSync?: boolean;
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
	config: BatchConfig,
) {
	const query = dialect.sqlToQuery(sqlObj);
	const prepared = txSession.prepareQuery(query, ...config.txPrepareArgs());
	prepared.run?.() ?? (prepared as any).execute?.()?.sync?.();
}

function execBatchSync(
	before: SQL[],
	after: SQL[],
	capturedArgs: unknown[],
	prepareMethod: string,
	session: InternalSession,
	dialect: any,
	config: BatchConfig,
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
// Async execution path — concatenates all queries into one round-trip.
// Placeholder params in the inner query are resolved from execArgs
// before inlining so they become concrete literals in the SQL string.
// -----------------------------------------------------------------------

function execBatchAsync(
	before: SQL[],
	after: SQL[],
	capturedSqlObj: SQL,
	capturedArgs: unknown[],
	session: InternalSession,
	dialect: any,
	config: BatchConfig,
	storedToken: unknown,
	joinsNotNullableMap: Record<string, boolean> | undefined,
	prop: string,
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

	// PostgreSQL executes all statements in one Simple Query message inside an
	// implicit transaction. Executing on the existing session is therefore both
	// atomic and a true single round trip; wrapping this in session.transaction()
	// would add separate BEGIN/COMMIT round trips (or nested savepoints).
	const concatenated = parts.join(";\n");
	const rawPrepared = session.prepareQuery(
		{ sql: concatenated, params: [] },
		...config.rawPrepareArgs(),
	);
	if (storedToken && rawPrepared.setToken) rawPrepared.setToken(storedToken);

	const rawResult = rawPrepared.execute();
	return Promise.resolve(rawResult).then((result) => {
		const extracted = config.extractInnerResult(
			result,
			before.length,
			after.length,
			session,
		);
		return mapExtractedResult(extracted, capturedArgs, joinsNotNullableMap);
	});
}

// -----------------------------------------------------------------------
// Proxy wrappers
// -----------------------------------------------------------------------

function wrapPreparedQueryBatch(
	prepared: InternalPreparedQuery,
	capturedSqlObj: SQL,
	capturedArgs: unknown[],
	prepareMethod: string,
	session: InternalSession,
	dialect: any,
	middleware: BatchMiddleware,
	config: BatchConfig,
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

					if (config.isSync) {
						return execBatchSync(
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

					return execBatchAsync(
						before,
						after,
						capturedSqlObj,
						capturedArgs,
						session,
						dialect,
						config,
						storedToken,
						target.joinsNotNullableMap,
						prop,
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
	config: BatchConfig,
	fn: (tx: any) => any,
	txConfig?: unknown,
) {
	const handler = config.isSync
		? (tx: any) => {
				const txSession = (tx as any).session as InternalSession;
				const batch: ReturnType<BatchMiddleware> = (config as any)._mw();

				for (const s of batch.before ?? [])
					execSyncSideEffect(s, dialect, txSession, config);

				const result = fn(tx);

				for (const s of batch.after ?? [])
					execSyncSideEffect(s, dialect, txSession, config);

				return result;
			}
		: async (tx: any) => {
				const txSession = (tx as any).session as InternalSession;
				const batch: ReturnType<BatchMiddleware> = (config as any)._mw();

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

export function wrapSessionBatch(
	session: InternalSession,
	dialectCapture: ReturnType<typeof wrapDialectCapture>,
	middleware: BatchMiddleware,
	config: BatchConfig,
): InternalSession {
	const { dialect } = dialectCapture;
	(config as any)._mw = middleware;

	return new Proxy(session, {
		get(target, prop, receiver) {
			if (prop === "prepareQuery") {
				return (...args: any[]) => {
					const sqlObj =
						dialectCapture.lastCapturedSql ??
						sqlTag.raw((args[0] as any)?.sql ?? "");
					dialectCapture.lastCapturedSql = undefined;
					const prepared = target.prepareQuery(...args);
					return wrapPreparedQueryBatch(
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
					return wrapPreparedQueryBatch(
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
					txBoundary(target, dialect, config, fn, txConfig);
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

export function buildBatchWrappedDb(
	db: any,
	middleware: BatchMiddleware,
	config: BatchConfig,
): any {
	const dialectCapture = wrapDialectCapture(db.dialect);
	const wrappedSession = wrapSessionBatch(
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
