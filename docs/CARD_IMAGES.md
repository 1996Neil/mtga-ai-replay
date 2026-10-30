# Card image identity

Scope (2026-10-30): fix wrong-print images without new controls, dependencies,
background sweeps or bulk cache migration. Preserve unrelated replay/collection work.

For known Arena catalog entries, request the English Scryfall printing by exact
set and collector number. The Arena-ID endpoint is a fallback if the printing
endpoint returns 404. A missing public Arena ID is acceptable only for an exact
set/number lookup; an explicit conflicting ID, wrong language, wrong set/number
or incorrect face is rejected.

Legacy metadata is rechecked lazily when requested. Image bytes are reused only
when the saved catalog identity and image source marker match; the marker is
written with a successfully downloaded image. Incorrect cached bytes are
replaced on demand. Matching caches work offline and do not require repeated
network verification. The browser image URL includes the printing ID so a
previously cached image cannot survive a change of printing.

Acceptance: Last Gasp Arena 106285 resolves to FRA 56; an old TRC 580 JPEG is
replaced. Subsequent reads reuse the image. Targeted checks cover wrong/missing
Arena IDs, stale JPEGs after metadata correction, offline behavior, and faces.
No full test suite or bulk image scan/download is part of this change.

Verified on this Mac: Last Gasp now uses printing
`2381d123-d8c7-4822-98fe-b1c365beb5ed` (FRA 56), with verified catalog
identity and a matching image source marker. The corrected JPEG is 86,400 bytes;
a second local image read took 4 ms. The initial image download took 5.7 s.
Nine image recovery checks, two related HTTP checks, two browser image-client
checks and the Viewer build passed. Independent review found no blocking issue.

Loading performance: cache reads run before the network queues. Public metadata
queries have four slots and retain the existing 120 ms API pacing; image CDN
downloads have six separate slots and do not enter the API pacing queue.
Repeated requests for the same card still share one task. Queue capacity is
128 so a normal large card view does not immediately fall into minute-long
retries after 32 pending requests. No bulk prefetch or extra verification was
added. Targeted regressions hold all network slots open and require cached
metadata/images to finish without waiting for those downloads.

Performance verification: recovery/performance checks 11/11, related HTTP checks
2/2, and independent review passed. After restarting the local service, 15
verified cached images requested concurrently completed in 28 ms total; the
second run completed in 8 ms. This measures local HTTP/cache delivery, not
first-time CDN download speed or browser image decoding. No full suite was run.

Transient failure recovery: a plain network/5xx/image-format failure no longer
forces a minute-long pause. Metadata and image server cooldowns are three
seconds; browser-only failures retry after 1.5/3/6/12 seconds, with at most three
automatic retries. Explicit Retry-After deadlines and 429 backoff are preserved.
The browser does not add a fresh minute when receiving a server deadline.
Legacy local failure receipts are refreshed once on demand and rewritten with
the short-cooldown schema. Invalid/wrong-print images still fall back to text.

Recovery verification (2026-10-31, Asia/Shanghai): 11 image-recovery tests and
five browser-client tests passed; the two cache/concurrency regressions and
Viewer build passed. In a controlled browser exercise, the first image request
returned 503 and the visible card recovered automatically after 1724 ms, without
refreshing the page. This is failure-recovery evidence, not a guarantee of
external download latency. Independent review found no blocking issue; no full
suite was run.

Manual recovery (2026-10-31): after about three seconds without a visible image,
or immediately on a failed/waiting state, each visible card offers a separate
native “重新加载” button. It never opens the card inspector or refreshes the page.
Manual retry cancels the browser observer/timer, immediately rechecks that card,
and bypasses ordinary short local cooldowns. Shared server downloads remain
coalesced; explicit upstream limits are preserved. Failed metadata/image
responses carry small classified diagnostics (timeout, connection, HTTP status,
rate limit, missing printing, mismatched identity or invalid image bytes).
Raw errors/URLs/paths are not exposed. Browser offline reports are displayed as
such; an upstream connection failure alone is never described as “no internet”.
No extra network request, bulk validation or dependency is added for diagnosis.

Manual UI verification: in a browser with one metadata response intentionally
held open, the reload control appeared after the slow threshold, remained
clickable, and issued exactly one manual request. The image appeared 136 ms
after the click in that controlled cached-image fixture. The retry did not open
the inspector, there were no nested buttons or page errors, and ordinary card
click + Escape still opened/closed the inspector. This does not measure a fresh
CDN download. Backend recovery/performance 16/16, browser-client 8/8 and related
HTTP 2/2 passed; Viewer build and independent review passed. No full suite.
