# Technical Documentation

## Specification Compliance

This library implements the **MCP Specification 2025-06-18**, specifically the
[Streamable HTTP Transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

The legacy HTTP+SSE transport (spec 2024-11-05) is **not supported** as it has
been deprecated in favour of Streamable HTTP.

## Architecture

```
+------------------------------------------------------------------+
|                         Browser                                   |
|  +------------------------------------------------------------+  |
|  |                      MCPClient                              |  |
|  |                                                             |  |
|  |  +------------------+  +------------------+                 |  |
|  |  |   _request()     |  |   openStream()   |                 |  |
|  |  |   (POST)         |  |   (GET)          |                 |  |
|  |  +--------+---------+  +--------+---------+                 |  |
|  |           |                     |                           |  |
|  |           v                     v                           |  |
|  |  +------------------+  +------------------+                 |  |
|  |  | _buildHeaders()  |  | SSE Parser       |                 |  |
|  |  | - Content-Type   |  | - ReadableStream |                 |  |
|  |  | - Accept         |  | - TextDecoder    |                 |  |
|  |  | - MCP-Protocol-  |  | - Event ID track |                 |  |
|  |  |   Version        |  +------------------+                 |  |
|  |  | - Mcp-Session-Id |                                       |  |
|  |  +------------------+                                       |  |
|  +------------------------------------------------------------+  |
|                              |                                    |
+------------------------------+------------------------------------+
                               |
                         fetch() API
                               |
                               v
+------------------------------------------------------------------+
|                        MCP Server                                 |
|                                                                   |
|  Endpoint: /mcp (or server-defined path)                         |
|                                                                   |
|  POST /mcp                                                        |
|    Request:  JSON-RPC 2.0                                        |
|    Response: application/json OR text/event-stream               |
|                                                                   |
|  GET /mcp                                                         |
|    Request:  Accept: text/event-stream                           |
|    Response: text/event-stream (server-initiated messages)       |
|                                                                   |
|  DELETE /mcp                                                      |
|    Request:  Mcp-Session-Id header                               |
|    Response: 200 OK or 405 Method Not Allowed                    |
+------------------------------------------------------------------+
```

## Protocol Implementation

### Request Headers

All requests include:

```
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-06-18
Mcp-Session-Id: <session-id>  (after initialization, if server provides one)
```

### JSON-RPC 2.0 Request Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

### Response Handling

The client handles two response types based on `Content-Type`:

**1. JSON Response (`application/json`)**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { ... }
}
```

**2. SSE Stream Response (`text/event-stream`)**

```
id: evt-1
data: {"jsonrpc":"2.0","method":"notifications/progress","params":{...}}

id: evt-2
data: {"jsonrpc":"2.0","id":1,"result":{...}}
```

The SSE parser:
- Buffers incoming chunks
- Parses `id:` lines to track Last-Event-ID
- Parses `data:` lines as JSON-RPC messages
- Returns the final result (message with matching request ID)

### Session Management

1. **Initialization**: Client sends `initialize` request without session ID
2. **Session Assignment**: Server may return `Mcp-Session-Id` in response headers
3. **Subsequent Requests**: Client includes session ID in all requests
4. **Session Expiry**: If server returns 404 with session ID, client clears session
5. **Termination**: Client may send DELETE to explicitly end session

### Notifications

Notifications are JSON-RPC messages without an `id` field:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized",
  "params": {}
}
```

Server responds with `202 Accepted` (no body).

### Server-Initiated Streams (GET)

For long-running operations, clients can open a GET stream:

```
GET /mcp
Accept: text/event-stream
MCP-Protocol-Version: 2025-06-18
Mcp-Session-Id: <session-id>
Last-Event-ID: <last-id>  (for resumption)
```

Server responds with SSE stream or `405 Method Not Allowed` if unsupported.

## Error Codes

| Code | Meaning | Client Method |
|------|---------|---------------|
| -32700 | Parse error | - |
| -32600 | Invalid request | - |
| -32601 | Method/tool not found | `isToolNotFound()` |
| -32602 | Invalid params | - |
| -32603 | Internal error | - |
| -32000 | Timeout / Session expired | `isTimeout()`, `isSessionExpired()` |
| -32001 | Network error | `isNetworkError()` |

## Tool Result Parsing

The `call()` method returns a parsed result:

```javascript
{
  raw: { content: [...] },  // Original server response
  text: "...",              // Concatenated text content
  data: { ... },            // Parsed JSON (if text is valid JSON)
  isError: false            // True if server indicated error
}
```

Parsing logic:
1. Extract all `content` items with `type: "text"`
2. Concatenate text parts
3. If text looks like JSON (`{` or `[`), attempt to parse
4. Return structured result object

## Caching

- Tool list is cached after first `listTools()` call
- Use `listTools(true)` to force refresh
- Cache is cleared on `close()`

## Timeout Handling

```javascript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), this.timeout);

fetch(url, { signal: controller.signal });
```

Default timeout: 30 seconds.

## Browser APIs Used

| API | Purpose | Fallback |
|-----|---------|----------|
| `fetch()` | HTTP requests | None (required) |
| `ReadableStream` | SSE parsing | None (required) |
| `AbortController` | Timeout handling | None (required) |
| `TextDecoder` | Stream decoding | None (required) |
| `URL` | URL manipulation | None (required) |

Minimum browser versions:
- Chrome 43+
- Firefox 65+
- Safari 10.1+
- Edge 79+

## Security Notes

1. **CORS**: Servers must send appropriate headers:
   ```
   Access-Control-Allow-Origin: *
   Access-Control-Allow-Headers: Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id
   Access-Control-Allow-Methods: GET, POST, DELETE
   ```

2. **Session ID Security**: Session IDs should be treated as sensitive tokens

3. **HTTPS**: Always use HTTPS in production to protect headers and payloads

## File Structure

```
mcp-browser-client/
├── mcp-client.js          # Main library (~675 lines)
├── README.md              # User documentation
├── README-TECHNICAL.md    # This file
└── LICENSE                # MIT licence
```

## Testing

Test against any MCP server implementing Streamable HTTP:

```javascript
// In browser console
const client = new MCPClient('https://your-server/mcp');

// Test connection
console.log('Protocol:', MCPUtils.getProtocolVersion());

const tools = await client.listTools();
console.log('Tools:', tools.map(t => t.name));

// Test tool execution
const result = await client.call(tools[0].name, {});
console.log('Result:', result);

// Check session
console.log('Session ID:', client.getSessionId());

// Clean up
await client.close();
```

## Differences from Legacy HTTP+SSE

| Aspect | Legacy (2024-11-05) | Streamable HTTP (2025-06-18) |
|--------|---------------------|------------------------------|
| Endpoints | `/sse` + `/message` | Single `/mcp` endpoint |
| Connection | Persistent SSE required | Request/response, optional SSE |
| Serverless | Poor (persistent connection) | Good (stateless requests) |
| Complexity | Higher | Lower |
| Status | Deprecated | Current |

This library only implements Streamable HTTP.
