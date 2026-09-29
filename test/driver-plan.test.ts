import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DRIVER_PLAN, type SessionKind } from "../src/core/driver.ts";

// Abstract base classes, not drivers.
const BASE_KINDS = new Set([
	"PgSession",
	"PgAsyncSession",
	"PgEffectSession",
	"SQLiteSession",
]);

// Session kinds that Drizzle uses in more than one driver module. Each one
// must have a plan that fits every driver that shares it.
const SHARED_KINDS: Record<string, string[]> = {
	SQLJsSession: ["node-sqlite/session.js", "sql-js/session.js"],
};

function scanDrizzleSessionKinds(): Map<
	string,
	{ dialect: string; files: string[] }
> {
	const root = "node_modules/drizzle-orm-beta";
	const kinds = new Map<string, { dialect: string; files: string[] }>();
	for (const file of new Bun.Glob("**/session.js").scanSync(root)) {
		const source = readFileSync(`${root}/${file}`, "utf8");
		const dialect =
			source.includes("/pg-core/") || file.startsWith("pg-core/")
				? "pg"
				: source.includes("/sqlite-core/") || file.startsWith("sqlite-core/")
					? "sqlite"
					: undefined;
		if (!dialect) continue;
		for (const match of source.matchAll(
			/static \[entityKind\] = "([A-Za-z0-9]+Session)"/g,
		)) {
			const kind = match[1] as string;
			if (BASE_KINDS.has(kind)) continue;
			const entry = kinds.get(kind) ?? { dialect, files: [] };
			entry.files.push(file);
			kinds.set(kind, entry);
		}
	}
	return kinds;
}

describe("driver plan", () => {
	const scanned = scanDrizzleSessionKinds();

	test("plans every Postgres and SQLite session kind in the installed Drizzle", () => {
		expect([...scanned.keys()].sort()).toEqual(Object.keys(DRIVER_PLAN).sort());
	});

	test("each plan has the dialect of its Drizzle session", () => {
		for (const [kind, { dialect }] of scanned) {
			expect(`${kind}: ${DRIVER_PLAN[kind as SessionKind].dialect}`).toBe(
				`${kind}: ${dialect}`,
			);
		}
	});

	test("a kind shared by several driver modules is reviewed", () => {
		const shared = Object.fromEntries(
			[...scanned]
				.filter(([, { files }]) => files.length > 1)
				.map(([kind, { files }]) => [kind, files.sort()]),
		);
		expect(shared).toEqual(SHARED_KINDS);
	});

	test("the scan finds the drivers, so the checks above mean something", () => {
		for (const kind of [
			"NodePgSession",
			"PostgresJsSession",
			"SQLiteD1Session",
			"LibSQLSession",
		]) {
			expect(scanned.has(kind)).toBe(true);
		}
	});
});
