# Wispr Flow Helper IPC Protocol

## Transport

Helper is spawned as a child process with 4 stdio pipes:
```
stdio: ["pipe", "pipe", "pipe", "pipe"]
  fd 0 (stdin)  - Electron writes requests TO helper
  fd 1 (stdout) - Helper writes logs (non-IPC)
  fd 2 (stderr) - Helper writes errors
  fd 3 (pipe)   - Helper writes IPC responses/requests TO Electron
```

**Electron → Helper**: writes JSON to helper's **stdin**
**Helper → Electron**: writes JSON to **fd 3** (extra pipe)

## Message Format

- Messages are JSON strings separated by `|` (pipe character)
- Escape sequence: `+` → `+1`, `|` → `+2`
- Max message size: 30000 characters

### Encoding:
```
escapeMessage(msg) = msg.replaceAll("+", "+1").replaceAll("|", "+2")
unescapeMessage(msg) = msg.replaceAll("+2", "|").replaceAll("+1", "+")
```

### Wire format:
```
<escaped_json>|<escaped_json>|...
```

## Message Envelope

### Request (Electron → Helper):
```json
{
  "HelperAPIRequest": {
    "uuid": "unique-id",
    "<CommandName>": true | { "payload": { ... } },
    "sentryTrace": "optional",
    "sentryBaggage": "optional"
  }
}
```

### Response (Helper → Electron):
```json
{
  "HelperAPIResponse": {
    "uuid": "matching-request-uuid",
    "<ResponseName>": true | { "payload": { ... } }
  }
}
```

### Error Response:
```json
{
  "HelperAPIResponse": {
    "uuid": "matching-request-uuid",
    "HelperAPIError": {
      "payload": {
        "type": "SOME_ERROR_TYPES",
        "description": "error message",
        "params": {}
      }
    }
  }
}
```

## Environment Variables (passed to helper)

- `sentryDSN` - Sentry error tracking
- `environment` - dev/prod
- `segmentWriteKey` - Analytics
- `postHogProjectKey` - Feature flags
- `sentryLocalDebug` - Debug flag

---

## Request Types (Electron → Helper)

### Lifecycle
| Command | Payload | Description |
|---------|---------|-------------|
| `IsReady` | `true` | Check if helper is ready |
| `HelperAppShutdown` | `true` | Shutdown helper |
| `StartAllIntervals` | `true` | Start monitoring intervals |
| `StopAllIntervals` | `true` | Stop monitoring intervals |
| `StartAccessibilityServices` | `true` | Start accessibility monitoring |

### Text Input & Paste
| Command | Payload | Description |
|---------|---------|-------------|
| `PasteText` | `{ text, htmlText?, transcriptEntityUUID }` | Paste transcribed text into focused app |
| `UpdateEditedText` | `{ editedText, pastedText, foundContents?, alignmentSteps?, transcriptEntityUUID }` | Update/correct previously pasted text |
| `SimulateKeyPress` | `{ keycode, flags[] }` | Simulate a keyboard key press |
| `CancelPaste` | `true` | Cancel ongoing paste operation |

### Context & Focus
| Command | Payload | Description |
|---------|---------|-------------|
| `GetAppInfo` | `true` | Get info about focused application |
| `GetTextBoxInfo` | `true` | Get info about focused text field |
| `StoreFocusedAppAndElement` | `true` | Remember current focused element |
| `FocusStoredAppAndElement` | `true` | Restore focus to stored element |
| `SuggestSelectTextbox` | `true` | Suggest user select a text field |
| `GetSelectedTextViaCopy` | `{ copyMode? }` | Get selected text via clipboard copy |
| `GetDictatedTextPosition` | `{ dictatedText, textboxContents, transcriptEntityUUID }` | Find position of dictated text |
| `SetFocusChangeDetectorState` | `{ active: bool }` | Enable/disable focus change detection |

### App Context (for AI editing)
| Command | Payload | Description |
|---------|---------|-------------|
| `AppContextUpdate` | `{ conversationId, nearestTexts, elementDescription? }` | Update context from accessibility |
| `AppContextHTML` | `{ htmlContents }` | Update HTML context |
| `CursorContextUpdate` | `{ fileNames[], textAreaContents[], screenReaderMode? }` | Cursor/IDE integration |
| `AppInfoUpdate` | `{ payload }` | Update app info |

### Dictation Events
| Command | Payload | Description |
|---------|---------|-------------|
| `DictationStart` | `true` | Notify helper dictation started |
| `DictationStop` | `true` | Notify helper dictation stopped |
| `RecordingStarted` | `true` | Recording has begun |
| `PlayDictationStartSound` | `true` | Play start sound |
| `PlayDictationStopSound` | `true` | Play stop sound |

### Keyboard Events
| Command | Payload | Description |
|---------|---------|-------------|
| `KeypressEvent` | `{ eventType, index, key, inputType? }` | Report keypress to helper |
| `UpdateShortcuts` | `true` | Update global shortcuts |
| `CheckStaleKeys` | `{ payload }` | Check for stuck keys |

### Paste Feedback
| Command | Payload | Description |
|---------|---------|-------------|
| `PasteOutcome` | `{ success, timeElapsedMs, transcriptEntityUUID? }` | Report paste result |
| `PasteBlocked` | `{ reason }` | Report paste was blocked |
| `PasteAnalytics` | `{ clipboardLengthBefore?, clipboardLengthAfter?, ... }` | Paste analytics data |

### System
| Command | Payload | Description |
|---------|---------|-------------|
| `GetHardwareInfo` | `true` | Get hardware info (mice, keyboard) |
| `GetAccessibilityStatus` | `true` | Check accessibility permissions |
| `RequestAccessibilityPermission` | `true` | Request accessibility permission |
| `UpdateFeatureFlags` | `{ featureFlags: {...} }` | Update feature flags |
| `TrackAnalyticsEvent` | `{ event, properties? }` | Track analytics |
| `DockInfoUpdate` | `{ isVisible, x, y }` | Update dock info |
| `IsMediaPlayingUpdate` | `{ isPlaying }` | Media playing state |
| `AudioInterruptionEvent` | `{ interruptionType, reason, ... }` | Audio interruption |
| `FireHaptic` | `{ event }` | Fire haptic feedback |

---

## Response Types (Helper → Electron)

| Response | Payload | Description |
|----------|---------|-------------|
| `ACK` | `true` | Simple acknowledgment |
| `AppInfo` | `{ appName, bundleId, url }` | Focused app info |
| `TextBoxInfo` | `{ accessibilityIsFunctioning, beforeText, afterText, contents, selectedText, isEditable, couldNotGetTextBoxInfo, focusedElementHash? }` | Text field info |
| `AccessibilityStatus` | `{ status: bool }` | Accessibility permission status |
| `HardwareInfo` | `{ hasAppleFnKey, isClamshellMode, connectedMice[] }` | Hardware details |
| `DictatedTextPosition` | `{ beforeText?, afterText? }` | Position of dictated text |
| `SelectedTextViaCopy` | `{ beforeText, contents, selectedText }` | Selected text result |
| `StaleKeysResponse` | `{ staleKeys: number[] }` | Stuck key codes |
| `HelperAPIError` | `{ type, description, params? }` | Error response |

---

## Feature Flags

All flags have `{ enabled: bool }` structure:
- `ax-context-v2` - Accessibility context v2
- `complex-textbox-extraction` - Complex text field extraction
- `cursor-integration` - Cursor IDE integration
- `disable-clipboard-restore` - Don't restore clipboard after paste
- `failed-paste-notification` - Show notification on failed paste
- `focus-change-detector-enabled` - Focus change detection
- `focus-change-detector-app-change` - App change detection
- `is-audio-interruption-monitoring-enabled` - Audio interruption monitoring
- `kill-detached-helper` - Kill detached helper processes
- `kill-orphan` - Kill orphan processes
- `multi-keybind-service` - Multiple keybind service
- `shift-insert` - Use Shift+Insert for paste
- `skip-url-search` - Skip URL search
- `windows-key-up-simulation` - Windows key up simulation

---

## Linux Implementation Requirements

### Critical (app won't work without):
1. **PasteText** → xdotool/xclip/wl-clipboard to paste text
2. **GetAppInfo** → xdotool/xprop or D-Bus to get active window info
3. **GetTextBoxInfo** → AT-SPI2 to read text field contents
4. **IsReady/ACK** → Basic lifecycle management
5. **UpdateShortcuts** → X11 keybindings or D-Bus global shortcuts
6. **SimulateKeyPress** → xdotool/ydotool
7. **StoreFocusedAppAndElement / FocusStoredAppAndElement** → Save/restore focus

### Important (core features):
8. **GetAccessibilityStatus** → Check AT-SPI2 availability
9. **GetSelectedTextViaCopy** → xclip/wl-copy
10. **SetFocusChangeDetectorState** → X11 event monitoring
11. **GetDictatedTextPosition** → AT-SPI2 text interface
12. **CheckStaleKeys** → X11 key state query

### Nice to have:
13. **GetHardwareInfo** → /proc/bus/input/devices
14. **FireHaptic** → N/A on Linux (no-op)
15. **DockInfoUpdate** → Window manager info
