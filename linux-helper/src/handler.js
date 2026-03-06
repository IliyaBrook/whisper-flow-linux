/**
 * Main request handler for Linux Helper
 * Routes HelperAPI requests to the appropriate Linux implementation
 */

const x11 = require('./x11-utils');
const accessibility = require('./accessibility');
const { ShortcutManager } = require('./shortcuts');
const { getHardwareInfo } = require('./hardware');

class Handler {
  constructor() {
    this.ready = false;
    this.featureFlags = {};
    this.intervals = null;
    this.shortcutManager = new ShortcutManager();
  }

  /**
   * Handle incoming HelperAPI request from Electron
   */
  async handleRequest(request, ipc) {
    const uuid = request.uuid || '';

    // Remove metadata fields to find the actual command
    const commandEntries = Object.entries(request).filter(
      ([key]) => !['uuid', 'sentryTrace', 'sentryBaggage'].includes(key)
    );

    for (const [command, value] of commandEntries) {
      try {
        await this._dispatch(command, value, uuid, ipc);
      } catch (err) {
        console.error(`Error handling ${command}: ${err.message}`);
        ipc.sendError(uuid, 'SOME_ERROR_TYPES', `${command} failed: ${err.message}`);
      }
    }
  }

  /**
   * Handle incoming HelperAPI response from Electron (bidirectional)
   */
  handleResponse(response, _ipc) {
    // Responses from Electron (bidirectional) — no action needed
  }

  async _dispatch(command, value, uuid, ipc) {
    switch (command) {
      // ========== Lifecycle ==========
      case 'IsReady':
        this.ready = true;
        // Give the ShortcutManager access to IPC and start key monitoring
        this.shortcutManager.setIPC(ipc);
        this.shortcutManager.start();
        // Electron expects just an ACK response for IsReady
        ipc.sendACK(uuid);
        break;

      case 'HelperAppShutdown':
        console.log('Received shutdown command');
        ipc.sendACK(uuid);
        setTimeout(() => process.exit(0), 100);
        break;

      case 'StartAllIntervals':
        this._startIntervals(ipc);
        ipc.sendACK(uuid);
        break;

      case 'StopAllIntervals':
        this._stopIntervals();
        ipc.sendACK(uuid);
        break;

      case 'StartAccessibilityServices':
        ipc.sendACK(uuid);
        break;

      // ========== Text Input & Paste ==========
      case 'PasteText': {
        const payload = value.payload || value;
        // Send ACK immediately so Electron doesn't timeout
        ipc.sendACK(uuid);

        // Restore focus to the window that was active when dictation started
        // (overlay windows with focusable:true may have stolen focus)
        await x11.focusStoredWindow();
        await x11.sleep(150);

        // Perform paste asynchronously
        const result = await x11.pasteText(payload.text, payload.htmlText);

        // Send PasteOutcome back to Electron
        ipc.sendRequest({
          uuid: this._uuid(),
          PasteOutcome: {
            payload: {
              success: result.success,
              timeElapsedMs: result.timeElapsedMs,
              transcriptEntityUUID: payload.transcriptEntityUUID || '',
            }
          }
        });
        break;
      }

      case 'UpdateEditedText': {
        const payload = value.payload || value;
        // Send ACK immediately
        ipc.sendACK(uuid);
        // Edit text = paste the edited version
        await x11.pasteText(payload.editedText);
        break;
      }

      case 'SimulateKeyPress': {
        const payload = value.payload || value;
        await x11.simulateKeyPress(payload.keycode, payload.flags || []);
        ipc.sendACK(uuid);
        break;
      }

      case 'CancelPaste':
        // Cancel any pending paste operation
        ipc.sendACK(uuid);
        break;

      // ========== Context & Focus ==========
      case 'GetAppInfo': {
        const info = await x11.getActiveWindowInfo();
        ipc.sendResponse({
          uuid,
          AppInfo: {
            payload: {
              appName: info.appName || 'Unknown',
              bundleId: info.wmClass || info.appName || '',
              url: info.url || '',
            }
          }
        });
        break;
      }

      case 'GetTextBoxInfo': {
        const textBoxInfo = await accessibility.getTextBoxInfo();
        ipc.sendResponse({
          uuid,
          TextBoxInfo: {
            payload: textBoxInfo
          }
        });
        break;
      }

      case 'StoreFocusedAppAndElement':
        await x11.storeFocusedWindow();
        ipc.sendACK(uuid);
        break;

      case 'FocusStoredAppAndElement':
        await x11.focusStoredWindow();
        ipc.sendACK(uuid);
        break;

      case 'SuggestSelectTextbox':
        // On Linux, we can't easily highlight a text box
        // Send ACK - the user should click the text field
        ipc.sendACK(uuid);
        break;

      case 'GetSelectedTextViaCopy': {
        const selectedText = await x11.getSelectedTextViaCopy();
        ipc.sendResponse({
          uuid,
          SelectedTextViaCopy: {
            payload: {
              beforeText: '',
              contents: selectedText,
              selectedText: selectedText,
            }
          }
        });
        break;
      }

      case 'GetDictatedTextPosition': {
        const payload = value.payload || value;
        // Find position of dictated text within textbox contents
        const contents = payload.textboxContents || '';
        const dictated = payload.dictatedText || '';
        const idx = contents.indexOf(dictated);
        let beforeText = '';
        let afterText = '';
        if (idx >= 0) {
          beforeText = contents.substring(0, idx);
          afterText = contents.substring(idx + dictated.length);
        }
        ipc.sendResponse({
          uuid,
          DictatedTextPosition: {
            payload: { beforeText, afterText }
          }
        });
        break;
      }

      case 'SetFocusChangeDetectorState': {
        const payload = value.payload || value;
        if (payload.active) {
          this.shortcutManager.start();
        } else {
          this.shortcutManager.stop();
        }
        ipc.sendACK(uuid);
        break;
      }

      // ========== App Context ==========
      case 'AppContextUpdate':
      case 'AppContextHTML':
      case 'CursorContextUpdate':
      case 'AppInfoUpdate':
        // These are informational updates from Electron, just ACK
        ipc.sendACK(uuid);
        break;

      // ========== Dictation Events ==========
      case 'DictationStart':
        // Store the currently focused window so we can restore focus before pasting
        await x11.storeFocusedWindow();
        ipc.sendACK(uuid);
        break;

      case 'DictationStop':
      case 'RecordingStarted':
      case 'PlayDictationStartSound':
      case 'PlayDictationStopSound':
        ipc.sendACK(uuid);
        break;

      // ========== Keyboard Events ==========
      case 'KeypressEvent':
        ipc.sendACK(uuid);
        break;

      case 'UpdateShortcuts':
        await this.shortcutManager.updateShortcuts();
        ipc.sendACK(uuid);
        break;

      case 'CheckStaleKeys': {
        const staleKeys = await this.shortcutManager.checkStaleKeys();
        ipc.sendResponse({
          uuid,
          StaleKeysResponse: {
            payload: { staleKeys }
          }
        });
        break;
      }

      // ========== Paste Feedback ==========
      case 'PasteOutcome':
      case 'PasteBlocked':
      case 'PasteAnalytics':
        ipc.sendACK(uuid);
        break;

      // ========== System ==========
      case 'GetHardwareInfo': {
        const hwInfo = await getHardwareInfo();
        ipc.sendResponse({
          uuid,
          HardwareInfo: {
            payload: hwInfo
          }
        });
        break;
      }

      case 'GetAccessibilityStatus': {
        const status = await accessibility.checkAccessibility();
        ipc.sendResponse({
          uuid,
          AccessibilityStatus: {
            payload: { status }
          }
        });
        break;
      }

      case 'RequestAccessibilityPermission':
        // On Linux, AT-SPI2 doesn't need special permissions
        // Just check if it's running
        ipc.sendResponse({
          uuid,
          AccessibilityStatus: {
            payload: { status: await accessibility.checkAccessibility() }
          }
        });
        break;

      case 'UpdateFeatureFlags': {
        const payload = value.payload || value;
        this.featureFlags = payload.featureFlags || {};
        ipc.sendACK(uuid);
        break;
      }

      case 'TrackAnalyticsEvent':
        ipc.sendACK(uuid);
        break;

      case 'DockInfoUpdate':
      case 'IsMediaPlayingUpdate':
      case 'AudioInterruptionEvent':
      case 'AudioCodecChanged':
        ipc.sendACK(uuid);
        break;

      case 'FireHaptic':
        // No haptic feedback on Linux
        ipc.sendACK(uuid);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        ipc.sendACK(uuid);
        break;
    }
  }

  _startIntervals(ipc) {
    if (this.intervals) return;

    // Periodically send app info updates
    this.intervals = setInterval(async () => {
      try {
        const info = await x11.getActiveWindowInfo();
        ipc.sendRequest({
          uuid: this._uuid(),
          AppInfoUpdate: {
            payload: {
              appName: info.appName || 'Unknown',
              bundleId: info.wmClass || info.appName || '',
              url: info.url || '',
            }
          }
        });
      } catch (err) {
        console.error(`Interval error: ${err.message}`);
      }
    }, 2000);
  }

  _stopIntervals() {
    if (this.intervals) {
      clearInterval(this.intervals);
      this.intervals = null;
    }
  }

  _uuid() {
    return `linux-helper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = { Handler };
