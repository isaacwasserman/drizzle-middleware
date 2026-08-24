// ---------------------------------------------------------------------------
// Internal types — use `any` returns so the same code handles both
// sync and async call chains; the public API constrains appropriately.
// ---------------------------------------------------------------------------

export type InternalSession = {
	prepareQuery: (...args: any[]) => InternalPreparedQuery;
	transaction: (fn: (tx: any) => any, config?: unknown) => any;
};

export type InternalPreparedQuery = {
	execute: (
		placeholderValues?: Record<string, unknown>,
		...rest: unknown[]
	) => any;
	setToken?: (token: unknown) => InternalPreparedQuery;
	joinsNotNullableMap?: Record<string, boolean>;
};

export type MiddlewareFn = (next: () => any, tx: any) => any;

// ---------------------------------------------------------------------------
// Shared wrapping logic
// ---------------------------------------------------------------------------

function wrapSession(
	session: InternalSession,
	middleware: MiddlewareFn,
): InternalSession {
	return new Proxy(session, {
		get(target, prop, receiver) {
			if (prop === "prepareQuery") {
				return (...args: any[]) => {
					const prepared = target.prepareQuery(...args);
					return wrapPreparedQuery(prepared, args, target, middleware);
				};
			}
			if (prop === "transaction") {
				return (fn: (tx: any) => any, config?: unknown) => {
					return target.transaction(
						(tx) => middleware(() => fn(tx), tx),
						config,
					);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

const EXEC_METHODS = new Set(["execute", "run", "all", "get", "values"]);

function wrapPreparedQuery(
	prepared: InternalPreparedQuery,
	capturedArgs: unknown[],
	session: InternalSession,
	middleware: MiddlewareFn,
): InternalPreparedQuery {
	let storedToken: unknown;
	return new Proxy(prepared, {
		get(target, prop, receiver) {
			if (
				typeof prop === "string" &&
				EXEC_METHODS.has(prop) &&
				typeof (target as any)[prop] === "function"
			) {
				return (...args: any[]) => {
					return session.transaction((tx) => {
						return middleware(() => {
							const txSession = (tx as any).session as InternalSession;
							const txPrepared = txSession.prepareQuery(...capturedArgs) as any;
							if (storedToken && txPrepared.setToken)
								txPrepared.setToken(storedToken);
							if (target.joinsNotNullableMap)
								txPrepared.joinsNotNullableMap = target.joinsNotNullableMap;
							return txPrepared[prop](...args);
						}, tx);
					});
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

export function buildWrappedDb(
	db: any,
	middleware: MiddlewareFn,
	makeArgs: (d: any, wrappedSession: any, schemaArg: any) => any[],
): any {
	const wrappedSession = wrapSession(db.session, middleware);
	const schemaArg = db._.schema
		? {
				schema: db._.schema,
				fullSchema: db._.fullSchema,
				tableNamesMap: db._.tableNamesMap,
			}
		: undefined;
	const newDb = new db.constructor(...makeArgs(db, wrappedSession, schemaArg));
	if (db.$client) newDb.$client = db.$client;
	if (db.$cache) newDb.$cache = db.$cache;
	return newDb;
}
