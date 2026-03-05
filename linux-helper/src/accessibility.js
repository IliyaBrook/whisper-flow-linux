/**
 * Accessibility (AT-SPI2) integration for Linux Helper
 * Provides text field monitoring, context extraction, and text manipulation
 * via the Linux AT-SPI2 accessibility framework.
 *
 * AT-SPI2 is accessed via D-Bus. We use the `dbus-send` CLI tool or
 * the `atspi` Python module via subprocess for more complex operations.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');

const execAsync = promisify(exec);

/**
 * Check if AT-SPI2 is available and working
 */
async function checkAccessibility() {
  try {
    // Check if AT-SPI2 registry is running
    const { stdout } = await execAsync(
      'dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.freedesktop.DBus.Peer.Ping 2>/dev/null',
      { timeout: 3000 }
    );
    return true;
  } catch {
    // Try alternative check
    try {
      await execAsync('pidof at-spi2-registryd || pidof at-spi-bus-launcher', { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get text box info from the focused accessible element.
 * Uses a Python helper script that interfaces with AT-SPI2 via pyatspi2.
 */
async function getTextBoxInfo() {
  const defaultResult = {
    accessibilityIsFunctioning: false,
    beforeText: '',
    afterText: '',
    contents: '',
    selectedText: '',
    isEditable: false,
    couldNotGetTextBoxInfo: true,
    focusedElementHash: null,
  };

  try {
    const pythonScript = `
import sys, json
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi

    desktop = Atspi.get_desktop(0)
    result = {
        "accessibilityIsFunctioning": True,
        "beforeText": "",
        "afterText": "",
        "contents": "",
        "selectedText": "",
        "isEditable": False,
        "couldNotGetTextBoxInfo": True,
        "focusedElementHash": None,
    }

    # Walk through applications to find focused element
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        focused = find_focused(app)
        if focused:
            result["couldNotGetTextBoxInfo"] = False
            role = focused.get_role()

            # Check if editable
            state_set = focused.get_state_set()
            result["isEditable"] = state_set.contains(Atspi.StateType.EDITABLE)

            # Get text interface
            text_iface = focused.get_text_iface()
            if text_iface:
                char_count = text_iface.get_character_count()
                caret_pos = text_iface.get_caret_offset()
                full_text = text_iface.get_text(0, char_count)

                result["contents"] = full_text or ""
                if caret_pos >= 0:
                    result["beforeText"] = full_text[:caret_pos] if full_text else ""
                    result["afterText"] = full_text[caret_pos:] if full_text else ""

                # Get selection
                n_selections = text_iface.get_n_selections()
                if n_selections > 0:
                    sel = text_iface.get_selection(0)
                    if sel:
                        result["selectedText"] = full_text[sel.start_offset:sel.end_offset] if full_text else ""

                result["focusedElementHash"] = str(hash(focused))
            break

    print(json.dumps(result))
except Exception as e:
    print(json.dumps({
        "accessibilityIsFunctioning": False,
        "beforeText": "",
        "afterText": "",
        "contents": "",
        "selectedText": "",
        "isEditable": False,
        "couldNotGetTextBoxInfo": True,
        "focusedElementHash": None,
        "error": str(e)
    }))

def find_focused(node, depth=0):
    if depth > 30:
        return None
    try:
        state_set = node.get_state_set()
        if state_set.contains(Atspi.StateType.FOCUSED):
            return node
        for i in range(node.get_child_count()):
            child = node.get_child_at_index(i)
            if child:
                found = find_focused(child, depth + 1)
                if found:
                    return found
    except:
        pass
    return None
`;

    const { stdout } = await execAsync(
      `python3 -c ${escapeShellArg(pythonScript)}`,
      { timeout: 5000 }
    );

    const result = JSON.parse(stdout.trim());
    return result;
  } catch (err) {
    console.error(`getTextBoxInfo error: ${err.message}`);
    return defaultResult;
  }
}

/**
 * Get app context - nearest visible text elements
 */
async function getAppContext() {
  try {
    const pythonScript = `
import sys, json
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi

    desktop = Atspi.get_desktop(0)
    texts = []

    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        state_set = app.get_state_set()
        if state_set and state_set.contains(Atspi.StateType.ACTIVE):
            collect_texts(app, texts, depth=0, max_texts=20)
            break

    print(json.dumps({"nearestTexts": "\\n".join(texts)}))
except Exception as e:
    print(json.dumps({"nearestTexts": "", "error": str(e)}))

def collect_texts(node, texts, depth, max_texts):
    if depth > 15 or len(texts) >= max_texts:
        return
    try:
        text_iface = node.get_text_iface()
        if text_iface:
            count = text_iface.get_character_count()
            if count > 0 and count < 10000:
                t = text_iface.get_text(0, min(count, 500))
                if t and t.strip():
                    texts.append(t.strip())
        for i in range(node.get_child_count()):
            child = node.get_child_at_index(i)
            if child:
                collect_texts(child, texts, depth + 1, max_texts)
    except:
        pass
`;

    const { stdout } = await execAsync(
      `python3 -c ${escapeShellArg(pythonScript)}`,
      { timeout: 5000 }
    );

    return JSON.parse(stdout.trim());
  } catch (err) {
    console.error(`getAppContext error: ${err.message}`);
    return { nearestTexts: '' };
  }
}

function escapeShellArg(arg) {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

module.exports = {
  checkAccessibility,
  getTextBoxInfo,
  getAppContext,
};
