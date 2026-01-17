# mcp-browser-client

Generic JavaScript client for the Model Context Protocol (MCP) in browsers.

## NAME

**mcp-browser-client** - Browser-based MCP client implementing Streamable HTTP transport

## SPECIFICATION COMPLIANCE

This library implements the **MCP Specification 2025-06-18**, specifically the
[Streamable HTTP Transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

| Requirement | Status |
|-------------|--------|
| POST with JSON-RPC body | Implemented |
| `Accept: application/json, text/event-stream` header | Implemented |
| `MCP-Protocol-Version` header | Implemented |
| `Mcp-Session-Id` header tracking | Implemented |
| Handle `application/json` responses | Implemented |
| Handle `text/event-stream` responses | Implemented |
| GET for server-initiated streams | Implemented |
| `Last-Event-ID` for resumability | Implemented |
| HTTP DELETE for session termination | Implemented |

**Not implemented:** Legacy HTTP+SSE transport (deprecated in spec 2024-11-05).

## SYNOPSIS

```javascript
const client = new MCPClient('https://your-mcp-server.example.com/mcp');

// List available tools
const tools = await client.listTools();

// Execute a tool
const result = await client.call('tool_name', { arg1: 'value' });

// Clean up
await client.close();
```

## DESCRIPTION

A lightweight, zero-dependency JavaScript library for interacting with MCP
servers from web browsers. Implements the Streamable HTTP transport using
JSON-RPC 2.0 over HTTP POST/GET requests.

## INSTALLATION

Download `mcp-client.js` and include it in your HTML:

```html
<script src="mcp-client.js"></script>
```

Or copy the file to your project's static assets directory.

## DEMO

Open `demo.html` in a browser to try the included MCP Tools Explorer interface.
This provides a complete UI for:

- Adding and managing MCP server connections
- Browsing available tools
- Executing tools with parameter forms
- Viewing results

Servers are persisted in localStorage across sessions.

## API

### MCPClient

#### Constructor

```javascript
new MCPClient(baseUrl, options?)
```

**Parameters:**

- `baseUrl` (string) - The MCP server endpoint URL
- `options` (object, optional)
  - `headers` (object) - Additional HTTP headers
  - `timeout` (number) - Request timeout in ms (default: 30000)

#### Methods

**initialize()**

Initialise connection and get server capabilities. Sends `notifications/initialized`
after successful handshake.

```javascript
const serverInfo = await client.initialize();
// Returns: { protocolVersion, serverInfo: { name, version }, capabilities }
```

**listTools(refresh?)**

List available tools from the server.

```javascript
const tools = await client.listTools();
// Returns: [{ name, description, inputSchema }, ...]
```

**call(name, arguments?)**

Execute a tool.

```javascript
const result = await client.call('search_notes', { query: 'hello' });
// Returns: { raw, text, data, isError }
```

**openStream(onMessage, onError)**

Open a persistent connection for server-initiated messages.

```javascript
await client.openStream(
  (message) => console.log('Received:', message),
  (error) => console.error('Stream error:', error)
);
```

**closeStream()**

Close the server-initiated message stream.

**terminateSession()**

Send HTTP DELETE to terminate the session with the server.

```javascript
const terminated = await client.terminateSession();
// Returns: true if terminated, false if server doesn't support it
```

**close()**

Clean up all resources (closes stream, terminates session).

```javascript
await client.close();
```

**getSessionId()**

Get the current session ID assigned by the server.

```javascript
const sessionId = client.getSessionId();
```

**getTool(name)**

Get a specific tool definition.

```javascript
const tool = await client.getTool('search_notes');
```

**searchTools(query)**

Search tools by name or description.

```javascript
const matches = await client.searchTools('search');
```

### MCPError

Custom error class for MCP-specific errors.

**Properties:**

- `message` (string) - Error message
- `code` (number) - JSON-RPC error code
- `data` (any) - Additional error data

**Methods:**

- `isToolNotFound()` - Returns true if tool was not found (-32601)
- `isTimeout()` - Returns true if request timed out (-32000)
- `isNetworkError()` - Returns true if network error occurred (-32001)
- `isSessionExpired()` - Returns true if session expired (404 response)

### MCPUtils

Utility functions for working with MCP tools.

**formatParameters(tool)**

Format tool parameters as human-readable text.

**generateExample(tool, clientVar?)**

Generate example JavaScript code for calling a tool.

**formatRelativeTime(date)**

Format a date as relative time (e.g., "2 hours ago").

**getProtocolVersion()**

Get the MCP protocol version this client implements.

```javascript
MCPUtils.getProtocolVersion(); // "2025-06-18"
```

## EXAMPLES

### Basic Usage

```javascript
const client = new MCPClient('https://mcp.example.com/mcp');

try {
  // List tools
  const tools = await client.listTools();
  console.log(`Found ${tools.length} tools`);

  // Execute a tool
  const result = await client.call('get_user', { id: 123 });
  console.log(result.text);
} catch (error) {
  if (error instanceof MCPError) {
    if (error.isSessionExpired()) {
      console.log('Session expired, reconnecting...');
    } else {
      console.error(`MCP Error: ${error.message} (code: ${error.code})`);
    }
  }
} finally {
  await client.close();
}
```

### With Custom Headers

```javascript
const client = new MCPClient('https://mcp.example.com/mcp', {
  headers: {
    'Authorization': 'Bearer token123'
  },
  timeout: 60000
});
```

### Server-Initiated Messages

```javascript
const client = new MCPClient('https://mcp.example.com/mcp');

// Open stream for server push
await client.openStream(
  (message) => {
    if (message.method === 'notifications/progress') {
      console.log('Progress:', message.params);
    }
  },
  (error) => console.error('Stream error:', error)
);

// Execute long-running tool (progress comes via stream)
const result = await client.call('long_running_task', { data: '...' });

// Clean up
client.closeStream();
```

## BROWSER COMPATIBILITY

The library uses:
- `fetch()` API with `ReadableStream`
- `AbortController`
- `TextDecoder`
- `async/await`
- ES6 classes

Supported in all modern browsers (Chrome 43+, Firefox 65+, Safari 10.1+, Edge 79+).

## SECURITY CONSIDERATIONS

1. **CORS**: MCP servers must include appropriate CORS headers for browser access
2. **HTTPS**: Production deployments should use HTTPS
3. **Authentication**: Pass auth headers via the `options.headers` parameter
4. **Session Management**: Session IDs are automatically tracked and sent

## LICENCE

MIT

## SEE ALSO

- [MCP Specification 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [Model Context Protocol](https://modelcontextprotocol.io/)
