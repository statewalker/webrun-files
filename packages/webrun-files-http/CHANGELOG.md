# @statewalker/webrun-files-http

## 0.10.0

### Minor Changes

- db24777: New package `@statewalker/webrun-files-http`: `newServerStub` serves any `FilesApi` as a
  `(Request) => Promise<Response>` handler, and `newClientStub` consumes it as a `FilesApi` over any
  `fetch`. Each call is its own request (`GET` with `Range`, `HEAD`, `PUT`, `MKCOL`/`COPY`/`MOVE`/
  `DELETE` with a `POST ?op=` fallback, paged listings with `after`). Reads and uploads stream, with
  chunked S3-style uploads, staged in a separate `FilesApi`, for browsers. `onRequest`/`onResponse`
  hooks and a per-request file system handle auth, CORS and tenancy. Verified in Chromium and Firefox
  with Playwright; an explicit `upload: "stream"` throws where request streams are unsupported instead
  of letting Firefox send `[object ReadableStream]` as the file.

### Patch Changes

- Updated dependencies [2ea6787]
  - @statewalker/webrun-files@0.10.0
  - @statewalker/webrun-files-mem@0.10.0
