/**
 * Tests for IPC protocol layer
 * Verifies message encoding/decoding, envelope format, and message routing
 */

const { IPC, escapeMessage, unescapeMessage } = require('../linux-helper/src/ipc');

// ============================================================
// Message Encoding / Decoding
// ============================================================

describe('IPC message encoding', () => {
  test('escapeMessage escapes + to +1', () => {
    expect(escapeMessage('hello+world')).toBe('hello+1world');
  });

  test('escapeMessage escapes | to +2', () => {
    expect(escapeMessage('hello|world')).toBe('hello+2world');
  });

  test('escapeMessage escapes + before | (order matters)', () => {
    // "a+b|c" → first + becomes +1: "a+1b|c" → then | becomes +2: "a+1b+2c"
    expect(escapeMessage('a+b|c')).toBe('a+1b+2c');
  });

  test('unescapeMessage reverses +2 to | first, then +1 to +', () => {
    expect(unescapeMessage('a+1b+2c')).toBe('a+b|c');
  });

  test('roundtrip: escape then unescape preserves original', () => {
    const messages = [
      'simple text',
      'text with | pipe',
      'text with + plus',
      'both + and | chars',
      '+++|||',
      '+1+2 already looks escaped',
      '',
      '{"key":"value","nested":{"a":1}}',
    ];
    for (const msg of messages) {
      expect(unescapeMessage(escapeMessage(msg))).toBe(msg);
    }
  });

  test('escape handles JSON with special chars', () => {
    const json = '{"text":"hello|world","value":"a+b"}';
    const escaped = escapeMessage(json);
    expect(escaped).not.toContain('|');
    // + chars from escape sequences are ok, but original + should be escaped
    expect(unescapeMessage(escaped)).toBe(json);
  });

  test('empty string roundtrips correctly', () => {
    expect(escapeMessage('')).toBe('');
    expect(unescapeMessage('')).toBe('');
  });

  test('multiple consecutive special chars', () => {
    expect(escapeMessage('||++')).toBe('+2+2+1+1');
    expect(unescapeMessage('+2+2+1+1')).toBe('||++');
  });
});

// ============================================================
// IPC Class - Response/Request Envelope Format
// ============================================================

describe('IPC envelope formatting', () => {
  let ipc;
  let writtenData;
  let mockHandler;

  beforeEach(() => {
    writtenData = [];
    mockHandler = {
      handleRequest: jest.fn(),
      handleResponse: jest.fn(),
    };
    ipc = new IPC(mockHandler);
    // Mock the write pipe
    ipc.ipcWrite = {
      write: (data) => writtenData.push(data),
    };
  });

  test('sendACK sends correct envelope', () => {
    ipc.sendACK('test-uuid-123');

    expect(writtenData).toHaveLength(1);
    const raw = unescapeMessage(writtenData[0].replace(/\|$/, ''));
    const envelope = JSON.parse(raw);

    expect(envelope).toHaveProperty('HelperAPIResponse');
    expect(envelope.HelperAPIResponse.uuid).toBe('test-uuid-123');
    expect(envelope.HelperAPIResponse.ACK).toBe(true);
  });

  test('sendResponse wraps in HelperAPIResponse envelope', () => {
    ipc.sendResponse({
      uuid: 'resp-uuid',
      AppInfo: {
        payload: { appName: 'Firefox', bundleId: 'firefox', url: '' }
      }
    });

    expect(writtenData).toHaveLength(1);
    const raw = unescapeMessage(writtenData[0].replace(/\|$/, ''));
    const envelope = JSON.parse(raw);

    expect(envelope.HelperAPIResponse.uuid).toBe('resp-uuid');
    expect(envelope.HelperAPIResponse.AppInfo.payload.appName).toBe('Firefox');
  });

  test('sendRequest wraps in HelperAPIRequest envelope', () => {
    ipc.sendRequest({
      uuid: 'req-uuid',
      IsReady: true,
    });

    expect(writtenData).toHaveLength(1);
    const raw = unescapeMessage(writtenData[0].replace(/\|$/, ''));
    const envelope = JSON.parse(raw);

    expect(envelope.HelperAPIRequest.uuid).toBe('req-uuid');
    expect(envelope.HelperAPIRequest.IsReady).toBe(true);
  });

  test('sendError sends correct error envelope', () => {
    ipc.sendError('err-uuid', 'SOME_ERROR_TYPES', 'Something went wrong', { key: 'val' });

    expect(writtenData).toHaveLength(1);
    const raw = unescapeMessage(writtenData[0].replace(/\|$/, ''));
    const envelope = JSON.parse(raw);

    const resp = envelope.HelperAPIResponse;
    expect(resp.uuid).toBe('err-uuid');
    expect(resp.HelperAPIError.payload.type).toBe('SOME_ERROR_TYPES');
    expect(resp.HelperAPIError.payload.description).toBe('Something went wrong');
    expect(resp.HelperAPIError.payload.params).toEqual({ key: 'val' });
  });

  test('messages are terminated with pipe delimiter', () => {
    ipc.sendACK('uuid');
    expect(writtenData[0].endsWith('|')).toBe(true);
  });

  test('message body does not contain raw pipe chars', () => {
    // Response with pipe in data
    ipc.sendResponse({
      uuid: 'uuid',
      AppInfo: { payload: { appName: 'App|Name', bundleId: 'test', url: '' } }
    });

    // The escaped part (before trailing |) should not have unescaped pipes
    const escaped = writtenData[0].slice(0, -1); // remove trailing |
    // Any | in the body would break the protocol
    expect(escaped).not.toContain('|');
  });
});

// ============================================================
// IPC Message Routing
// ============================================================

describe('IPC message routing', () => {
  let ipc;
  let mockHandler;

  beforeEach(() => {
    mockHandler = {
      handleRequest: jest.fn(),
      handleResponse: jest.fn(),
    };
    ipc = new IPC(mockHandler);
    ipc.ipcWrite = { write: jest.fn() };
  });

  test('_handleMessage routes HelperAPIRequest to handler.handleRequest', () => {
    const msg = JSON.stringify({
      HelperAPIRequest: { uuid: 'test', IsReady: true }
    });

    ipc._handleMessage(msg);

    expect(mockHandler.handleRequest).toHaveBeenCalledWith(
      { uuid: 'test', IsReady: true },
      ipc
    );
  });

  test('_handleMessage routes HelperAPIResponse to handler.handleResponse', () => {
    const msg = JSON.stringify({
      HelperAPIResponse: { uuid: 'test', ACK: true }
    });

    ipc._handleMessage(msg);

    expect(mockHandler.handleResponse).toHaveBeenCalledWith(
      { uuid: 'test', ACK: true },
      ipc
    );
  });

  test('_handleMessage handles invalid JSON gracefully', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    ipc._handleMessage('not valid json{{{');
    expect(consoleSpy).toHaveBeenCalled();
    expect(mockHandler.handleRequest).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  test('_handleMessage handles unknown envelope type gracefully', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    ipc._handleMessage(JSON.stringify({ SomeOtherType: {} }));
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ============================================================
// Multi-Message Stream Parsing
// ============================================================

describe('IPC stream parsing', () => {
  test('multiple messages in one data chunk are all parsed', () => {
    const mockHandler = {
      handleRequest: jest.fn(),
      handleResponse: jest.fn(),
    };
    const ipc = new IPC(mockHandler);
    ipc.ipcWrite = { write: jest.fn() };

    // Simulate two messages arriving in one chunk
    const msg1 = escapeMessage(JSON.stringify({ HelperAPIRequest: { uuid: '1', IsReady: true } }));
    const msg2 = escapeMessage(JSON.stringify({ HelperAPIRequest: { uuid: '2', GetAppInfo: true } }));
    const chunk = msg1 + '|' + msg2 + '|';

    // Manually feed data like stdin would
    ipc.pendingData = '';
    ipc.pendingData += chunk;
    while (ipc.pendingData.includes('|')) {
      const idx = ipc.pendingData.indexOf('|');
      const raw = ipc.pendingData.slice(0, idx);
      ipc.pendingData = ipc.pendingData.slice(idx + 1);
      const msg = unescapeMessage(raw);
      if (msg) ipc._handleMessage(msg);
    }

    expect(mockHandler.handleRequest).toHaveBeenCalledTimes(2);
    expect(mockHandler.handleRequest.mock.calls[0][0].uuid).toBe('1');
    expect(mockHandler.handleRequest.mock.calls[1][0].uuid).toBe('2');
  });

  test('partial message is buffered until delimiter arrives', () => {
    const mockHandler = {
      handleRequest: jest.fn(),
      handleResponse: jest.fn(),
    };
    const ipc = new IPC(mockHandler);
    ipc.ipcWrite = { write: jest.fn() };

    const fullMsg = escapeMessage(JSON.stringify({ HelperAPIRequest: { uuid: 'partial', IsReady: true } }));
    const part1 = fullMsg.slice(0, 20);
    const part2 = fullMsg.slice(20) + '|';

    // Feed part 1
    ipc.pendingData += part1;
    // No delimiter yet, nothing should be parsed
    expect(ipc.pendingData.includes('|')).toBe(false);

    // Feed part 2
    ipc.pendingData += part2;
    while (ipc.pendingData.includes('|')) {
      const idx = ipc.pendingData.indexOf('|');
      const raw = ipc.pendingData.slice(0, idx);
      ipc.pendingData = ipc.pendingData.slice(idx + 1);
      const msg = unescapeMessage(raw);
      if (msg) ipc._handleMessage(msg);
    }

    expect(mockHandler.handleRequest).toHaveBeenCalledTimes(1);
    expect(mockHandler.handleRequest.mock.calls[0][0].uuid).toBe('partial');
  });
});
