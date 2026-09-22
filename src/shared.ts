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
	execBatch?: (statements: string[], session: any, arrayMode?: boolean) => any;
}

// A wrapped session advertises its middleware layer under this symbol. That is
// how an outer middleware layer and `executeBatchTransaction` discover the full
// stack and honor every layer's before/after instead of silently bypassing one.
const MW_STATE: unique symbol = Symbol.for("drizzle-middleware.state");

// A wrapped prepared query advertises the underlying real prepared query here,
// so the fast path can run it directly without re-invoking any middleware.
const RAW_PREPARED: unique symbol = Symbol.for(
	"drizzle-middleware.rawPrepared",
);

type MiddlewareState = {
	middleware: Middleware;
	config: MiddlewareConfig;
	dialect: any;
	baseSession: InternalSession;
};

// One capturable query: its SQL AST plus everything needed to map its result.
type EnvelopeItem = {
	sqlObj: SQL;
	capturedArgs: unknown[];
	rowMode: "array" | "object";
	joinsNotNullableMap: Record<string, boolean> | undefined;
};

function hasCustomResultMapper(capturedArgs: unknown[]): boolean {
	for (let i = capturedArgs.length - 1; i >= 2; i--) {
		if (typeof capturedArgs[i] === "function") return true;
	}
	return false;
}

// Drizzle supplies `isResponseInArrayMode` as the fourth `prepareQuery`
// argument. Honor it for queries whose fields or custom mapper consume mapped
// rows. This is deliberately not inferred solely from the presence of a custom
// mapper: `$count()` and the legacy relational builder both use custom mappers
// over positional rows, whereas `prepareRelationalQuery` mappers consume object
// rows. Queries with neither fields nor a mapper preserve the driver's native
// raw result, as Drizzle's own sessions do.
function getRowMode(
	prepareMethod: string,
	capturedArgs: unknown[],
): "array" | "object" {
	if (
		prepareMethod === "prepareRelationalQuery" ||
		prepareMethod === "prepareOneTimeRelationalQuery"
	) {
		return "object";
	}
	if (capturedArgs[1] === undefined && !hasCustomResultMapper(capturedArgs)) {
		return "object";
	}
	return capturedArgs[3] === true ? "array" : "object";
}

// Walk a session's middleware chain from outermost to innermost.
function walkStates(session: any): MiddlewareState[] {
	const states: MiddlewareState[] = [];
	let s: any = session;
	while (s?.[MW_STATE]) {
		const state = s[MW_STATE] as MiddlewareState;
		states.push(state);
		s = state.baseSession;
	}
	return states;
}

// Peel every middleware proxy off a session to reach the real driver session,
// so we can send the batch without re-triggering any layer's interception.
function rawSession(session: any): InternalSession {
	let s: any = session;
	while (s?.[MW_STATE]) s = (s[MW_STATE] as MiddlewareState).baseSession;
	return s as InternalSession;
}

// Invoke every layer once and combine: before runs outermost-first, after runs
// innermost-first (onion order), so the stack composes like nested wrappers.
function stackBeforeAfter(states: MiddlewareState[]): {
	before: SQL[];
	after: SQL[];
} {
	const batches = states.map((s) => s.middleware());
	const before: SQL[] = [];
	const after: SQL[] = [];
	for (const b of batches) if (b.before) before.push(...b.before);
	for (let i = batches.length - 1; i >= 0; i--) {
		const a = batches[i]?.after;
		if (a) after.push(...a);
	}
	return { before, after };
}

// Drizzle exposes the native driver on `session.client` (or `httpClient` for
// Netlify). Prefer capabilities over a growing list of Drizzle session names.
//
// `arrayMode` requests positional array rows (each driver's own array-mode API,
// mirrored from Drizzle's sessions). Callers use it for field-based queries so
// duplicate column labels survive; object rows are kept for custom mappers.
export function executeBatch(
	statements: string[],
	session: any,
	arrayMode = false,
): any {
	const client = session.client;
	const joined = statements.join(";\n");

	if (client?.batch) {
		// libSQL returns array-like rows already, so no array-mode flag is needed.
		const queries = client.prepare
			? statements.map((statement) => client.prepare(statement))
			: statements.map((sql) => ({ sql, args: [] }));
		return client.batch(queries);
	}
	if (client?.exec)
		return client.exec(joined, arrayMode ? { rowMode: "array" } : undefined);
	if (client?.unsafe) {
		const query = client.unsafe(joined);
		return arrayMode && typeof query?.values === "function"
			? query.values()
			: query;
	}

	const httpClient =
		session.httpClient ??
		(client?.transaction && (client.query || typeof client === "function")
			? client
			: undefined);
	if (httpClient?.transaction) {
		const query = httpClient.query ?? client?.query ?? client;
		if (typeof query === "function") {
			return httpClient.transaction(
				statements.map((sql) =>
					query(sql, [], { arrayMode, fullResults: true }),
				),
			);
		}
	}

	if (client?.query)
		return arrayMode
			? client.query({ text: joined, rowMode: "array" })
			: client.query(joined);
	if (client?.transaction && client?.prepare) {
		return client.transaction(async () => {
			const results = [];
			for (const sql of statements)
				results.push(await client.prepare(sql).execute());
			return results;
		})();
	}
}

// Send inlined statements in one round trip: try the driver's native batch
// mechanism, and fall back to a single multi-statement prepared query when the
// driver exposes none. Shared by the middleware and `executeBatchTransaction`.
function dispatchBatch(
	parts: string[],
	session: InternalSession,
	rawPrepareArgs: any[],
	execBatch:
		| ((statements: string[], session: any, arrayMode?: boolean) => any)
		| undefined,
	storedToken: unknown,
	arrayMode: boolean,
): any {
	let rawResult = execBatch?.(parts, session, arrayMode);
	if (rawResult === undefined) {
		const rawPrepared = session.prepareQuery(
			{ sql: parts.join(";\n"), params: [] },
			...rawPrepareArgs,
		);
		if (storedToken && rawPrepared.setToken) rawPrepared.setToken(storedToken);
		rawResult = rawPrepared.execute();
	}
	return rawResult;
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

// Sync envelope: run before, the items, and after individually inside one
// native transaction (sync drivers cannot return per-statement batch results).
function runEnvelopeSync(
	before: SQL[],
	items: ((txSession: InternalSession) => any)[],
	after: SQL[],
	session: InternalSession,
	dialect: any,
	config: MiddlewareConfig,
): any[] {
	return session.transaction((tx) => {
		const txSession = (tx as any).session as InternalSession;
		for (const s of before) execSyncSideEffect(s, dialect, txSession, config);
		const results = items.map((run) => run(txSession));
		for (const s of after) execSyncSideEffect(s, dialect, txSession, config);
		return results;
	});
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
	const results = runEnvelopeSync(
		before,
		[
			(txSession) => {
				const txPrepared = (txSession as any)[prepareMethod](...capturedArgs);
				if (storedToken && txPrepared.setToken)
					txPrepared.setToken(storedToken);
				if (joinsNotNullableMap)
					txPrepared.joinsNotNullableMap = joinsNotNullableMap;
				return txPrepared[prop](...execArgs);
			},
		],
		after,
		rawSession(session),
		dialect,
		config,
	);
	return results[0];
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

// Async envelope: inline before + every item + after into one payload, send it
// in a single round trip, then map each item's slice of the result back.
function runEnvelopeAsync(
	before: SQL[],
	items: EnvelopeItem[],
	after: SQL[],
	session: InternalSession,
	dialect: any,
	rawPrepareArgs: any[],
	execBatch:
		| ((statements: string[], session: any, arrayMode?: boolean) => any)
		| undefined,
	storedToken: unknown,
): Promise<any[]> {
	const parts: string[] = [];
	for (const s of before) parts.push(inlineSql(s, dialect));
	for (const it of items) parts.push(inlineSql(it.sqlObj, dialect));
	for (const s of after) parts.push(inlineSql(s, dialect));

	const rowModes = new Set(items.map((it) => it.rowMode));
	if (rowModes.size > 1) {
		throw new Error(
			"executeBatchTransaction: cannot batch queries with mixed array- and object-mode results. Run them separately so Drizzle can preserve each query's result shape.",
		);
	}

	// Positional rows preserve duplicate column labels and are also the shape
	// declared by custom mappers such as `$count()`. Object mode is reserved for
	// relational mappers, which use column names to reconstruct nested results.
	const arrayMode = rowModes.has("array");

	const rawResult = dispatchBatch(
		parts,
		session,
		rawPrepareArgs,
		execBatch,
		storedToken,
		arrayMode,
	);
	return Promise.resolve(rawResult).then((result) =>
		items.map((it, i) =>
			mapExtractedResult(
				extractInnerResult(result, before.length + i),
				it.capturedArgs,
				it.joinsNotNullableMap,
			),
		),
	);
}

function execAsync(
	before: SQL[],
	after: SQL[],
	capturedSqlObj: SQL,
	capturedArgs: unknown[],
	prepareMethod: string,
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

	return runEnvelopeAsync(
		before,
		[
			{
				sqlObj: resolvedSql,
				capturedArgs,
				rowMode: getRowMode(prepareMethod, capturedArgs),
				joinsNotNullableMap,
			},
		],
		after,
		rawSession(session),
		dialect,
		config.rawPrepareArgs(),
		config.execBatch,
		storedToken,
	).then((results) => results[0]);
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
			// Expose the innermost real prepared query so an outer layer (or the
			// fast path) can run it without re-triggering middleware.
			if (prop === RAW_PREPARED) return (target as any)[RAW_PREPARED] ?? target;

			if (
				typeof prop === "string" &&
				EXEC_METHODS.has(prop) &&
				typeof (target as any)[prop] === "function"
			) {
				return (...execArgs: any[]) => {
					// Collect this layer plus every inner layer, so a stack of
					// wrapped dbs composes instead of the outermost one winning.
					const states: MiddlewareState[] = [
						{ middleware, config, dialect, baseSession: session },
						...walkStates(session),
					];
					const { before, after } = stackBeforeAfter(states);

					if (before.length === 0 && after.length === 0) {
						const raw = (target as any)[RAW_PREPARED] ?? target;
						return raw[prop](...execArgs);
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
						prepareMethod,
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

	const state: MiddlewareState = {
		middleware,
		config,
		dialect,
		baseSession: session,
	};

	return new Proxy(session, {
		get(target, prop, receiver) {
			// Advertise this layer so outer layers and executeBatchTransaction can
			// walk the full middleware stack.
			if (prop === MW_STATE) return state;
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

// -----------------------------------------------------------------------
// executeBatchTransaction — run an array of Drizzle queries in one round trip.
//
// Runs through the same envelope as the middleware: each query is compiled to a
// parameter-inlined SQL string, the strings are sent in a single batch, and
// each query's slice of the result is mapped back with the query's own
// fields / customResultMapper. When the db is middleware-wrapped, every layer's
// before/after is applied once around the batch — the middleware is honored,
// never bypassed.
// -----------------------------------------------------------------------

// A Drizzle query builder is a thenable (QueryPromise). We only need the
// internal `_prepare` hook plus the writable `session` / `dialect` fields.
type BatchQuery = PromiseLike<unknown> & {
	session: InternalSession;
	dialect: any;
	_prepare: (...args: any[]) => unknown;
	execute: (...args: any[]) => any;
};

// Drive a query through `_prepare` with the session and dialect swapped for
// capturing stand-ins, so we grab the compiled SQL AST and the exact args
// Drizzle would pass to `prepareQuery` — without executing anything.
function collectQuery(
	query: BatchQuery,
	dialectCapture: ReturnType<typeof wrapDialectCapture>,
): EnvelopeItem {
	const origSession = query.session;
	const origDialect = query.dialect;

	let captured:
		| { args: unknown[]; prepareMethod: string; stub: any }
		| undefined;
	const makeStub = (prepareMethod: string, args: unknown[]) => {
		const stub: any = {
			joinsNotNullableMap: undefined as Record<string, boolean> | undefined,
			setToken: () => stub,
		};
		captured = { args, prepareMethod, stub };
		return stub;
	};

	const collectorSession = new Proxy(origSession, {
		get(target, prop, receiver) {
			if (
				prop === "prepareQuery" ||
				prop === "prepareRelationalQuery" ||
				prop === "prepareOneTimeRelationalQuery"
			) {
				return (...args: unknown[]) => makeStub(prop as string, args);
			}
			return Reflect.get(target, prop, receiver);
		},
	});

	query.session = collectorSession;
	query.dialect = dialectCapture.dialect;
	dialectCapture.lastCapturedSql = undefined;
	try {
		query._prepare();
	} finally {
		query.session = origSession;
		query.dialect = origDialect;
	}

	if (!captured || !dialectCapture.lastCapturedSql) {
		throw new Error(
			"executeBatchTransaction: could not capture a query. Pass Drizzle query builders (e.g. db.select()... / db.insert()...).",
		);
	}

	return {
		sqlObj: dialectCapture.lastCapturedSql,
		capturedArgs: captured.args,
		rowMode: getRowMode(captured.prepareMethod, captured.args),
		joinsNotNullableMap: captured.stub.joinsNotNullableMap,
	};
}

export function executeBatchTransaction<
	const T extends readonly PromiseLike<unknown>[],
>(
	queries: readonly [...T],
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
	type Results = { -readonly [K in keyof T]: Awaited<T[K]> };

	if (queries.length === 0) return Promise.resolve([] as unknown as Results);

	const list = queries as unknown as BatchQuery[];
	const first = list[0] as BatchQuery;
	const realDialect = first.dialect;
	const session = first.session;

	// Every query is batched onto the first query's session, so they must all
	// come from the same database instance. Mixing instances would silently run
	// some queries against the wrong connection, so reject it up front.
	for (let i = 1; i < list.length; i++) {
		if (list[i]?.session !== session || list[i]?.dialect !== realDialect) {
			throw new Error(
				`executeBatchTransaction: all queries must come from the same database instance (query at index ${i} does not match the first).`,
			);
		}
	}

	const kind: string | undefined = realDialect?.constructor?.[entityKind];

	// If the db is middleware-wrapped, gather the whole stack and apply each
	// layer's before/after once around the batch. Empty when unwrapped.
	const states = walkStates(session);
	const outer = states[0];
	const dialect = outer?.dialect ?? realDialect;
	const sendSession = rawSession(session);
	const { before, after } = stackBeforeAfter(states);

	// Sync SQLite runs in-process, so there is no round trip to collapse.
	// Run before, the queries, and after atomically in one native transaction.
	if (kind === "SQLiteSyncDialect") {
		const config =
			outer?.config ??
			({ txPrepareArgs: () => [undefined, "run", false] } as MiddlewareConfig);
		// `execute()` is async, but its body runs the query synchronously before
		// resolving — so every query still runs in-order inside the transaction.
		// We await the resolved wrappers afterwards.
		const pending = runEnvelopeSync(
			before,
			list.map((query) => (txSession: InternalSession) => {
				const origSession = query.session;
				query.session = txSession;
				try {
					return query.execute();
				} finally {
					query.session = origSession;
				}
			}),
			after,
			sendSession,
			dialect,
			config,
		);
		return Promise.all(pending) as Promise<Results>;
	}

	const dialectCapture = wrapDialectCapture(realDialect);
	const collected = list.map((query) => collectQuery(query, dialectCapture));

	const rawPrepareArgs = outer
		? outer.config.rawPrepareArgs()
		: kind === "SQLiteAsyncDialect"
			? [undefined, "all", false]
			: [undefined, undefined, false];
	const execBatch = outer ? outer.config.execBatch : executeBatch;

	return runEnvelopeAsync(
		before,
		collected,
		after,
		sendSession,
		dialect,
		rawPrepareArgs,
		execBatch,
		undefined,
	) as Promise<Results>;
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
