/**
 * IPC transport layer for Linux Helper
 * Communicates with Electron main process via:
 *   stdin (fd 0)  - receives requests FROM Electron
 *   fd 3 (pipe)   - sends responses TO Electron
 *   stdout (fd 1) - logs (non-IPC)
 *   stderr (fd 2) - errors
 */

const DELIMITER = '|';
const ESCAPE_CHAR = '+';

function escapeMessage(msg) {
  return msg.replaceAll(ESCAPE_CHAR, `${ESCAPE_CHAR}1`).replaceAll(DELIMITER, `${ESCAPE_CHAR}2`);
}

function unescapeMessage(msg) {
  return msg.replaceAll(`${ESCAPE_CHAR}2`, DELIMITER).replaceAll(`${ESCAPE_CHAR}1`, ESCAPE_CHAR);
}

class IPC {
  constructor(handler) {
    this.handler = handler;
    this.pendingData = '';
    this.ipcWrite = null;
  }

  start() {
    // fd 3 is the IPC output pipe (to Electron)
    try {
      const net = require('net');
      this.ipcWrite = new net.Socket({ fd: 3, writable: true, readable: false });
      this.ipcWrite.on('error', (err) => {
        console.error(`IPC write pipe error: ${err.message}`);
      });
    } catch (err) {
      console.error(`Failed to open fd 3 for IPC: ${err.message}`);
      // Fallback: use stdout (less ideal but functional for testing)
      this.ipcWrite = process.stdout;
    }

    // Read requests from stdin
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (data) => {
      this.pendingData += data;
      while (this.pendingData.includes(DELIMITER)) {
        const idx = this.pendingData.indexOf(DELIMITER);
        const raw = this.pendingData.slice(0, idx);
        this.pendingData = this.pendingData.slice(idx + 1);
        const msg = unescapeMessage(raw);
        if (msg) {
          this._handleMessage(msg);
        }
      }
    });

    process.stdin.on('end', () => {
      console.log('stdin closed, shutting down');
      process.exit(0);
    });

    process.stdin.on('error', (err) => {
      console.error(`stdin error: ${err.message}`);
    });
  }

  _handleMessage(raw) {
    try {
      const envelope = JSON.parse(raw);
      if (envelope.HelperAPIRequest) {
        this.handler.handleRequest(envelope.HelperAPIRequest, this);
      } else if (envelope.HelperAPIResponse) {
        // Electron sometimes sends responses too (bidirectional)
        this.handler.handleResponse(envelope.HelperAPIResponse, this);
      } else {
        console.error(`Unknown message type: ${raw.substring(0, 100)}`);
      }
    } catch (err) {
      console.error(`Failed to parse message: ${err.message} | raw: ${raw.substring(0, 200)}`);
    }
  }

  sendResponse(response) {
    const envelope = { HelperAPIResponse: response };
    const json = JSON.stringify(envelope);
    const escaped = escapeMessage(json) + DELIMITER;
    try {
      this.ipcWrite.write(escaped);
    } catch (err) {
      console.error(`Failed to write IPC response: ${err.message}`);
    }
  }

  sendRequest(request) {
    const envelope = { HelperAPIRequest: request };
    const json = JSON.stringify(envelope);
    const escaped = escapeMessage(json) + DELIMITER;
    try {
      this.ipcWrite.write(escaped);
    } catch (err) {
      console.error(`Failed to write IPC request: ${err.message}`);
    }
  }

  sendError(uuid, type, description, params) {
    this.sendResponse({
      uuid,
      HelperAPIError: {
        payload: {
          type: type || 'SOME_ERROR_TYPES',
          description: description || 'Unknown error',
          params: params || {}
        }
      }
    });
  }

  sendACK(uuid) {
    this.sendResponse({ uuid, ACK: true });
  }
}

module.exports = { IPC, escapeMessage, unescapeMessage };
