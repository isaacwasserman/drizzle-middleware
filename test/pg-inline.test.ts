// The strict inline encoder (postgres-js with `prepare: false`).

import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm-beta/postgres-js";
import postgres from "postgres";
import {
	InlineError,
	findPlaceholders,
	postgresJsInference as infer,
	inlineParams,
	literal,
} from "../src/drivers/pg-inline.ts";

describe("inline encoder: placeholders", () => {
	test("replaces each placeholder with its literal", () => {
		expect(inlineParams("select $1, $2::int", ["a", 5], infer)).toBe(
			"select E'a', E'5'::int",
		);
	});

	test("leaves placeholders in strings, identifiers, dollar quotes and comments", () => {
		const sql = [
			"select $1",
			"'$1 in a string'",
			"E'$1 \\' still in an E-string'",
			'"$1 in an identifier"',
			"$$ $1 in dollar quotes $$",
			"$tag$ $1 $$ in a tagged dollar quote $tag$",
			"-- $1 in a line comment\n",
			"/* $1 /* nested */ in a block comment */",
			"a$1",
		].join(" ");
		expect(findPlaceholders(sql, 1).map((p) => p.index)).toEqual([1]);
		expect(inlineParams(sql, ["x"], infer).startsWith("select E'x' ")).toBe(
			true,
		);
	});

	// A backslash in a plain string literal is literal with
	// standard_conforming_strings on, and an escape with it off. Only a quote
	// after an odd number of backslashes ends the string in different places.
	test("accepts backslashes in a string literal wherever the string ends in the same place", () => {
		for (const text of ["'a\\b'", "'\\\\'", "'a\\\\\\b'", "'\\\\'''"])
			expect(
				findPlaceholders(`select ${text}, $1`, 1).map((p) => p.index),
			).toEqual([1]);
	});

	// Postgres ends a line comment at a carriage return too.
	test("a line comment ends at a carriage return", () => {
		expect(
			findPlaceholders("select 1 -- a note\r, $1", 1).map((p) => p.index),
		).toEqual([1]);
	});

	test("throws when the SQL is ambiguous or does not match the parameters", () => {
		const cases: [string, unknown[]][] = [
			["select '\\' || $1", ["x"]],
			["select 'a\\''b' || $1", ["x"]],
			["select '\\\\\\' || $1", ["x"]],
			["select 'not closed", []],
			['select "not closed', []],
			["select $$ not closed", []],
			["select /* not closed", []],
			["select $2", ["x"]],
			["select 1", ["unused"]],
		];
		for (const [sql, params] of cases)
			expect(() => inlineParams(sql, params, infer)).toThrow(InlineError);
	});
});

describe("inline encoder: literals", () => {
	test("escapes quotes and backslashes, and keeps `$$`", () => {
		expect(literal("it's \\ $$", infer)).toBe("E'it''s \\\\ $$'");
	});

	test("types the values the way postgres-js types parameters", () => {
		expect(literal(true, infer)).toBe("(E't'::boolean)");
		expect(literal(12n, infer)).toBe("(E'12'::int8)");
		expect(literal(new Uint8Array([0, 39, 255]), infer)).toBe(
			"(E'\\\\x0027ff'::bytea)",
		);
		expect(literal(1.5, infer)).toBe("E'1.5'");
		expect(literal(null, infer)).toBe("NULL");
	});

	test("rejects every value outside the closed set", () => {
		for (const value of [
			{ a: 1 },
			[1, 2],
			new Date(0),
			Symbol("s"),
			() => 1,
			"nul \0 char",
		])
			expect(() => literal(value, infer)).toThrow(InlineError);
	});
});

const url = process.env.TEST_PG_URL;

// In an E'...' literal only `'` and `\` are special, and their meaning does
// not change with standard_conforming_strings. So every string of up to three
// characters from `'`, `\` and `a` covers each special character alone, in
// pairs, next to a normal character, and at the start and end of a value.
function specialStrings(): string[] {
	const alphabet = ["'", "\\", "a"];
	let level = [""];
	const all: string[] = [];
	for (let length = 1; length <= 3; length++) {
		level = level.flatMap((prefix) => alphabet.map((c) => prefix + c));
		all.push(...level);
	}
	return all;
}

describe.skipIf(!url)("inline encoder against Postgres (postgres-js)", () => {
	test("an inlined value gives the same result as the parameter postgres-js sends", async () => {
		const sql = postgres(url as string, { max: 1, onnotice: () => {} });
		// Drizzle configures the client it wraps: json, jsonb and date values
		// pass through unchanged, because Drizzle encodes them itself.
		drizzle({ client: sql });
		const mismatches: string[] = [];
		const check = async (expr: string, value: unknown) => {
			const query = `select (${expr.replace("?", () => "$1")}) as v`;
			const outcome = (q: PromiseLike<{ v?: unknown }[]>) =>
				Promise.resolve(q).then(
					(r) => r[0]?.v,
					(e: { code?: string }) => `error ${e.code}`,
				);
			const asParam = await outcome(sql.unsafe(query, [value as never]));
			const asLiteral = await outcome(
				sql.unsafe(inlineParams(query, [value], infer)),
			);
			const show = (x: unknown) =>
				JSON.stringify(x, (_, y) => (typeof y === "bigint" ? `${y}n` : y));
			if (show(asParam) !== show(asLiteral))
				mismatches.push(
					`${expr} ${show(value)}: param ${show(asParam)}, literal ${show(asLiteral)}`,
				);
		};
		const strings = [
			...specialStrings(),
			"",
			"$$",
			"$1",
			"--",
			"/*",
			";",
			"\n",
			"E'",
			"\\x",
			"é ☃ 😀",
			"\u0001",
		];
		try {
			for (const scs of ["on", "off"]) {
				await sql.unsafe(`set standard_conforming_strings = ${scs}`);
				for (const s of strings) {
					await check("?::text", s);
					// The literal must end where the value ends.
					await check("'<' || ? || '>'", s);
				}
				for (const v of [
					0,
					-1,
					42,
					3.5,
					1e21,
					Number.NaN,
					Number.POSITIVE_INFINITY,
					Number.NEGATIVE_INFINITY,
				])
					for (const e of ["?::numeric", "?::double precision", "?::text"])
						await check(e, v);
				for (const v of [0n, -1n, 9007199254740993n]) await check("?", v);
				for (const v of [true, false]) await check("?", v);
				await check("?::text", null);
				for (const bytes of [[], [0], [39], [92], [0, 39, 92, 255]])
					await check("encode(?, 'hex')", Buffer.from(bytes));
				await check(
					"encode(?, 'hex')",
					Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
				);
				await check("?::jsonb", '{"a":"x\'y\\\\z"}');
				// Backslashes in the query's own string literals: the lexer must
				// find the same placeholders with both settings.
				for (const s of ["x", "'", "\\"]) {
					await check("'a\\b' || ?", s);
					await check("'\\\\' || ?", s);
					await check("'\\\\''' || ?", s);
				}
				await check("5 = ?", "5");
			}
		} finally {
			await sql.end();
		}
		expect(mismatches).toEqual([]);
	});
});
