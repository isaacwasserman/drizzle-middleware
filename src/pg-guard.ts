// Fail-closed member lists for wrapped Postgres sessions and prepared queries.
//
// A wrapped session or prepared query only exposes the members listed in the
// `*_ALLOWED` sets. Reading any other member throws, because it could send a
// query to the driver without running the middleware (for example
// `NeonHttpSession.batch`, which calls the client directly). A member that
// Drizzle adds in a future version is therefore blocked until it is reviewed.
//
// The `*_DENIED` sets are not used at runtime. They record the members that we
// reviewed and blocked on purpose, so the test suite can fail when Drizzle adds
// a member that is in neither set.

export const SESSION_ALLOWED: ReadonlySet<string> = new Set([
	// Intercepted by the session proxy.
	"prepareQuery",
	"prepareRelationalQuery",
	"prepareOneTimeRelationalQuery",
	"transaction",
	// Route through `this.prepareQuery`, so they return to the proxy.
	"execute",
	"all",
	// Data only.
	"constructor",
	"dialect",
	"relations",
	"schema",
	"options",
	"logger",
	"cache",
	"transactionId",
]);

export const SESSION_DENIED: ReadonlySet<string> = new Set([
	// Driver handles.
	"client",
	"clientQuery",
	"httpClient",
	"pool",
	"prisma",
	"rawQuery",
	// Call the driver directly.
	"query",
	"queryObjects",
	"batch",
]);

export const PREPARED_ALLOWED: ReadonlySet<string> = new Set([
	// Intercepted by the prepared-query proxy.
	"execute",
	"all",
	"values",
	"setToken",
	// Pure helpers.
	"getQuery",
	"mapResult",
	"mapResultRows",
	"isResponseInArrayMode",
	// Data only.
	"constructor",
	"query",
	"fields",
	"name",
	"logger",
	"cache",
	"options",
	"queryMetadata",
	"cacheConfig",
	"authToken",
	"transactionId",
	"joinsNotNullableMap",
	"customResultMapper",
	"isRqbV2Query",
	"_isResponseInArrayMode",
	"rawQueryConfig",
	"queryConfig",
]);

export const PREPARED_DENIED: ReadonlySet<string> = new Set([
	// Driver handles.
	"client",
	"clientQuery",
	"prisma",
	// Call the driver directly.
	"queryWithCache",
	"executeRqbV2",
]);
