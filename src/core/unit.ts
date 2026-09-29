// A unit: `before`, one or more queries, `after`, run with the driver's
// strategy. See docs/design.md, sections 3 and 4.

import { DrizzleQueryError, SQL, is } from "drizzle-orm-beta";
import {
	type Dialect,
	type DrizzleSession,
	type ExecMethod,
	type PrepareMethod,
	copyPreparedState,
	prepareOn,
	readMember,
	runExec,
} from "../internal/drizzle.js";
import { type Driver, type Execution, assertNever } from "./driver.js";
import { runRecordedBatch } from "./engine.js";
import type { Middleware } from "./types.js";

/** How a dialect runs a middleware statement. */
export interface DialectRules {
	readonly name: Dialect;
	/** `prepareQuery` arguments after the query, for a middleware statement. */
	readonly statementArgs: readonly unknown[];
	/** The prepared-query method that runs a middleware statement. */
	readonly statementExec: ExecMethod;
	/** The prepared-query methods that the wrapped prepared query intercepts. */
	readonly execMethods: ReadonlySet<ExecMethod>;
}

export const PG_RULES: DialectRules = {
	name: "pg",
	statementArgs: [undefined, undefined, false],
	statementExec: "execute",
	execMethods: new Set<ExecMethod>(["execute", "all", "values"]),
};

// SQLite's `execute()` calls `this[this.executeMethod]()`, so it reaches the
// intercepted methods through the proxy and is not intercepted itself.
export const SQLITE_RULES: DialectRules = {
	name: "sqlite",
	statementArgs: [undefined, "run", false],
	statementExec: "run",
	execMethods: new Set<ExecMethod>(["run", "all", "get", "values"]),
};

/** The combined statements of all stacked layers for one unit. */
export interface Statements {
	readonly before: readonly SQL[];
	readonly after: readonly SQL[];
}

export function isEmpty(statements: Statements): boolean {
	return statements.before.length === 0 && statements.after.length === 0;
}

function checkedStatements(value: unknown, key: "before" | "after"): SQL[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((s: unknown) => is(s, SQL)))
		throw new TypeError(
			`drizzle-middleware: the middleware factory must return { before?: SQL[]; after?: SQL[] }; \`${key}\` is not an array of Drizzle SQL objects`,
		);
	return value;
}

/**
 * Calls each layer's factory once. `before` runs outermost layer first,
 * `after` innermost layer first, like nested wrappers.
 */
export function collectStatements(layers: readonly Middleware[]): Statements {
	const results = layers.map((factory) => {
		const result: unknown = factory();
		if (typeof result !== "object" || result === null)
			throw new TypeError(
				"drizzle-middleware: the middleware factory must return { before?: SQL[]; after?: SQL[] }",
			);
		return {
			before: checkedStatements(Reflect.get(result, "before"), "before"),
			after: checkedStatements(Reflect.get(result, "after"), "after"),
		};
	});
	return {
		before: results.flatMap((r) => r.before),
		after: [...results].reverse().flatMap((r) => r.after),
	};
}

/** One Drizzle query of a unit: how to prepare it again, and how to run it. */
export interface QueryItem {
	readonly prepareMethod: PrepareMethod;
	readonly prepareArgs: readonly unknown[];
	readonly execMethod: ExecMethod;
	readonly execArgs: readonly unknown[];
	readonly token: unknown;
	readonly joinsNotNullableMap: unknown;
}

export interface UnitTarget {
	readonly driver: Driver;
	/** The real session: the db's, or its transaction's in `wrapped.transaction(fn)`. */
	readonly session: DrizzleSession;
	/** True when `session` is already inside a transaction. */
	readonly inTransaction: boolean;
	readonly rules: DialectRules;
}

type Step = (session: DrizzleSession) => unknown;

function queryStep(item: QueryItem): Step {
	return (session) => {
		const prepared = prepareOn(session, item.prepareMethod, item.prepareArgs);
		copyPreparedState(prepared, item);
		return runExec(prepared, item.execMethod, item.execArgs);
	};
}

function statementStep(statement: SQL, rules: DialectRules): Step {
	return (session) => {
		const query = session.dialect.sqlToQuery(statement);
		const prepared = prepareOn(session, "prepareQuery", [
			query,
			...rules.statementArgs,
		]);
		return runExec(prepared, rules.statementExec, []);
	};
}

/**
 * Drizzle's error for the unit's first query, for an error of no statement:
 * the transaction driver's COMMIT. Without middleware, the query's own
 * commit fails, and Drizzle reports it on the query.
 */
function commitError(items: readonly QueryItem[], error: unknown): unknown {
	const query = items[0]?.prepareArgs[0];
	const text = readMember(query, "sql");
	const params = readMember(query, "params");
	if (typeof text !== "string" || !Array.isArray(params)) return error;
	return new DrizzleQueryError(
		text,
		params,
		error instanceof Error ? error : new Error(String(error)),
	);
}

/** A query on a transaction that has ended, which would skip the middleware. */
export function transactionEnded(): Error {
	return new Error(
		"drizzle-middleware: the transaction has ended. A query on its `tx` now would run outside the transaction, without the middleware.",
	);
}

/**
 * Runs a unit and returns the result of each query item, in order. Returns a
 * promise, except for a sync driver, which returns the values directly.
 */
export function runUnit(
	target: UnitTarget,
	statements: Statements,
	items: readonly QueryItem[],
): unknown[] | Promise<unknown[]> {
	const steps: Step[] = [
		...statements.before.map((s) => statementStep(s, target.rules)),
		...items.map(queryStep),
		...statements.after.map((s) => statementStep(s, target.rules)),
	];
	const first = statements.before.length;
	const pick = (values: readonly unknown[]) =>
		values.slice(first, first + items.length);
	const { driver } = target;
	// An error of no statement (the COMMIT) belongs to the unit's first query.
	let stepFailed = false;
	const counted =
		(step: Step): Step =>
		(session) => {
			try {
				const result = step(session);
				if (result instanceof Promise)
					return result.catch((error: unknown) => {
						stepFailed = true;
						throw error;
					});
				return result;
			} catch (error) {
				stepFailed = true;
				throw error;
			}
		};
	const onQuery = (error: unknown): unknown =>
		stepFailed ? error : commitError(items, error);

	switch (driver.kind) {
		case "batch": {
			const executions: Execution[] = steps.map(
				(step) => (session) => Promise.resolve().then(() => step(session)),
			);
			return driver
				.use((spec) =>
					runRecordedBatch(
						spec,
						target.session,
						executions,
						{ inTransaction: target.inTransaction },
						items.length > 0 ? first : 0,
					),
				)
				.then(pick);
		}
		case "transaction": {
			if (driver.mode === "sync") {
				const body = (session: DrizzleSession) =>
					steps.map((step) => counted(step)(session));
				if (target.inTransaction) return pick(body(target.session));
				try {
					return pick(driver.run(target.session, body));
				} catch (error) {
					throw onQuery(error);
				}
			}
			const body = async (session: DrizzleSession) => {
				const values: unknown[] = [];
				for (const step of steps) values.push(await counted(step)(session));
				return values;
			};
			return (
				target.inTransaction
					? body(target.session)
					: driver.run(target.session, body).catch((error: unknown) => {
							throw onQuery(error);
						})
			).then(pick);
		}
		case "rejected":
			throw new Error(
				`drizzle-middleware: not compatible with this driver: ${driver.reason}`,
			);
		default:
			return assertNever(driver);
	}
}
