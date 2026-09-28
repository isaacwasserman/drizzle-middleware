// The driver registry: one explicit entry per supported Drizzle session kind.
// A kind without an entry throws; the package does not guess.

import {
	DRIVER_PLAN,
	type Driver,
	type DriverEntry,
	type DriverPlan,
} from "../core/driver.js";
import {
	type Dialect,
	type DrizzleSession,
	sessionKindOf,
} from "../internal/drizzle.js";
import { nodePostgres } from "./node-postgres.js";
import { bunSqlPostgres, postgresJs } from "./postgres-js.js";
import {
	drizzleAsyncTransaction,
	drizzleSyncTransaction,
	serializedAsyncTransaction,
} from "./transactions.js";

const pglite: DriverEntry = {
	sessionKind: "PgliteSession",
	dialect: "pg",
	driverFor: () => drizzleAsyncTransaction("local-transaction"),
};

const bunSqlite: DriverEntry = {
	sessionKind: "SQLiteBunSession",
	dialect: "sqlite",
	driverFor: () => drizzleSyncTransaction,
};

const betterSqlite3: DriverEntry = {
	sessionKind: "BetterSQLiteSession",
	dialect: "sqlite",
	driverFor: () => drizzleSyncTransaction,
};

// Bun SQL with the SQLite adapter: in-process and async. Its multi-statement
// calls skip a failing statement and are not atomic, so a unit runs in
// Drizzle's own transaction (`client.begin`), one statement at a time. It has
// one connection and does not queue transactions: a concurrent `begin` throws,
// and a concurrent query joins the open transaction. So the client's work
// runs one item at a time.
const bunSqlSqlite: DriverEntry = {
	sessionKind: "BunSQLiteSession",
	dialect: "sqlite",
	driverFor: () => serializedAsyncTransaction(),
};

const ENTRIES: ReadonlyMap<string, DriverEntry> = new Map(
	[
		nodePostgres,
		postgresJs,
		bunSqlPostgres,
		pglite,
		bunSqlite,
		betterSqlite3,
		bunSqlSqlite,
	].map((entry) => [entry.sessionKind, entry]),
);

function planOf(kind: string): DriverPlan | undefined {
	return Object.entries(DRIVER_PLAN).find(([k]) => k === kind)?.[1];
}

/** The driver for a real session. Throws if the session's driver is not supported. */
export function driverFor(dialect: Dialect, session: DrizzleSession): Driver {
	const kind = sessionKindOf(session);
	const entry = ENTRIES.get(kind);
	if (entry !== undefined && entry.dialect === dialect) {
		const driver = entry.driverFor(session);
		if (driver.kind === "rejected")
			throw new TypeError(
				`drizzle-middleware: withMiddleware is not compatible with ${kind}: ${driver.reason}.`,
			);
		return driver;
	}
	const plan = planOf(kind);
	if (plan !== undefined && "rejected" in plan)
		throw new TypeError(
			`drizzle-middleware: withMiddleware is not compatible with ${kind}: ${plan.rejected}.`,
		);
	if (plan !== undefined)
		throw new TypeError(
			`drizzle-middleware: ${kind} is planned but not supported yet.`,
		);
	throw new TypeError(
		`drizzle-middleware: withMiddleware is not compatible with ${kind}: it is not a known Drizzle driver session.`,
	);
}
