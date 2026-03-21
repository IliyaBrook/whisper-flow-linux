function createX11UtilsMock(overrides = {}) {
  return {
    displayServer: 'x11',
    tools: { xdotool: true, xclip: true, xprop: true },
    getActiveWindowInfo: jest.fn(),
    pasteText: jest.fn(),
    simulateKeyPress: jest.fn(),
    simulateKeyCombo: jest.fn(),
    storeFocusedWindow: jest.fn(),
    focusStoredWindow: jest.fn(),
    getSelectedTextViaCopy: jest.fn(),
    getClipboard: jest.fn(),
    setClipboard: jest.fn(),
    sleep: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createAccessibilityMock(overrides = {}) {
  return {
    checkAccessibility: jest.fn(),
    getTextBoxInfo: jest.fn(),
    getAppContext: jest.fn(),
    ...overrides,
  };
}

function createShortcutManagerMock(overrides = {}) {
  return {
    ShortcutManager: jest.fn().mockImplementation(() => ({
      setIPC: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      updateShortcuts: jest.fn(),
      checkStaleKeys: jest.fn().mockResolvedValue([]),
      ...overrides,
    })),
  };
}

function createHardwareMock(overrides = {}) {
  return {
    getHardwareInfo: jest.fn(),
    ...overrides,
  };
}

function createMockIPC() {
  return {
    sendACK: jest.fn(),
    sendResponse: jest.fn(),
    sendRequest: jest.fn(),
    sendError: jest.fn(),
  };
}

module.exports = {
  createAccessibilityMock,
  createHardwareMock,
  createMockIPC,
  createShortcutManagerMock,
  createX11UtilsMock,
};
