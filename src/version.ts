// Single source of truth for the gateway version. Bumped per release —
// the release workflow tags `vX.Y.Z` and assumes this constant matches.
// Exposed via `/health`, the `--version` CLI flag, and the `update`
// subcommand's "already up to date" check.
export const VERSION = "0.3.0";
