// mcp-client.js - Generic MCP Browser Client
/**
 * Generic MCP (Model Context Protocol) Client for Browsers
 *
 * A lightweight, zero-dependency JavaScript client for interacting with any
 * MCP server via Streamable HTTP transport.
 *
 * Implements: MCP Specification 2025-06-18 (Streamable HTTP Transport)
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 *
 * @version 2.0.0
 * @license MIT
 */

const MCP_PROTOCOL_VERSION = '2025-06-18';

class MCPClient {
  /**
   * Create a new MCP client
   * @param {string} baseUrl - The base URL of the MCP server endpoint
   * @param {Object} options - Configuration options
   * @param {Object} options.headers - Additional headers to include in requests
   * @param {number} options.timeout - Request timeout in milliseconds (default: 30000)
   */
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = options.headers || {};
    this.timeout = options.timeout || 30000;
    this._requestId = 0;
    this._sessionId = null;
    this._serverInfo = null;
    this._tools = null;
    this._eventSource = null;
    this._lastEventId = null;
  }

  /**
   * Generate a unique request ID
   * @returns {number} Request ID
   * @private
   */
  _nextId() {
    return ++this._requestId;
  }

  /**
   * Build headers for MCP requests
   * @returns {Object} Headers object
   * @private
   */
  _buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      ...this.headers
    };

    if (this._sessionId) {
      headers['Mcp-Session-Id'] = this._sessionId;
    }

    return headers;
  }

  /**
   * Parse SSE stream and extract JSON-RPC messages
   * @param {Response} response - Fetch response with SSE content
   * @returns {Promise<Object>} Parsed result
   * @private
   */
  async _parseSSEResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let lastEventId = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('id:')) {
            lastEventId = line.slice(3).trim();
          } else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data) {
              try {
                const parsed = JSON.parse(data);
                // Keep the last result (response to our request)
                if (parsed.result !== undefined || parsed.error !== undefined) {
                  result = parsed;
                }
              } catch (e) {
                // Non-JSON data, skip
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (lastEventId) {
      this._lastEventId = lastEventId;
    }

    return result;
  }

  /**
   * Make a JSON-RPC 2.0 request to the MCP server
   * @param {string} method - The JSON-RPC method name
   * @param {Object} params - Method parameters
   * @returns {Promise<Object>} The result from the server
   * @throws {MCPError} If the request fails or server returns an error
   * @private
   */
  async _request(method, params = {}) {
    const requestId = this._nextId();
    const body = {
      jsonrpc: '2.0',
      id: requestId,
      method: method,
      params: params
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Check for session ID in response headers
      const sessionId = response.headers.get('Mcp-Session-Id');
      if (sessionId) {
        this._sessionId = sessionId;
      }

      // Handle session expiry
      if (response.status === 404 && this._sessionId) {
        this._sessionId = null;
        throw new MCPError('Session expired', -32000);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new MCPError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          errorText
        );
      }

      // Handle response based on content type
      const contentType = response.headers.get('Content-Type') || '';
      let data;

      if (contentType.includes('text/event-stream')) {
        data = await this._parseSSEResponse(response);
      } else {
        data = await response.json();
      }

      if (!data) {
        throw new MCPError('Empty response from server', -32600);
      }

      // Check for JSON-RPC error
      if (data.error) {
        throw new MCPError(
          data.error.message || 'Unknown MCP error',
          data.error.code || -1,
          data.error.data
        );
      }

      return data.result;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new MCPError('Request timeout', -32000);
      }

      if (error instanceof MCPError) {
        throw error;
      }

      throw new MCPError(`Network error: ${error.message}`, -32001);
    }
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   * @param {string} method - The notification method name
   * @param {Object} params - Method parameters
   * @returns {Promise<void>}
   * @private
   */
  async _notify(method, params = {}) {
    const body = {
      jsonrpc: '2.0',
      method: method,
      params: params
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body)
      });

      // 202 Accepted is the expected response for notifications
      if (response.status !== 202 && !response.ok) {
        console.warn(`Notification ${method} returned ${response.status}`);
      }
    } catch (e) {
      // Notifications don't require acknowledgment
      console.warn(`Notification ${method} failed:`, e.message);
    }
  }

  /**
   * Initialize the connection to the MCP server
   * Gets server capabilities and protocol version
   * @returns {Promise<Object>} Server information
   */
  async initialize() {
    const result = await this._request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'mcp-browser-client',
        version: '2.0.0'
      }
    });

    this._serverInfo = result;

    // Send initialized notification
    await this._notify('notifications/initialized', {});

    return result;
  }

  /**
   * Get server information from the last initialize call
   * @returns {Object|null} Server info or null if not initialized
   */
  getServerInfo() {
    return this._serverInfo;
  }

  /**
   * Get current session ID
   * @returns {string|null} Session ID or null
   */
  getSessionId() {
    return this._sessionId;
  }

  /**
   * List all available tools from the MCP server
   * @param {boolean} refresh - Force refresh the tool list (default: false)
   * @returns {Promise<Array>} Array of tool definitions
   */
  async listTools(refresh = false) {
    if (this._tools && !refresh) {
      return this._tools;
    }

    const result = await this._request('tools/list', {});
    this._tools = result.tools || [];
    return this._tools;
  }

  /**
   * Execute a tool on the MCP server
   * @param {string} name - The tool name
   * @param {Object} arguments_ - Arguments to pass to the tool
   * @returns {Promise<Object>} Tool execution result
   */
  async call(name, arguments_ = {}) {
    const result = await this._request('tools/call', {
      name: name,
      arguments: arguments_
    });

    return this._parseToolResult(result);
  }

  /**
   * Parse tool result content
   * @param {Object} result - Raw tool result
   * @returns {Object} Parsed result with text and structured data
   * @private
   */
  _parseToolResult(result) {
    if (!result || !result.content) {
      return { raw: result, text: '', data: null };
    }

    // Extract text content
    const textParts = result.content
      .filter(c => c.type === 'text')
      .map(c => c.text);

    const text = textParts.join('\n');

    // Try to parse as JSON if it looks like JSON
    let data = null;
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        // Not valid JSON, leave as text
      }
    }

    return {
      raw: result,
      text: text,
      data: data,
      isError: result.isError || false
    };
  }

  /**
   * Get a specific tool definition by name
   * @param {string} name - Tool name
   * @returns {Promise<Object|null>} Tool definition or null if not found
   */
  async getTool(name) {
    const tools = await this.listTools();
    return tools.find(t => t.name === name) || null;
  }

  /**
   * Search tools by name or description
   * @param {string} query - Search query
   * @returns {Promise<Array>} Matching tools
   */
  async searchTools(query) {
    const tools = await this.listTools();
    const lowerQuery = query.toLowerCase();

    return tools.filter(tool => {
      const nameMatch = tool.name.toLowerCase().includes(lowerQuery);
      const descMatch = tool.description &&
                       tool.description.toLowerCase().includes(lowerQuery);
      return nameMatch || descMatch;
    });
  }

  /**
   * Open a server-sent events stream for receiving server-initiated messages
   * @param {Function} onMessage - Callback for received messages
   * @param {Function} onError - Callback for errors
   * @returns {Promise<void>}
   */
  async openStream(onMessage, onError) {
    if (this._eventSource) {
      this._eventSource.close();
    }

    const headers = this._buildHeaders();

    // EventSource doesn't support custom headers, so we use fetch with ReadableStream
    try {
      const url = new URL(this.baseUrl);
      if (this._sessionId) {
        url.searchParams.set('sessionId', this._sessionId);
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
          ...(this._sessionId ? { 'Mcp-Session-Id': this._sessionId } : {}),
          ...(this._lastEventId ? { 'Last-Event-ID': this._lastEventId } : {}),
          ...this.headers
        }
      });

      if (response.status === 405) {
        // Server doesn't support GET streaming
        return;
      }

      if (!response.ok) {
        throw new MCPError(`Stream error: ${response.status}`, response.status);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            let currentEventId = null;
            for (const line of lines) {
              if (line.startsWith('id:')) {
                currentEventId = line.slice(3).trim();
                this._lastEventId = currentEventId;
              } else if (line.startsWith('data:')) {
                const data = line.slice(5).trim();
                if (data && onMessage) {
                  try {
                    const parsed = JSON.parse(data);
                    onMessage(parsed);
                  } catch (e) {
                    // Non-JSON data
                  }
                }
              }
            }
          }
        } catch (e) {
          if (onError) onError(e);
        }
      };

      processStream();
    } catch (e) {
      if (onError) onError(e);
    }
  }

  /**
   * Close the server-sent events stream
   */
  closeStream() {
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
  }

  /**
   * Terminate the session with the server
   * @returns {Promise<boolean>} True if terminated, false if server doesn't support it
   */
  async terminateSession() {
    if (!this._sessionId) {
      return true;
    }

    try {
      const response = await fetch(this.baseUrl, {
        method: 'DELETE',
        headers: {
          'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
          'Mcp-Session-Id': this._sessionId,
          ...this.headers
        }
      });

      if (response.status === 405) {
        // Server doesn't support client-initiated termination
        return false;
      }

      this._sessionId = null;
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * Close the client and clean up resources
   */
  async close() {
    this.closeStream();
    await this.terminateSession();
    this._tools = null;
    this._serverInfo = null;
  }
}


/**
 * MCP-specific error class
 */
class MCPError extends Error {
  /**
   * Create an MCP error
   * @param {string} message - Error message
   * @param {number} code - JSON-RPC error code
   * @param {*} data - Additional error data
   */
  constructor(message, code = -1, data = null) {
    super(message);
    this.name = 'MCPError';
    this.code = code;
    this.data = data;
  }

  /**
   * Check if this is a "tool not found" error
   * @returns {boolean}
   */
  isToolNotFound() {
    return this.code === -32601;
  }

  /**
   * Check if this is a timeout error
   * @returns {boolean}
   */
  isTimeout() {
    return this.code === -32000;
  }

  /**
   * Check if this is a network error
   * @returns {boolean}
   */
  isNetworkError() {
    return this.code === -32001;
  }

  /**
   * Check if this is a session expired error
   * @returns {boolean}
   */
  isSessionExpired() {
    return this.code === -32000 && this.message === 'Session expired';
  }
}


/**
 * Utility functions for working with MCP tools
 */
const MCPUtils = {
  /**
   * Format a tool's input schema as human-readable text
   * @param {Object} tool - Tool definition
   * @returns {string} Formatted parameters
   */
  formatParameters(tool) {
    if (!tool.inputSchema || !tool.inputSchema.properties) {
      return 'No parameters';
    }

    const props = tool.inputSchema.properties;
    const required = tool.inputSchema.required || [];

    return Object.entries(props).map(([name, schema]) => {
      const isRequired = required.includes(name);
      const type = schema.type || 'any';
      const desc = schema.description || '';
      const marker = isRequired ? '*' : '';

      return `  ${name}${marker} (${type}): ${desc}`;
    }).join('\n');
  },

  /**
   * Generate example call code for a tool
   * @param {Object} tool - Tool definition
   * @param {string} clientVar - Variable name for the client (default: 'client')
   * @returns {string} Example code
   */
  generateExample(tool, clientVar = 'client') {
    const args = {};

    if (tool.inputSchema && tool.inputSchema.properties) {
      const props = tool.inputSchema.properties;
      const required = tool.inputSchema.required || [];

      for (const name of required) {
        const schema = props[name];
        args[name] = MCPUtils._exampleValue(schema);
      }
    }

    const argsStr = JSON.stringify(args, null, 2);
    return `const result = await ${clientVar}.call('${tool.name}', ${argsStr});`;
  },

  /**
   * Generate an example value for a JSON schema type
   * @param {Object} schema - JSON schema
   * @returns {*} Example value
   * @private
   */
  _exampleValue(schema) {
    if (!schema) return null;

    if (schema.enum && schema.enum.length > 0) {
      return schema.enum[0];
    }

    if (schema.default !== undefined) {
      return schema.default;
    }

    switch (schema.type) {
      case 'string':
        return schema.description ? `<${schema.description}>` : 'example';
      case 'number':
      case 'integer':
        return schema.minimum !== undefined ? schema.minimum : 1;
      case 'boolean':
        return false;
      case 'array':
        return [];
      case 'object':
        return {};
      default:
        return null;
    }
  },

  /**
   * Format relative time (e.g., "2 hours ago")
   * @param {string|Date} date - Date to format
   * @returns {string} Relative time string
   */
  formatRelativeTime(date) {
    if (!date) return 'N/A';

    const d = date instanceof Date ? date : new Date(date);
    const now = new Date();
    const seconds = Math.floor((now - d) / 1000);

    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;

    return d.toLocaleDateString();
  },

  /**
   * Get the MCP protocol version this client implements
   * @returns {string} Protocol version
   */
  getProtocolVersion() {
    return MCP_PROTOCOL_VERSION;
  }
};


// Export for module environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MCPClient, MCPError, MCPUtils };
}
