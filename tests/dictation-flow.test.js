/**
 * End-to-end tests for the voice dictation flow
 * Simulates the full lifecycle: dictation start → recording → paste → outcome
 *
 * These tests verify that the entire pipeline works correctly when
 * Electron sends a sequence of commands that happens during voice typing.
 */

jest.mock('../linux-helper/src/utils', () => (
  require('./helpers/linux-helper-test-mocks').createX11UtilsMock()
));

jest.mock('../linux-helper/src/accessibility', () => (
  require('./helpers/linux-helper-test-mocks').createAccessibilityMock({
    checkAccessibility: jest.fn().mockResolvedValue(true),
  })
));

jest.mock('../linux-helper/src/shortcuts', () => (
  require('./helpers/linux-helper-test-mocks').createShortcutManagerMock()
));

jest.mock('../linux-helper/src/hardware', () => (
  require('./helpers/linux-helper-test-mocks').createHardwareMock({
    getHardwareInfo: jest.fn().mockResolvedValue({
      hasAppleFnKey: false, isClamshellMode: false, connectedMice: [],
    }),
  })
));

const { createMockIPC } = require('./helpers/linux-helper-test-mocks');

const { Handler } = require('../linux-helper/src/handler');
const { IPC, escapeMessage, unescapeMessage } = require('../linux-helper/src/ipc');
const x11 = require('../linux-helper/src/utils');
const accessibility = require('../linux-helper/src/accessibility');

// ============================================================
// Full Dictation Flow
// ============================================================

describe('Full dictation flow', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
    jest.clearAllMocks();
  });

  test('complete voice typing session: start → context → paste → outcome', async () => {
    // Setup mocks
    x11.getActiveWindowInfo.mockResolvedValue({
      windowId: '12345', appName: 'Code', pid: 5678,
      title: 'main.js - Visual Studio Code', wmClass: 'code', url: '',
    });
    x11.storeFocusedWindow.mockResolvedValue();
    x11.focusStoredWindow.mockResolvedValue();
    x11.pasteText.mockResolvedValue({ success: true, timeElapsedMs: 120 });
    accessibility.getTextBoxInfo.mockResolvedValue({
      accessibilityIsFunctioning: true,
      beforeText: 'function ',
      afterText: '() {}',
      contents: 'function () {}',
      selectedText: '',
      isEditable: true,
      couldNotGetTextBoxInfo: false,
      focusedElementHash: 'editor-1',
    });

    // Step 1: App checks if helper is ready
    await handler.handleRequest({ uuid: 'flow-1', IsReady: true }, ipc);
    expect(handler.ready).toBe(true);
    expect(ipc.sendACK).toHaveBeenCalledWith('flow-1');

    // Step 2: Start accessibility services
    await handler.handleRequest({ uuid: 'flow-2', StartAccessibilityServices: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('flow-2');

    // Step 3: Get app info (which app is user typing in)
    await handler.handleRequest({ uuid: 'flow-3', GetAppInfo: true }, ipc);
    expect(ipc.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        uuid: 'flow-3',
        AppInfo: { payload: { appName: 'Code', bundleId: 'code', url: '' } }
      })
    );

    // Step 4: Store focused element before dictation UI appears
    await handler.handleRequest({ uuid: 'flow-4', StoreFocusedAppAndElement: true }, ipc);
    expect(x11.storeFocusedWindow).toHaveBeenCalled();

    // Step 5: User presses hotkey → DictationStart
    await handler.handleRequest({ uuid: 'flow-5', DictationStart: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('flow-5');

    // Step 6: Recording started
    await handler.handleRequest({ uuid: 'flow-6', RecordingStarted: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('flow-6');

    // Step 7: Get text box info for context
    await handler.handleRequest({ uuid: 'flow-7', GetTextBoxInfo: true }, ipc);
    expect(ipc.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        uuid: 'flow-7',
        TextBoxInfo: {
          payload: expect.objectContaining({
            accessibilityIsFunctioning: true,
            isEditable: true,
            beforeText: 'function ',
          })
        }
      })
    );

    // Step 8: User stops dictation → DictationStop
    await handler.handleRequest({ uuid: 'flow-8', DictationStop: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('flow-8');

    // Step 9: Restore focus to the editor
    await handler.handleRequest({ uuid: 'flow-9', FocusStoredAppAndElement: true }, ipc);
    expect(x11.focusStoredWindow).toHaveBeenCalled();

    // Step 10: Paste the transcribed text
    await handler.handleRequest({
      uuid: 'flow-10',
      PasteText: {
        payload: {
          text: 'calculateTotal',
          htmlText: '',
          transcriptEntityUUID: 'transcript-abc',
        }
      }
    }, ipc);

    expect(x11.pasteText).toHaveBeenCalledWith('calculateTotal', '');
    expect(ipc.sendACK).toHaveBeenCalledWith('flow-10');

    // Verify PasteOutcome was sent back
    expect(ipc.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        PasteOutcome: {
          payload: {
            success: true,
            timeElapsedMs: 120,
            transcriptEntityUUID: 'transcript-abc',
          }
        }
      })
    );
  });

  test('dictation with AI edit: paste → edit correction → final paste', async () => {
    x11.pasteText
      .mockResolvedValueOnce({ success: true, timeElapsedMs: 100 })  // initial paste
      .mockResolvedValueOnce({ success: true, timeElapsedMs: 80 });  // edited paste

    // Step 1: Initial paste of raw transcription
    await handler.handleRequest({
      uuid: 'edit-flow-1',
      PasteText: {
        payload: {
          text: 'their are bugs in the code',
          transcriptEntityUUID: 'tx-edit-1',
        }
      }
    }, ipc);

    expect(x11.pasteText).toHaveBeenCalledWith('their are bugs in the code', undefined);

    // Step 2: AI corrects the text, sends UpdateEditedText
    await handler.handleRequest({
      uuid: 'edit-flow-2',
      UpdateEditedText: {
        payload: {
          editedText: 'there are bugs in the code',
          pastedText: 'their are bugs in the code',
          transcriptEntityUUID: 'tx-edit-1',
          alignmentSteps: [
            { action: 'substitution', originalWord: 'their', editedWord: 'there' }
          ],
        }
      }
    }, ipc);

    expect(x11.pasteText).toHaveBeenCalledWith('there are bugs in the code');
    expect(ipc.sendACK).toHaveBeenCalledWith('edit-flow-2');
  });

  test('dictation with paste failure triggers error flow', async () => {
    x11.pasteText.mockResolvedValue({ success: false, timeElapsedMs: 50 });

    await handler.handleRequest({
      uuid: 'fail-flow-1',
      PasteText: {
        payload: { text: 'test text', transcriptEntityUUID: 'tx-fail' }
      }
    }, ipc);

    // PasteOutcome should report failure
    expect(ipc.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        PasteOutcome: {
          payload: expect.objectContaining({ success: false })
        }
      })
    );
  });
});

// ============================================================
// Feature Flag Flow
// ============================================================

describe('Feature flag integration', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
    jest.clearAllMocks();
  });

  test('feature flags are applied before dictation starts', async () => {
    // Step 1: Update feature flags
    await handler.handleRequest({
      uuid: 'ff-flow-1',
      UpdateFeatureFlags: {
        payload: {
          featureFlags: {
            'shift-insert': { enabled: true },
            'ax-context-v2': { enabled: true },
            'disable-clipboard-restore': { enabled: false },
          }
        }
      }
    }, ipc);

    expect(handler.featureFlags['shift-insert']).toEqual({ enabled: true });
    expect(handler.featureFlags['ax-context-v2']).toEqual({ enabled: true });

    // Step 2: Start dictation with flags active
    await handler.handleRequest({ uuid: 'ff-flow-2', DictationStart: true }, ipc);
    expect(ipc.sendACK).toHaveBeenCalledWith('ff-flow-2');
  });
});

// ============================================================
// Wire Protocol Integration
// ============================================================

describe('Wire protocol: full round-trip', () => {
  test('encode request → parse → handle → encode response is consistent', () => {
    // Simulate what Electron sends
    const request = {
      HelperAPIRequest: {
        uuid: 'wire-1',
        GetDictatedTextPosition: {
          payload: {
            dictatedText: 'hello world',
            textboxContents: 'Say hello world please',
            transcriptEntityUUID: 'tx-wire-1',
          }
        },
        sentryTrace: 'abc-trace',
        sentryBaggage: 'baggage=data',
      }
    };

    // Encode as wire format
    const json = JSON.stringify(request);
    const wireMsg = escapeMessage(json) + '|';

    // Decode
    const rawParts = wireMsg.split('|').filter(Boolean);
    expect(rawParts).toHaveLength(1);

    const decoded = JSON.parse(unescapeMessage(rawParts[0]));
    expect(decoded.HelperAPIRequest.uuid).toBe('wire-1');
    expect(decoded.HelperAPIRequest.GetDictatedTextPosition.payload.dictatedText).toBe('hello world');
  });

  test('response with special characters in text survives wire encoding', () => {
    const response = {
      HelperAPIResponse: {
        uuid: 'wire-2',
        TextBoxInfo: {
          payload: {
            accessibilityIsFunctioning: true,
            beforeText: 'price = $100 | discount + tax',
            afterText: '// end',
            contents: 'price = $100 | discount + tax // end',
            selectedText: '',
            isEditable: true,
            couldNotGetTextBoxInfo: false,
          }
        }
      }
    };

    const json = JSON.stringify(response);
    const wire = escapeMessage(json) + '|';

    // Verify no raw pipes in the body
    const bodyPart = wire.slice(0, -1);
    expect(bodyPart.indexOf('|')).toBe(-1);

    // Decode and verify
    const decoded = JSON.parse(unescapeMessage(bodyPart));
    expect(decoded.HelperAPIResponse.TextBoxInfo.payload.beforeText).toBe('price = $100 | discount + tax');
  });
});

// ============================================================
// Rapid Command Sequence
// ============================================================

describe('Rapid command sequences', () => {
  let handler;
  let ipc;

  beforeEach(() => {
    handler = new Handler();
    ipc = createMockIPC();
    jest.clearAllMocks();

    x11.pasteText.mockResolvedValue({ success: true, timeElapsedMs: 50 });
    x11.storeFocusedWindow.mockResolvedValue();
    x11.focusStoredWindow.mockResolvedValue();
    x11.getActiveWindowInfo.mockResolvedValue({
      windowId: '1', appName: 'Terminal', pid: 1, title: 'bash', wmClass: 'terminal', url: '',
    });
  });

  test('handles multiple rapid commands without race conditions', async () => {
    // Fire multiple commands concurrently (as Electron might do)
    await Promise.all([
      handler.handleRequest({ uuid: 'rapid-1', DictationStart: true }, ipc),
      handler.handleRequest({ uuid: 'rapid-2', GetAppInfo: true }, ipc),
      handler.handleRequest({ uuid: 'rapid-3', RecordingStarted: true }, ipc),
    ]);

    expect(ipc.sendACK).toHaveBeenCalledWith('rapid-1');
    expect(ipc.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'rapid-2' })
    );
    expect(ipc.sendACK).toHaveBeenCalledWith('rapid-3');
  });

  test('multiple paste operations complete independently', async () => {
    await handler.handleRequest({
      uuid: 'mp-1',
      PasteText: { payload: { text: 'first', transcriptEntityUUID: 'tx-1' } }
    }, ipc);

    await handler.handleRequest({
      uuid: 'mp-2',
      PasteText: { payload: { text: 'second', transcriptEntityUUID: 'tx-2' } }
    }, ipc);

    expect(x11.pasteText).toHaveBeenCalledTimes(2);
    expect(x11.pasteText).toHaveBeenNthCalledWith(1, 'first', undefined);
    expect(x11.pasteText).toHaveBeenNthCalledWith(2, 'second', undefined);
  });
});
