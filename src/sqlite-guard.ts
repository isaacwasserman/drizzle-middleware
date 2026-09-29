// Fail-closed member lists for wrapped SQLite sessions and prepared queries.
//
// A wrapped session or prepared query only exposes the members listed in the
// `*_ALLOWED` sets. Reading any other member throws, because it could send a
// query to the driver without running the middleware (for example
// `LibSQLSession.batch`, which calls the client directly). A member that
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
	"prepareOneTimeQuery",
	"run",
	"all",
	"get",
	"values",
	"count",
	// Pure helpers.
	"extractRawRunValueFromBatchResult",
	"extractRawAllValueFromBatchResult",
	"extractRawGetValueFromBatchResult",
	"extractRawValuesValueFromBatchResult",
	// Data only.
	"constructor",
	"dialect",
	"relations",
	"schema",
	"options",
	"logger",
	"cache",
]);

export const SESSION_DENIED: ReadonlySet<string> = new Set([
	// Driver handles.
	"client",
	"batchCLient",
	"prisma",
	"tx",
	// Call the driver directly.
	"exec",
	"batch",
	"migrate",
]);

export const PREPARED_ALLOWED: ReadonlySet<string> = new Set([
	// Intercepted by the prepared-query proxy.
	"execute",
	"run",
	"all",
	"get",
	"values",
	// Pure helpers.
	"getQuery",
	"mapResult",
	"mapRunResult",
	"mapAllResult",
	"mapGetResult",
	"isResponseInArrayMode",
	// Data only.
	"constructor",
	"mode",
	"executeMethod",
	"method",
	"query",
	"fields",
	"logger",
	"cache",
	"queryMetadata",
	"cacheConfig",
	"joinsNotNullableMap",
	"customResultMapper",
	"isRqbV2Query",
	"_isResponseInArrayMode",
]);

export const PREPARED_DENIED: ReadonlySet<string> = new Set([
	// Driver handles.
	"client",
	"stmt",
	"tx",
	"prisma",
	// Call the driver directly.
	"queryWithCache",
	"allRqbV2",
	"getRqbV2",
]);
