/**
 * Tests for the Handler - verifies all HelperAPI commands are correctly routed
 * and produce the expected IPC responses.
 *
 * We mock all native dependencies (utils, accessibility, etc.) since
 * these tests run without a display server.
 */

// Mock native modules before requiring handler
jest.mock('../linux-helper/src/utils', () => (
  require('./helpers/linux-helper-test-mocks').createX11UtilsMock()
));

jest.mock('../linux-helper/src/accessibility', () => (
  require('./helpers/linux-helper-test-mocks').createAccessibilityMock()
));

jest.mock('../linux-helper/src/shortcuts', () => (
  require('./helpers/linux-helper-test-mocks').createShortcutManagerMock()
));

jest.mock('../linux-helper/src/hardware', () => (
  require('./helpers/linux-helper-test-mocks').createHardwareMock()
));

const { createMockIPC } = require('./helpers/linux-helper-test-mocks');

const { Handler } = require('../linux-helper/src/handler');
const x11 = require('../linux-helper/src/utils');
const accessibility = require('../linux-helper/src/accessibility');
const { getHardwareInfo } = require('../linux-helper/src/hardware');

// ============================================================
// Lifecycle Commands
// ============================================================

describe('Handler: lifecycle commands', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
    jest.clearAllMocks();
  });

  test('IsReady sets ready=true and sends ACK + readiness signal', async () => {
    await handler.handleRequest({ uuid: 'u1', IsReady: true }, ipc);

    expect(handler.ready).toBe(true);
    expect(ipc.sendACK).toHaveBeenCalledWith('u1');
    expect(handler.shortcutManager.setIPC).toHaveBeenCalledWith(ipc);
    expect(handler.shortcutManager.start).toHaveBeenCalled();
  });

  test('HelperAppShutdown sends ACK', async () => {
    // Mock process.exit and timers to prevent actual exit
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation();
    jest.useFakeTimers();

    await handler.handleRequest({ uuid: 'u2', HelperAppShutdown: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('u2');

    // Advance timers to trigger the delayed exit
    jest.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(0);

    jest.useRealTimers();
    exitSpy.mockRestore();
  });

  test('StartAllIntervals sends ACK', async () => {
    await handler.handleRequest({ uuid: 'u3', StartAllIntervals: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('u3');
    // Cleanup interval
    handler._stopIntervals();
  });

  test('StopAllIntervals sends ACK', async () => {
    await handler.handleRequest({ uuid: 'u4', StopAllIntervals: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('u4');
  });

  test('StartAccessibilityServices sends ACK', async () => {
    await handler.handleRequest({ uuid: 'u5', StartAccessibilityServices: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('u5');
  });
});

// ============================================================
// Text Input & Paste Commands
// ============================================================

describe('Handler: text input & paste', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
    jest.clearAllMocks();
  });

  test('PasteText calls x11.pasteText and sends ACK + PasteOutcome', async () => {
    x11.pasteText.mockResolvedValue({ success: true, timeElapsedMs: 150 });

    await handler.handleRequest({
      uuid: 'paste-1',
      PasteText: {
        payload: {
          text: 'Hello world from voice',
          htmlText: '',
          transcriptEntityUUID: 'transcript-123',
        }
      }
    }, ipc);

    expect(x11.pasteText).toHaveBeenCalledWith('Hello world from voice', '');
    expect(ipc.sendACK).toHaveBeenCalledWith('paste-1');
    expect(ipc.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        PasteOutcome: {
          payload: {
            success: true,
            timeElapsedMs: 150,
            transcriptEntityUUID: 'transcript-123',
          }
        }
      })
    );
  });

  test('PasteText handles failure gracefully', async () => {
    x11.pasteText.mockResolvedValue({ success: false, timeElapsedMs: 50 });

    await handler.handleRequest({
      uuid: 'paste-fail',
      PasteText: { payload: { text: 'test', transcriptEntityUUID: '' } }
    }, ipc);

    expect(ipc.sendACK).toHaveBeenCalledWith('paste-fail');
    expect(ipc.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        PasteOutcome: expect.objectContaining({
          payload: expect.objectContaining({ success: false })
        })
      })
    );
  });

  test('UpdateEditedText calls pasteText with edited text', async () => {
    x11.pasteText.mockResolvedValue({ success: true, timeElapsedMs: 100 });

    await handler.handleRequest({
      uuid: 'edit-1',
      UpdateEditedText: {
        payload: {
          editedText: 'Corrected text',
          pastedText: 'Original text',
          transcriptEntityUUID: 'tx-1',
        }
      }
    }, ipc);

    expect(x11.pasteText).toHaveBeenCalledWith('Corrected text');
    expect(ipc.sendACK).toHaveBeenCalledWith('edit-1');
  });

  test('SimulateKeyPress calls x11.simulateKeyPress with keycode and flags', async () => {
    x11.simulateKeyPress.mockResolvedValue();

    await handler.handleRequest({
      uuid: 'key-1',
      SimulateKeyPress: {
        payload: { keycode: 0x0D, flags: ['shift'] }
      }
    }, ipc);

    expect(x11.simulateKeyPress).toHaveBeenCalledWith(0x0D, ['shift']);
    expect(ipc.sendACK).toHaveBeenCalledWith('key-1');
  });

  test('CancelPaste sends ACK', async () => {
    await handler.handleRequest({ uuid: 'cancel-1', CancelPaste: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('cancel-1');
  });
});

// ============================================================
// Context & Focus Commands
// ============================================================

describe('Handler: context & focus', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
    jest.clearAllMocks();
  });

  test('GetAppInfo returns active window info', async () => {
    x11.getActiveWindowInfo.mockResolvedValue({
      windowId: '12345',
      appName: 'Firefox',
      pid: 1234,
      title: 'Google - Mozilla Firefox',
      wmClass: 'firefox',
      url: '',
    });

    await handler.handleRequest({ uuid: 'app-1', GetAppInfo: true }, ipc);

    expect(ipc.sendResponse).toHaveBeenCalledWith({
      uuid: 'app-1',
      AppInfo: {
        payload: {
          appName: 'Firefox',
          bundleId: 'firefox',
          url: '',
        }
      }
    });
  });

  test('GetTextBoxInfo returns accessibility data', async () => {
    accessibility.getTextBoxInfo.mockResolvedValue({
      accessibilityIsFunctioning: true,
      beforeText: 'Hello ',
      afterText: ' world',
      contents: 'Hello  world',
      selectedText: '',
      isEditable: true,
      couldNotGetTextBoxInfo: false,
      focusedElementHash: 'abc123',
    });

    await handler.handleRequest({ uuid: 'tb-1', GetTextBoxInfo: true }, ipc);

    expect(ipc.sendResponse).toHaveBeenCalledWith({
      uuid: 'tb-1',
      TextBoxInfo: {
        payload: {
          accessibilityIsFunctioning: true,
          beforeText: 'Hello ',
          afterText: ' world',
          contents: 'Hello  world',
          selectedText: '',
          isEditable: true,
          couldNotGetTextBoxInfo: false,
          focusedElementHash: 'abc123',
        }
      }
    });
  });

  test('StoreFocusedAppAndElement calls storeFocusedWindow', async () => {
    x11.storeFocusedWindow.mockResolvedValue();
    await handler.handleRequest({ uuid: 'store-1', StoreFocusedAppAndElement: true }, ipc);
    expect(x11.storeFocusedWindow).toHaveBeenCalled();
    expect(ipc.sendACK).toHaveBeenCalledWith('store-1');
  });

  test('FocusStoredAppAndElement calls focusStoredWindow', async () => {
    x11.focusStoredWindow.mockResolvedValue();
    await handler.handleRequest({ uuid: 'focus-1', FocusStoredAppAndElement: true }, ipc);
    expect(x11.focusStoredWindow).toHaveBeenCalled();
    expect(ipc.sendACK).toHaveBeenCalledWith('focus-1');
  });

  test('GetSelectedTextViaCopy returns clipboard content', async () => {
    x11.getSelectedTextViaCopy.mockResolvedValue('selected text here');

    await handler.handleRequest({ uuid: 'sel-1', GetSelectedTextViaCopy: { payload: {} } }, ipc);

    expect(ipc.sendResponse).toHaveBeenCalledWith({
      uuid: 'sel-1',
      SelectedTextViaCopy: {
        payload: {
          afterText: '',
          beforeText: '',
          contents: 'selected text here',
          selectedText: 'selected text here',
        }
      }
    });
  });

  test('GetDictatedTextPosition finds text position correctly', async () => {
    await handler.handleRequest({
      uuid: 'pos-1',
      GetDictatedTextPosition: {
        payload: {
          dictatedText: 'voice input',
          textboxContents: 'Hello voice input world',
          transcriptEntityUUID: 'tx-1',
        }
      }
    }, ipc);

    expect(ipc.sendResponse).toHaveBeenCalledWith({
      uuid: 'pos-1',
      DictatedTextPosition: {
        payload: {
          beforeText: 'Hello ',
          afterText: ' world',
        }
      }
    });
  });

  test('GetDictatedTextPosition handles text not found', async () => {
    await handler.handleRequest({
      uuid: 'pos-2',
      GetDictatedTextPosition: {
        payload: {
          dictatedText: 'missing text',
          textboxContents: 'Hello world',
          transcriptEntityUUID: 'tx-2',
        }
      }
    }, ipc);

    expect(ipc.sendResponse).toHaveBeenCalledWith({
      uuid: 'pos-2',
      DictatedTextPosition: {
        payload: { beforeText: '', afterText: '' }
      }
    });
  });
});

// ============================================================
// Dictation Events
// ============================================================

describe('Handler: dictation events', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
  });

  const dictationCommands = [
    'DictationStart',
    'DictationStop',
    'RecordingStarted',
    'PlayDictationStartSound',
    'PlayDictationStopSound',
  ];

  test.each(dictationCommands)('%s sends ACK', async (command) => {
    await handler.handleRequest({ uuid: `dict-${command}`, [command]: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith(`dict-${command}`);
  });
});

// ============================================================
// System Commands
// ============================================================

describe('Handler: system commands', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
    jest.clearAllMocks();
  });

  test('GetHardwareInfo returns hardware data', async () => {
    getHardwareInfo.mockResolvedValue({
      hasAppleFnKey: false,
      isClamshellMode: false,
      connectedMice: [{ name: 'Logitech MX', isExternal: true }],
    });

    await handler.handleRequest({ uuid: 'hw-1', GetHardwareInfo: true }, ipc);

    expect(ipc.sendResponse).toHaveBeenCalledWith({
      uuid: 'hw-1',
      HardwareInfo: {
        payload: {
          hasAppleFnKey: false,
          isClamshellMode: false,
          connectedMice: [{ name: 'Logitech MX', isExternal: true }],
        }
      }
    });
  });

  test('GetAccessibilityStatus returns accessibility state', async () => {
    accessibility.checkAccessibility.mockResolvedValue(true);

    await handler.handleRequest({ uuid: 'ax-1', GetAccessibilityStatus: true }, ipc);

    expect(ipc.sendResponse).toHaveBeenCalledWith({
      uuid: 'ax-1',
      AccessibilityStatus: {
        payload: { status: true }
      }
    });
  });

  test('UpdateFeatureFlags stores flags', async () => {
    const flags = {
      'ax-context-v2': { enabled: true },
      'shift-insert': { enabled: false },
    };

    await handler.handleRequest({
      uuid: 'ff-1',
      UpdateFeatureFlags: { payload: { featureFlags: flags } }
    }, ipc);

    expect(handler.featureFlags).toEqual(flags);
    expect(ipc.sendACK).toHaveBeenCalledWith('ff-1');
  });

  test('CheckStaleKeys returns stale keys array', async () => {
    await handler.handleRequest({ uuid: 'stale-1', CheckStaleKeys: { payload: {} } }, ipc);

    expect(ipc.sendResponse).toHaveBeenCalledWith({
      uuid: 'stale-1',
      StaleKeysResponse: {
        payload: { staleKeys: [] }
      }
    });
  });
});

// ============================================================
// ACK-only Commands
// ============================================================

describe('Handler: ACK-only commands', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
  });

  const ackCommands = [
    'AppContextUpdate',
    'AppContextHTML',
    'CursorContextUpdate',
    'AppInfoUpdate',
    'KeypressEvent',
    'PasteOutcome',
    'PasteBlocked',
    'PasteAnalytics',
    'TrackAnalyticsEvent',
    'DockInfoUpdate',
    'IsMediaPlayingUpdate',
    'AudioInterruptionEvent',
    'AudioCodecChanged',
    'FireHaptic',
    'SuggestSelectTextbox',
  ];

  test.each(ackCommands)('%s sends ACK', async (command) => {
    await handler.handleRequest({ uuid: `ack-${command}`, [command]: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith(`ack-${command}`);
  });
});

// ============================================================
// Metadata Filtering
// ============================================================

describe('Handler: metadata filtering', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
    jest.clearAllMocks();
  });

  test('sentryTrace and sentryBaggage are ignored as commands', async () => {
    await handler.handleRequest({
      uuid: 'meta-1',
      sentryTrace: 'trace-id',
      sentryBaggage: 'baggage-data',
      IsReady: true,
    }, ipc);

    // Should only process IsReady, not sentryTrace/sentryBaggage
    expect(ipc.sendACK).toHaveBeenCalledTimes(1);
    expect(handler.ready).toBe(true);
  });

  test('unknown command sends ACK (no crash)', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    await handler.handleRequest({ uuid: 'unk-1', SomeNewCommand: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('unk-1');
    consoleSpy.mockRestore();
  });
});

// ============================================================
// Error Handling
// ============================================================

describe('Handler: error handling', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
    jest.clearAllMocks();
  });

  test('exception in command handler sends error response', async () => {
    x11.pasteText.mockRejectedValue(new Error('Clipboard unavailable'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await handler.handleRequest({
      uuid: 'err-1',
      PasteText: { payload: { text: 'test', transcriptEntityUUID: '' } }
    }, ipc);

    expect(ipc.sendError).toHaveBeenCalledWith(
      'err-1',
      'SOME_ERROR_TYPES',
      expect.stringContaining('Clipboard unavailable')
    );
    consoleSpy.mockRestore();
  });
});
