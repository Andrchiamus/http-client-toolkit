---
"@http-client-toolkit/core": minor
---

Improve public error handling API:

- **`HttpErrorContext.url`**: Error handlers now receive the requested URL, enabling logging and error reporting without extra bookkeeping.
- **`HttpClientError.data` / `HttpClientError.headers`**: The default error path (when no `errorHandler` is provided) now includes the parsed response body and headers on the thrown error.
- **JSDoc**: Added documentation to all `HttpErrorContext` fields and clarified the distinction between `responseTransformer` and `responseHandler`.
