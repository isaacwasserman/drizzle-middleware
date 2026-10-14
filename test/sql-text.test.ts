import { describe, expect, test } from "bun:test";
import { leadingWords, transactionControl } from "../src/sql-text.ts";

describe("leadingWords", () => {
	test("skips whitespace and comments", () => {
		expect(
			leadingWords(" \t\n\r\f\v-- a\n/* b /* c */ d */ Select x", 2),
		).toEqual(["select", "x"]);
	});

	test("skips empty statements before the first word only", () => {
		expect(leadingWords(";; ; select x", 2)).toEqual(["select", "x"]);
		expect(leadingWords("rollback; to", 2)).toEqual(["rollback"]);
	});

	test("stops at a token that is not a word", () => {
		expect(leadingWords("(select 1)", 2)).toEqual([]);
		expect(leadingWords("rollback; commit", 3)).toEqual(["rollback"]);
	});

	test("a word with a character that is not ASCII is not a keyword", () => {
		expect(leadingWords("commİt", 1)).toEqual([""]);
		expect(leadingWords("rollbacK", 1)).toEqual([""]);
	});

	test("an open comment ends the text", () => {
		expect(leadingWords("/* commit", 1)).toEqual([]);
		expect(leadingWords("-- commit", 1)).toEqual([]);
	});
});

describe("transactionControl", () => {
	test.each([
		["begin", "BEGIN"],
		["BEGIN ISOLATION LEVEL SERIALIZABLE", "BEGIN"],
		["start transaction", "START"],
		["commit", "COMMIT"],
		["commit and chain", "COMMIT"],
		["commit prepared 'x'", "COMMIT"],
		["end", "END"],
		["abort", "ABORT"],
		["rollback", "ROLLBACK"],
		["rollback work", "ROLLBACK"],
		["rollback transaction and chain", "ROLLBACK"],
		["rollback prepared 'x'", "ROLLBACK"],
		["prepare transaction 'x'", "PREPARE TRANSACTION"],
		["/* x */ -- y\n COMMIT", "COMMIT"],
		[";commit", "COMMIT"],
		["; /* x */ ; rollback", "ROLLBACK"],
		["rollback; to", "ROLLBACK"],
	])("reports %p", (text, keyword) => {
		expect(transactionControl(text)).toBe(keyword);
	});

	test.each([
		"select 1",
		"savepoint sp1",
		"release savepoint sp1",
		"rollback to savepoint sp1",
		"rollback work to sp1",
		"ROLLBACK TRANSACTION TO SAVEPOINT sp1",
		"prepare q as select 1",
		"set transaction isolation level serializable",
		"do $$ begin commit; end $$",
		"select 'commit'",
		'"commit"',
		"",
		"   ",
		"insert into commit_log values (1)",
		"committed",
	])("allows %p", (text) => {
		expect(transactionControl(text)).toBeUndefined();
	});
});
