---
"@statewalker/webrun-files-http": minor
---

New package `@statewalker/webrun-files-http`: `newServerStub` serves any `FilesApi` as a
`(Request) => Promise<Response>` handler, and `newClientStub` consumes it as a `FilesApi` over any
`fetch`. Each call is its own request (`GET` with `Range`, `HEAD`, `PUT`, `MKCOL`/`COPY`/`MOVE`/
`DELETE` with a `POST ?op=` fallback, paged listings with `after`). Reads and uploads stream, with
chunked S3-style uploads, staged in a separate `FilesApi`, for browsers. `onRequest`/`onResponse`
hooks and a per-request file system handle auth, CORS and tenancy.
