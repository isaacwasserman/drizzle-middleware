import { describe, test } from "bun:test";
import type { SessionKind } from "../../src/core/driver.ts";
import { SUPPORTED_SESSION_KINDS } from "../../src/drivers/registry.ts";

/**
 * `test` for a driver that has a registry entry, `test.todo` for a planned
 * driver that does not have one yet. The todo tests become normal tests when
 * the driver's entry lands.
 */
export function driverTest(kind: SessionKind): typeof test | typeof test.todo {
	return SUPPORTED_SESSION_KINDS.has(kind) ? test : test.todo;
}

/** `describe` or `describe.todo`, like `driverTest`. */
export function driverDescribe(
	kind: SessionKind,
): typeof describe | typeof describe.todo {
	return SUPPORTED_SESSION_KINDS.has(kind) ? describe : describe.todo;
}
