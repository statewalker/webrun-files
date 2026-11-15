---
"@statewalker/webrun-files-sqlite": patch
---

`pakoDeflateCodec` accepts the pako 3 module as it is (`import * as pako from "pako"`) without a type error. `PakoStreamModule` no longer asks `Deflate` for an `ended` property, which pako 3 declares private there; `Inflate.ended` is still read to detect a truncated stream.
