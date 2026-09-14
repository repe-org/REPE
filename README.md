# REPE (Remote Efficient Protocol Extension) — Version 2

**Status:** Draft. Candidate replacement for `README.md`.
**Changes from version 1:** the body is always [BEVE](https://github.com/beve-org/beve) and the query is always a [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901); `query_format` and `body_format` are removed; the redundant `length` field and the `reserved` field are removed; `notify` becomes a `flags` field; a body alignment guarantee and optional compression are added. The header shrinks from 48 to 24 bytes.

REPE is a fast and simple RPC protocol. It defines a fixed 24-byte binary header followed by a JSON Pointer query and a BEVE body.

- High performance
- Easy to use
- Easy to parse
- Zero-copy numeric data, end to end

> The motivation is to provide a standard way to build RPC interfaces and databases over a single, self-describing binary format.

## Rationale for a Single Format

Version 1 could package any data format and any query specification. Version 2 fixes both. This is a deliberate narrowing, and it buys three things that a negotiated envelope cannot provide.

**Guaranteed interoperability.** With one format there is no negotiation, and therefore no runtime failure where two conformant peers cannot talk because one does not implement the other's format. Any REPE endpoint can always speak to any other REPE endpoint.

**End-to-end zero copy.** Because the body is always BEVE, the protocol can make a guarantee about where the body begins — see [Body Alignment](#body-alignment). BEVE's aligned typed arrays then resolve to a span into the receive buffer, with no copy and no reallocation, through the RPC layer. This guarantee is impossible to state when the body may be arbitrary bytes, because there is nothing to align.

**A smaller protocol.** The format cross product disappears from every implementation and every conformance suite. `query_format` × `body_format` was eight reserved combinations before custom values; version 2 has one.

The formats removed by this change are not lost, because BEVE already represents them:

| Version 1 body format | Version 2 encoding | Overhead |
| :-------------------- | :----------------- | :------- |
| Raw Binary | `uint8` typed array, `0x14 \| SIZE \| DATA` | 2–10 bytes |
| UTF-8 | BEVE string, `0x02 \| SIZE \| DATA` | 2–10 bytes |
| JSON | converted at the application or gateway boundary | — |
| BEVE | unchanged | 0 |

A one megabyte binary blob costs five bytes to carry as a BEVE `uint8` typed array, and a vectored write sends the five-byte prefix and the existing buffer without copying either. JSON conversion moves to the edge — a REST gateway, a CLI, a logging sink — which is where a human-readable representation belongs.

## Endianness

The endianness must be `little endian`, selected for optimal performance on modern systems, and matching BEVE.

# Request/Response (Message)

Requests and responses use the exact same data layout. There is no distinction between them. The format contains a header, query, and body.

Receivers distinguish requests from responses by context: servers receive requests and send responses; clients send requests and receive responses. For bidirectional protocols where both peers can initiate requests, implementations may use ID conventions (e.g., client uses odd IDs, server uses even) to disambiguate.

REPE Layout: `[Header, Query, Padding, Body]`

```c++
// C++ pseudocode representing a complete REPE message
struct message {
  repe::header header{}; // fixed 24-byte header
  std::string query{};   // JSON Pointer, query_length bytes
  // 0 to 15 padding bytes, present only when the aligned flag is set
  std::string body{};    // BEVE value, body_length bytes
};
```

# Header

```c++
// C++ pseudocode representing layout
struct header {
  uint16_t spec{0x1507};   // (5383) Magic two bytes to denote the REPE specification
  uint8_t version = 2;     // REPE version
  uint8_t flags{};         // bit 0: notify; bit 1: aligned; bit 2: zstd encoded;
                           // bits 3-7 reserved, must be zero
  uint16_t ec{};           // error code
  uint16_t query_length{}; // The total length of the query
  //
  uint64_t body_length{};  // The total length of the body, in bytes on the wire
  //
  uint64_t id{};           // Identifier
};
```

The header must be exactly 24 bytes with fields following the exact order shown above. No padding bytes are allowed. The header layout is naturally aligned for all fields, so packed struct representations are equivalent to standard layouts on little-endian systems.

| Offset | Size | Field | Description |
| :----- | :--- | :---- | :---------- |
| 0 | 2 | `spec` | Magic, `0x1507` |
| 2 | 1 | `version` | Protocol version, `2` |
| 3 | 1 | `flags` | Bit 0 notify, bit 1 aligned, bit 2 zstd, bits 3–7 reserved |
| 4 | 2 | `ec` | Error code |
| 6 | 2 | `query_length` | Query length in bytes |
| 8 | 8 | `body_length` | Body length in bytes, as transmitted |
| 16 | 8 | `id` | Message identifier |

> **Why the header is 24 bytes.** Removing `query_format` and `body_format`, narrowing `ec` and `query_length` to 16 bits, and folding compression into `flags` brings the header from 32 bytes to 24. Twenty-four is retained rather than reduced further because it is the smallest size at which every field is naturally aligned with **no interior and no trailing padding**: `24 % 8 == 0`, so the wire layout and the in-memory struct layout remain identical and `sizeof(header)` cannot silently disagree with the number of bytes written. A 28-byte header would reintroduce trailing padding in C and C++, where `write(&h, sizeof(h))` would emit four bytes of overhang and desynchronize the stream.
>
> `query_length` and `body_length` are adjacent, so the two fields a framing reader needs occupy one contiguous eight-byte span.

### Message Length

REPE does not include a total-length field. A message is framed by the fixed 24-byte header, followed by `query_length` bytes of query, followed by alignment padding, followed by `body_length` bytes of body.

The total message length is:

```
24 + query_length + query_padding + body_length
```

where `query_padding` is derived, not transmitted — see [Body Alignment](#body-alignment).

### Spec

The REPE `spec` value of `0x1507` is used to disambiguate REPE from other specifications that may use a similar layout. Because `spec` occupies the first two bytes of every message, a receiver can recognize a REPE message and read the `version` that immediately follows by inspecting only the first three bytes of the header.

If the `spec` field does not equal `0x1507`, the message is not a valid REPE message and **must** be rejected. No error response is sent, as the sender may not understand REPE.

### Version

The `version` is an 8-bit unsigned integer (`uint8_t`) that specifies the version of the REPE protocol being used.

- The latest version is **2**.

Servers and clients **must** validate the version number upon receiving a message. If the version is not supported, the endpoint **must** reject the message and respond with a `Version mismatch` error (`ec = 1`).

Version 2 is not wire compatible with version 1. Version 2 places the `spec` magic at the start of the header; version 1 instead began with an 8-byte `length` field. A version 2 endpoint that receives a version 1 message therefore observes a `spec` mismatch — it reads the low two bytes of version 1's `length` field — and rejects the message as not being REPE at all, rather than reporting a `Version mismatch`. Endpoints that must interoperate with version 1 need to detect this case explicitly. See [Migration from Version 1](#migration-from-version-1).

### Flags

`flags` is an 8-bit field carrying boolean message attributes.

| Bit | Mask | Name | Meaning |
| :-- | :--- | :--- | :------ |
| 0 | `0x01` | notify | No response is needed; errors are intentionally not reported to the sender |
| 1 | `0x02` | aligned | The query is padded so that the body begins at a 16-byte boundary |
| 2 | `0x04` | zstd | The body is Zstandard compressed; see [Compression](#compression) |
| 3–7 | — | reserved | Must be zero |

Receivers **must** reject any message with a reserved bit set, responding with an `Invalid header` error (`ec = 2`).

### ID

`id` must be a `uint64_t`.

The `id` field is a unique identifier for each request. Clients **should** assign unique IDs to each request. Responses **must** use the same `id` to allow clients to match responses to their corresponding requests, enabling asynchronous communication.

### Query Length

`query_length` indicates the length in bytes of the query. If `query_length` is zero, the query section is omitted.

### Body Length

`body_length` indicates the length in bytes of the body **as transmitted**, which is the compressed length when the zstd flag is set.

If `body_length` is zero, the body section is omitted. A message with no body is well formed and is the natural encoding for a parameterless call, an acknowledgement, and an error with no message. There is no need to encode an empty value.

### Length Constraints

While the protocol supports bodies of extremely long length, implementers **must** enforce reasonable maximum lengths based on application requirements to prevent resource exhaustion. See [Security Considerations](#security-considerations).

### Compression

When bit 2 of `flags` is set, the body is compressed with [Zstandard](https://github.com/facebook/zstd). This does not describe the body's data model, which is always BEVE; it describes how those BEVE bytes are packed for transmission, and it is transparent once removed.

Zstandard is the only compression format defined by REPE. A single format keeps the question a peer must answer down to one bit — does this endpoint support compression — rather than a matrix of which formats each side implements, which has no in-band way to be negotiated. Senders that need to trade ratio for speed **should** use Zstandard's negative compression levels, which approach the speed of the fastest byte-oriented compressors. The level is recorded in the Zstandard frame and is chosen entirely by the sender, so the full speed-versus-ratio curve is available without any protocol support.

Compression is optional. A receiver that does not support it **must** respond with an `Unsupported compression` error (`ec = 8`) and **must not** attempt to parse the body. Senders **should** therefore compress only where the peer's support is known, through application configuration or a prior successful exchange.

Should a future version define an additional format, bits 2 and 3 can be read together as a two-bit field in which the value `1` means Zstandard. A message produced under this version sets bit 2 alone, which is the value `1`, so its meaning is preserved unchanged.

BEVE payloads compress well, but dense floating-point arrays typically do not and cost CPU on both sides. Services dominated by numeric arrays **should** measure before enabling compression.

## Body Alignment

BEVE's [aligned typed arrays](https://github.com/beve-org/beve#aligned-typed-arrays) let a decoder return numeric data as a span directly into the receive buffer, with no copy. That padding is computed relative to the start of the BEVE message. Version 2 pins that origin and guarantees it can be satisfied.

> **The origin is the first byte of the body.** Byte offset `0` for all BEVE alignment computations is the first byte of the body, not the first byte of the REPE message. The header and query are not part of the BEVE value and are never counted.

For zero-copy access the body must begin at an address aligned to at least 16 bytes, which covers every BEVE numeric type through `int128_t` and `float128_t`. The body begins at offset `24 + query_length` from the start of the message, so whether it lands on a 16-byte boundary depends on both the header size and the query length.

When the **aligned** flag (bit 1) is set, the sender **must** insert padding after the query so that this holds:

```
query_padding = (16 - ((24 + query_length) % 16)) % 16
```

The formula is written against the header size rather than assuming the header is itself a multiple of 16, so that it stays correct if the header size ever changes.

The padding is 0 to 15 bytes, it is **not** counted in `query_length` or `body_length`, and it is derived by both peers from `query_length` rather than transmitted. Padding bytes **should** be zero, and receivers **must** ignore their contents.

When the flag is clear, no padding is present and the body follows the query immediately. Senders **should** set the flag when the body contains aligned typed arrays and **should** leave it clear otherwise, because up to 15 bytes of padding is significant overhead on a small message and no benefit on a body with no aligned arrays.

Receivers **must** support both forms. To obtain zero-copy spans, a receiver **must** additionally:

1. Place the message in a single contiguous buffer whose start address is 16-byte aligned. A reader that accumulates several messages in one buffer **must** align each message start, or copy.
2. Keep that buffer valid for as long as any span handed to the application points into it. Implementations **should** express this in their API with a buffer handle or a scoped callback rather than returning a raw span over storage the transport may recycle.

When the zstd flag is set, on-wire alignment is meaningless because the body is compressed. Senders **must** leave the aligned flag clear in that case, and receivers that want zero-copy access **must** decompress into a 16-byte-aligned buffer.

# Query

The query is a [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) (RFC 6901) encoded as UTF-8, framed by `query_length`. It carries no BEVE header, because `query_length` already provides the length.

A JSON Pointer addresses a method or value within the endpoint's served object tree, so no interface definition language, descriptor distribution, or code generation is required to route a call.

An empty query (`query_length == 0`) addresses the root. Receivers **must** reject a malformed pointer with an `Invalid query` error (`ec = 3`).

# Body

The body, when present, **must** be exactly one complete BEVE value, beginning at the first byte of the body and ending at its last.

- Bytes remaining after the root value is fully decoded **must** be rejected with an `Invalid body` error (`ec = 4`).
- A value truncated by the end of the body **must** be rejected the same way.
- A body of zero length is not an empty BEVE value; it is the absence of a body, and is well formed.

When invoking a function or setting a value, the body contains the input parameters. In a response, the body contains the result, or the error message when `ec` is non-zero.

Because BEVE is self-describing, a receiver, proxy, or logger can decode, inspect, and convert any body to JSON without a schema.

## Error

An error requires a `uint16_t` error code, carried in the header, and an optional message carried in the body.

When present, the error body **must** be one of two BEVE values, which a receiver distinguishes by the first header byte, as BEVE is self-describing:

- A **string** (`0x02`) containing a UTF-8 message.
- An **object** (`0x03`) with a `message` key holding a UTF-8 string, plus any application-defined keys carrying structured detail.

`body_length` may be zero, which indicates that there is no error message and only the error code is provided.

Values from `0` to `4095` are reserved for REPE high-level error codes. Codes `4096` through `65535` are available for application-specific errors.

| code | message | meaning |
| :--- | :------ | :------ |
| 0 | OK | No error |
| 1 | Version mismatch | Mismatching REPE version |
| 2 | Invalid header | The REPE header was invalid |
| 3 | Invalid query | The query was invalid |
| 4 | Invalid body | The body was invalid |
| 5 | Parse error | Invalid data was received. An error occurred while parsing the data |
| 6 | Method not found | The method does not exist / is not available |
| 7 | Timeout | Timeout |
| 8 | Unsupported compression | The endpoint does not support Zstandard-compressed bodies |

### Application-Specific Errors

Applications may define their own error codes from `4096` to `65535` to avoid conflicts with REPE's high-level errors.

### On Error

When an error is generated, the endpoint must send a message back with the `id` field set to the `id` of the original request, the `ec` field set to the appropriate error code, and the body (if present) containing the error message.

If the original request's `id` cannot be determined (e.g., the header is malformed), the error response **should** use `id = 0`.

# Response

An RPC response is a REPE message where the body contains the result. The `id` for the response must match the `id` from the original message.

It is up to the discretion of implementors whether the response returns the original query. Data can be saved by not returning the requested query, but it may be useful for debugging errors.

# Security Considerations

- **Transport Security.** REPE does not provide encryption or authentication. Implementations **should** use TLS for production deployments.
- **Size limits.** Implementations **must** enforce maximum `query_length` and `body_length` values before allocating. Both fields are attacker controlled and arrive before any payload.
- **Decode before allocate.** A BEVE `SIZE` is a compressed unsigned integer that can claim up to 2^62 elements in eight bytes. Decoders **must** validate every `SIZE` against the bytes remaining in the body before allocating, and **must not** pre-reserve capacity from an unvalidated `SIZE`.
- **Nesting depth.** BEVE objects and generic arrays nest arbitrarily. Decoders **must** enforce a configurable maximum depth to prevent stack exhaustion.
- **Decompression bounds.** When the zstd flag is set, the decompressed size **must** be bounded and checked during decompression, not after. A small compressed body can expand without limit.
- **Alignment padding is untrusted.** `PADDING_LENGTH` inside a BEVE aligned typed array is attacker controlled. Decoders **must** verify it is less than the element alignment, that the padding fits within the body, and that the resulting offset actually satisfies the element's alignment before reinterpreting the payload as native elements.
- **Buffer lifetime.** Zero-copy spans alias the receive buffer. An implementation that recycles receive buffers **must not** hand out spans that outlive them.
- **Input validation.** Query and body parsers **must** validate input to prevent injection attacks. Encoders **must** emit well-formed UTF-8; decoders **should** validate it.

# Migration from Version 1

Version 2 is a breaking wire change, and the break is not detected through the `version` byte. Because version 1 began with an 8-byte `length` field, the `spec` magic sits at offset 8 in version 1 and at offset 0 in version 2. Each version therefore reads the other's message as a `spec` mismatch and rejects it as not being REPE, which is a clean failure but not an informative one.

An endpoint that must accept both **should** disambiguate before parsing: read the first two bytes, and if they equal `0x1507` parse as version 2, otherwise read bytes 8–9 and if *those* equal `0x1507` parse as version 1. Endpoints that serve both **should** keep two decoders and dispatch on that check, rather than attempting to unify the two paths.

**Header**

| Version 1 | Version 2 |
| :-------- | :-------- |
| 48 bytes | 24 bytes |
| `length` (`uint64_t`, first field) | removed; the total is `24 + query_length + query_padding + body_length` |
| `spec` at offset 8 | `spec` at offset 0 |
| `notify` (`uint8_t`) | `flags` bit 0 |
| `reserved` (`uint32_t`) | removed; `flags` bits 3–7 are the reserved space |
| `query_length` (`uint64_t`) | `uint16_t`; a JSON Pointer never approaches 64 KiB |
| `ec` (`uint32_t`) | `uint16_t`; application range is `4096`–`65535` |
| `query_format`, `body_format` | removed |

**Query and body**

| Version 1 | Version 2 |
| :-------- | :-------- |
| `query_format = 1` (JSON Pointer) | implicit; the query is always a JSON Pointer |
| `query_format = 0` or `3` (raw, UTF-8) | not supported |
| `body_format = 1` (BEVE) | implicit; the body is always BEVE |
| `body_format = 0` (raw binary) | BEVE `uint8` typed array, `0x14` |
| `body_format = 3` (UTF-8) | BEVE string, `0x02` |
| `body_format = 2` (JSON) | converted at the application or gateway boundary |
| UTF-8 error message body | BEVE string, or BEVE object with a `message` key |
| no compression | Zstandard, `flags` bit 2 |
| no alignment guarantee | aligned flag and 16-byte body alignment |

# Appendix — Worked Example

A request invoking `/echo` with the parameters `{"message": "hi"}`, unaligned, no compression, `id = 1`.

The body is 14 bytes of BEVE:

```
03                    object, string keys
04                    SIZE = 1          (1 << 2)
1C                    key SIZE = 7      (7 << 2)
6D 65 73 73 61 67 65  "message"
02                    string value
08                    SIZE = 2          (2 << 2)
68 69                 "hi"
```

The complete 43-byte message:

```
07 15                 spec = 0x1507
02                    version = 2
00                    flags = 0
00 00                 ec = 0
05 00                 query_length = 5
0E 00 00 00 00 00 00 00   body_length = 14
01 00 00 00 00 00 00 00   id = 1

2F 65 63 68 6F        "/echo"

03 04 1C 6D 65 73 73 61 67 65 02 08 68 69   body
```

The same request with the aligned flag set, for a body whose arrays are to be read in place:

```
query_padding = (16 - ((24 + 5) % 16)) % 16 = 3
```

which places the body at offset `24 + 5 + 3 = 32`, a 16-byte boundary. The message is 46 bytes:

```
07 15 02 02 00 00 05 00   spec, version, flags = aligned, ec = 0, query_length = 5
0E 00 00 00 00 00 00 00   body_length = 14
01 00 00 00 00 00 00 00   id = 1

2F 65 63 68 6F            "/echo"
00 00 00                  3 padding bytes

03 04 1C 6D 65 73 73 61 67 65 02 08 68 69   body, at offset 32
```

A response to the same call, carrying a 1024-element `float64` aligned typed array, Zstandard compressed, would set `flags = 0x04` (zstd set, aligned cleared) and carry the compressed length in `body_length`.
