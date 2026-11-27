// Loaded before every test file (bunfig.toml): the store's plan guard throws on a statement
// that scans a big table, so a new full scan fails the suite where it was written. A run that
// sets COPHYLA_STRICT_SQL itself (0 to survey, with COPHYLA_SQL_REPORT naming a file to
// collect the hits in) keeps its own.

process.env["COPHYLA_STRICT_SQL"] ??= "1";
