---
"@http-client-toolkit/core": minor
---

Separate HTTP error handling into detection, enrichment, and classification stages. `errorHandler` now receives a typed `HttpErrorContext` instead of `unknown` and is only called for HTTP errors (non-2xx responses), not network failures. Network errors are always wrapped in `HttpClientError` by the toolkit.
