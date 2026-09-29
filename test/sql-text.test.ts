// The check that a SQL text is one statement. A `;` inside a string, a quoted
// identifier, a dollar quote or a comment does not end a statement.

import { describe, expect, test } from "bun:test";
import { assertSingleStatement } from "../src/core/sql-text.ts";

describe("one statement: Postgres", () => {
	test("accepts one statement, with or without a trailing semicolon", () => {
		for (const sql of [
			"select 1",
			"select 1;",
			"select 1; ;\n",
			"select 1; -- a note",
			"select 1; /* a note */",
			"select ';'",
			'select "a;b"',
			"select $$;$$",
			"select $tag$ ; $tag$",
			"select 1 -- ; select 2",
			"select 1 /* ; /* nested ; */ */",
			"select E'\\'; select 2'",
			// With standard_conforming_strings on, '\' is one backslash.
			"select 'a_b' like 'a\\_b' escape '\\'",
		])
			expect(() => assertSingleStatement(sql, "pg")).not.toThrow();
	});

	test("rejects more than one statement", () => {
		for (const sql of [
			"select 1; select 2",
			"select 1;select 2",
			"set local app.a = '1'; set local app.b = '2'",
			"select 1; -- a note\nselect 2",
			// Postgres ends a line comment at a carriage return too.
			"select 1; -- a note\rselect 2",
			// With backslashes literal: the string ends after the backslash.
			"select 'a\\'; select 2; --'",
			// With backslashes as escapes: the string ends after the doubled quote.
			"select 'a\\''; select 2; --'",
		])
			expect(() => assertSingleStatement(sql, "pg")).toThrow(
				"more than one statement",
			);
	});
});

describe("one statement: SQLite", () => {
	test("accepts one statement, with or without a trailing semicolon", () => {
		for (const sql of [
			"select 1",
			"select 1;",
			"select 1; -- a note",
			"select ';'",
			'select "a;b"',
			"select `a;b`",
			"select [a;b]",
			"select 1 -- ; select 2",
			"select 1 /* ; */",
			// SQLite has no backslash escapes.
			"select 'a\\'",
		])
			expect(() => assertSingleStatement(sql, "sqlite")).not.toThrow();
	});

	test("rejects more than one statement", () => {
		for (const sql of [
			"select 1; select 2",
			"select 1;\nselect 2",
			"insert into t values (1); insert into t values (2)",
		])
			expect(() => assertSingleStatement(sql, "sqlite")).toThrow(
				"more than one statement",
			);
	});
});
