# REPE (Remote Efficient Protocol Extension)

REPE is a fast and simple RPC protocol that can package any data format and any query specification. It defines a binary header which can be invoked with any query specification. The payload (body) can be any format, JSON, BEVE, raw binary, text, etc.

- High performance
- Easy to use
- Easy to parse

> The motivation is to provide a standard way to build RPC interfaces and databases with flexible formats and query specifications.

## Endianness

The endianness must be `little endian`, selected for optimal performance on modern systems.

# Request/Response (Message)

Requests and responses use the exact same data layout. There is no distinction between them. The format contains a header, query, and body.

Receivers distinguish requests from responses by context: servers receive requests and send responses; clients send requests and receive responses. For bidirectional protocols where both peers can initiate requests, implementations may use ID conventions (e.g., client uses odd IDs, server uses even) to disambiguate.

REPE Layout: `[Header, Query, Body]`

```c++
// C++ pseudocode representing a complete REPE message
struct message {
  repe::header header{}; // fixed size header
  std::string query{}; // dynamic size query
  std::string body{}; // dynamic size body
};
```

# Header

The header information that describes how to handle the request and payload (query & body).

```c++
// C++ pseudocode representing layout
struct header {
  uint64_t length{}; // Total length of [header, query, body]
  //
  uint16_t spec{0x1507}; // (5383) Magic two bytes to denote the REPE specification
  uint8_t version = 2; // REPE version
  uint8_t flags{}; // bit 0: notify (1 = no response); bits 1-7 reserved, must be zero
  uint32_t ec{}; // error code
  //
  uint64_t id{}; // Identifier
  //
  uint64_t body_length{}; // The total length of the body
  //
  uint32_t query_length{}; // The total length of the query
  //
  uint16_t query_format{};
  uint16_t body_format{};
};
```

The header must be exactly 40 bytes with fields following the exact order shown above. No padding bytes are allowed. The header layout is naturally aligned for all fields, so packed struct representations are equivalent to standard layouts on little-endian systems.

### Length

The `length` field represents the total length of `[header, query, body]`. The length must always be provided for a valid message.

The `length` must equal `40 + query_length + body_length`

### Spec

The REPE `spec` value of `0x1507` is used to disambiguate REPE from other specifications that may use a similar layout. In this way, branching may be performed on the first 8 bytes (length + spec).

If the `spec` field does not equal `0x1507`, the message is not a valid REPE message and **must** be rejected. No error response is sent, as the sender may not understand REPE.

### Version

The `version` is an 8-bit unsigned integer (`uint8_t`) that specifies the version of the REPE protocol being used.

- The latest version is **2**.

Servers and clients **must** validate the version number upon receiving a message. If the version is not supported, the endpoint **must** reject the message and respond with a `Version mismatch` error (`ec = 1`). This ensures that endpoints do not attempt to parse messages using incompatible rules.

While future versions may introduce backward-compatible changes, compatibility is not guaranteed. Robust implementations must always check the version and handle mismatches.

### Flags

`flags` is an 8-bit field carrying boolean message attributes. The notify attribute is bit 0 and is evaluated as `flags & 0x01`. When bit 0 is set, no response is needed, and errors on the request are intentionally not reported to the client.

Bits 1 through 7 are reserved for future use and **must** be zero. Receivers **must** reject any message with a reserved bit set, responding with an `Invalid header` error (`ec = 2`).

### ID

`id` must be a `uint64_t`.

The `id` field is a unique identifier for each request. Clients **should** assign unique IDs to each request. Responses **must** use the same `id` to allow clients to match responses to their corresponding requests, enabling asynchronous communication.

### Query Length

`query_length` indicates the length in bytes of the query. If `query_length` is set to zero, the query section is omitted.

### Body Length

`body_length` indicates the length in bytes of the body.

If `body_length` is set to zero, the body section is omitted.

### String Length Constraints

While the protocol supports strings of extremely long length, implementers should enforce reasonable maximum lengths based on application requirements to prevent resource exhaustion and ensure efficient processing.

### Query Format

`query_format` is a two byte unsigned integer that may denote the format for the query. Value from [0, 4095] are reserved for the REPE specification. Custom formats should use values above 4095.

**Reserved Query Formats**

| Value | Format              |
| :---- | :------------------ |
| 0     | Raw Binary          |
| 1     | [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) (RFC 6901) |
| 2     | (Reserved for future use) |
| 3     | UTF-8               |

### Body Format

`body_format` is a two byte unsigned integer that may denote the format for the body. Value from [0, 4095] are reserved for the REPE specification. Custom formats should use values above 4095.

**Reserved Body Formats**

| Value | Format                                        |
| :---- | :-------------------------------------------- |
| 0     | Raw Binary                                    |
| 1     | [BEVE](https://github.com/beve-org/beve)      |
| 2     | [JSON](https://www.json.org/json-en.html)     |
| 3     | UTF-8                                         |

# Query

The query may use any specification chosen by implementors.

# Body

The body can contain data in any format, including JSON, BEVE, raw binary, or text. Implementers should document the expected data formats for their specific use cases to ensure consistent parsing and handling.

The body may contain a REPE error_message if the error code is in an error state. If the `body_length` is set to zero, then no body is provided.

When invoking a function or setting a value, the body contains the input parameters.

## Error

An error requires a `uint32_t` error code and a string message. The error code is stored in the header. The body is the error message as a UTF-8 string, where the `body_length` in the header indicates the length of the error message. The `body_format` should specify UTF-8.

The `body_length` for an error may be zero, which indicates that there is no error message and only the error code provided.

Below is a table of defined error codes. Values from `0` to `4095` are reserved for REPE high-level error codes. Codes `4096` and above are available for application-specific errors.

| code | message          | meaning                                                      |
| :--- | :--------------- | :----------------------------------------------------------- |
| 0    | OK               | No error                                                     |
| 1    | Version mismatch | Mismatching REPE version                                     |
| 2    | Invalid header   | The REPE header was invalid                                  |
| 3    | Invalid query    | The query was invalid                                        |
| 4    | Invalid body     | The body was invalid.                                        |
| 5    | Parse error      | Invalid data was received. An error occurred while parsing the data. |
| 6    | Method not found | The method does not exist / is not available.                |
| 7    | Timeout          | Timeout                                                      |

### Application-Specific Errors

 Applications may define their own error codes starting from `4096` to avoid conflicts with REPE's high-level errors.

### On Error

When an error is generated, the endpoint must send a message back with the `id` field set to the `id` of the original request, the `ec` field set to the appropriate error code, and the body (if present) containing a UTF-8 error message.

If the original request's `id` cannot be determined (e.g., the header is malformed), the error response **should** use `id = 0`.

# Response

An RPC response is an REPE message where the body contains the result. The `id` for the response must match the `id` from the original message.

It is up to the discretion of implementors whether the response returns the original query. Data can be saved by not returning the requested query, but it may be useful for debugging errors.

# Security Considerations

- **Transport Security:** REPE does not provide encryption or authentication. Implementations **should** use TLS for production deployments.
- **Size Limits:** Implementations **must** enforce maximum message sizes to prevent resource exhaustion.
- **Input Validation:** Query and body parsers **must** validate input to prevent injection attacks.
