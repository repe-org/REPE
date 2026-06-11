# REPE Serialized Value Stream (SVS) — shared wire contract

- Status: **DRAFT v0 — provisional.** Concrete byte encodings below are the build target for implementers, but are **not frozen**: a reference implementation validates them first, after which this freezes as **v1** and further implementations target the frozen contract. Do not treat v0 as stable.
- Location: this is the canonical copy, in the **REPE org repository** next to the base REPE spec. It stays DRAFT v0 here until a reference implementation validates it, then freezes as v1 in place (see Status above).
- Purpose: one wire definition so that independently developed REPE services — in any language — can exchange these streams. Each implementation carries its own companion plan describing its local engine; this document is the only thing that must match between them.

## 0. What this pins, and what it does not

Bulk-stream transfer has two layers; this contract governs exactly one.

- **The engine is local and NOT specified here.** How a producer holds its session, sizes its bounded buffer, pipelines, or times out, and how a receiver writes files or deserializes the value, is each implementation's own business. Two conforming peers need not share any of it.
- **The wire contract IS specified here, and is normative:** the routes, the message shapes, the byte-level field encodings, and the streaming/termination semantics actually exchanged. Interop depends only on this.

You cannot get interop by matching engines; you get it by matching the bytes below.

## 1. Transport and framing

Every SVS message is an **ordinary REPE request/response** message (base REPE: `spec = 0x1507`, `version = 0x01`, 48-byte header), carried over any REPE transport (TCP or WebSocket) unchanged. The model is **client-pull**: the client drives with requests; flow control is the request/response round trip (no notify push, no ACK window on the wire). Because each message is small (one control message or one chunk), each WebSocket binary frame stays small, which is what lets multi-GB payloads cross WebSocket.

All multi-byte integers are **little-endian**. Routes are JSON-pointer query strings (`query_format = 1`). SVS claims the reserved namespace **`/_svs`**. Routes beginning with `_` are reserved for REPE protocol extensions; an application MUST NOT define its own routes under a reserved prefix. (This reservation rule belongs in base REPE; SVS states it here until base REPE adopts it.)

## 2. Messages (server is producer; client pulls)

The receiver chooses to write files or deserialize the value. One logical stream is identified by a `stream_id: u64` chosen by the server.

### 2.1 `open`

- Request: `query = /_svs/open` (`query_format = 1`); body `BodyFormat::Beve` = `{ resource: string }`.
- Response: body `BodyFormat::Beve` = `{ version: u8, stream_id: u64, format: u16, compression: u8 }`.
  - `version` = `1` for this contract.
  - `format`: the serialization format of the logical content, using **REPE `BodyFormat` values** — `0` = raw binary, `1` = BEVE, `2` = JSON, `3` = UTF-8, `≥ 4096` = application-custom. The stream itself is format-agnostic; it moves an opaque byte stream and only tags what that stream decodes to.
  - `compression`: an orthogonal codec applied over the serialized bytes — `0` = none, `1` = zstd (`2…` reserved for future codecs).
  - Together: a chunk stream reassembles to `compression`-compressed bytes that, once decompressed, are a `format`-serialized value. The per-chunk `next` response body is **always** `BodyFormat::RawBinary` (an opaque slice), regardless of `format` — a chunk is a slice of the stream, not independently a valid value.

`resource` is an **opaque, server-defined key** (an object id, a path, a query handle — whatever the server maps to a value); its namespace and resolution are engine-local. The server begins (or lazily prepares) its serialize→compress session and returns the `stream_id`.

### 2.2 `next`

- Request: `query = /_svs/next`; body `BodyFormat::Beve` = `{ stream_id: u64 }`.
- Response: `query` = a single byte `last` (`0` or `1`) with `query_format = 0` (raw binary, `query_length = 1`); body `BodyFormat::RawBinary` = the next slice of the byte stream (MAY be empty, e.g. a final `last = 1` carrying zero bytes).

The chunk **body stays raw and zero-copy**; `stream_id` rides in the small request body, and `last` rides in the response query so it never wraps the payload. The client calls `next` repeatedly until it receives `last = 1`.

### 2.3 `cancel`

- Request or notify: `query = /_svs/cancel`; body `BodyFormat::Beve` = `{ stream_id: u64, reason: string }`.
- Either peer MAY send it; both release the stream's state on send/receipt. It is best-effort (a notify may be lost if the connection is already gone); implementations MUST also treat disconnect/idle-timeout as terminal independently.

## 3. Stream semantics

- The reassembled concatenation of `next` response bodies, in order, is **exactly** the producer's byte stream: the `format`-serialized value, optionally `compression`-compressed (both declared at `open`). A receiver reconstructs it by appending chunks in order, then writes the bytes to a file as-is, decompresses to a file, or decompresses-and-deserializes per the declared `format` — its choice.
- **No total length is committed** (the compressed length is unknown until produced). Termination is the `last = 1` flag only.
- **Ordering.** On a single connection, sequential `next` responses arrive in request order. A client that pipelines multiple `next` requests for throughput MUST reassemble by request order (e.g. by tagging/ordering on the REPE message `id`), since the transport may complete multiplexed responses out of order.
- **Truncation is not silent.** A receiver MUST NOT treat a stream that ended without `last = 1` as complete. (Implementations writing files MUST commit atomically — write-temp-then-rename on `last` — so a dropped connection cannot leave a truncated file that looks whole. That rule is engine-local but mandatory; see the plans.)
- **Receivers validate output against the tags.** The chosen output must be consistent with the returned `format`/`compression`: decompress-to-file or decompress-and-deserialize requires `compression != 0`; writing a format-specific file or deserializing requires the matching `format` (e.g. a BEVE deserialize requires `format = 1`). A receiver that cannot honor the returned tags `cancel`s rather than producing a mislabeled or undecodable output.

## 4. Local policy (NOT on the wire — need not match across peers)

| Parameter | Owner | Note |
|---|---|---|
| Chunk size | Producer | Keep ≤ a few MiB so WebSocket frames stay small; 1 MiB default. |
| Session/buffer depth, pipelining window | each side | Bounds memory; backpressure lives here. |
| Idle timeout, session cleanup | each side | Frees abandoned streams. |
| Compression level (e.g. zstd level) | Producer | Receiver only needs `format` + `compression`, not the level. |

A producer with 1 MiB chunks and a shallow buffer interoperates with a client that pipelines 8 deep — only the messages match, not the tuning.

## 5. Versioning and negotiation

`version` in the `open` response is the contract version (`1`). v0 has no negotiation beyond the client checking the returned `version`; if a client does not support the returned `version` it `cancel`s. A future revision MAY let the client advertise accepted versions in the `open` request. Keep this minimal until a second version actually exists.

## 6. Conformance

While v0 is provisional, conformance is "two independent implementations agree on §1–§3 byte-for-byte," validated by a cross-implementation round-trip test: a client built on one implementation pulls a stream from a server built on another and reconstructs the identical byte stream, once two exist.

When the contract freezes as v1, add a **shared fixture suite** in the canonical org repo: canonical `open` / `next` / `cancel` frames (header + query + body bytes) every implementation must reproduce and decode byte-identically, plus a recorded pull transcript all implementations drive to an identical reconstructed byte stream. Defer the fixtures until freeze; do not build them against a moving v0.

## 7. Scope and non-goals

SVS is a **pull** contract: the consumer drives, the producer answers one chunk per `next`, and flow control is the request/response round trip itself — the producer structurally cannot get ahead of the consumer, because it only produces what is asked for. That is the whole of it. The fields that must agree between any two implementations are the routes, the `stream_id` encoding, the `last`-flag placement, and the `format`/`compression` tags; everything else (buffering, pipelining, timeouts, output choice) is local (§0, §4).

The following are **out of scope** for this contract. An application that needs one defines it separately rather than extending SVS:

- **Push (client→server upload).** SVS does not define a producer-driven direction. A client that holds a value and wants to send it to a server either has the server pull from it (the §2 mechanism run with the roles reversed, on a transport where either peer can initiate requests — e.g. WebSocket), or uses a separate **push** protocol. Push is not a missing SVS feature; its safety properties are different (the consumer no longer controls the rate structurally, so it needs an explicit credit/ACK window and active receive backpressure), which makes it a distinct contract built on a credit-windowed streaming engine, not a direction bolted onto this pull spec.
- **Resume across a dropped connection.** A stream whose connection is lost is terminated (§3); recovery is opening a new stream. SVS commits no offsets, acknowledgements, or replay state to the wire. (Resume belongs to the same credit-windowed push engine as above, which carries a replay ring; pull has nothing to resume from.)
- **Content integrity beyond the transport.** SVS defines no checksum of its own; §3 guards against silent truncation, not against corruption. Applications that need end-to-end verification carry their own digest inside the serialized value.
