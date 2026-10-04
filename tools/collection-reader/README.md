# Stage A collection reader

Fixed npm dependency: mtga-reader 0.1.13, GPL-3.0-only, upstream commit
51dd0f2570dbd45053b4ec01ce504dc8adcac2a3. Install only as an ordinary user:

    npm ci --ignore-scripts --prefix tools/collection-reader

The package lock records registry source and integrity. No lifecycle scripts or
runtime npm dependencies are required. The published darwin-arm64 addon loads
on this Mac. Reviewed paths: NAPI -> session_il2cpp -> collection_from and
inventory_from. No readAccount or generic explorer/debug/smoke is invoked.
No game writes or network calls in this entry. stdout contains only a validated
card-ID/count list, six wallet values, read time, source and stable content hash.
Errors are fixed codes; upstream text is never printed or stored.

Run only after Arena has loaded the home/collection scene:

    /usr/local/bin/node tools/collection-reader/probe.mjs

macOS may require task_for_pid authorization. Do not change global Node,
MTGA.app, SIP, Gatekeeper or taskport authorization rules. A permission failure
is a stopping point until the user explicitly grants the minimum reader access.
Never run npm/cargo/build/upload under sudo or elevate a complete shell session.

Two stable results and count == cards.length are structural checks, not proof
of full collection completeness. Upstream count is not independent Dictionary
Count; bulk collection iteration uses entry capacity and filters unused IDs.
Real client-screen counts and wallet comparison remain separately required.

This is a validation entry, not the final installed collection update command.
Stage A must pass before the full collection implementation is started.
