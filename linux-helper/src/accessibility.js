/**
 * Accessibility (AT-SPI2) integration for Linux Helper
 * Provides text field monitoring and context extraction
 * via the Linux AT-SPI2 accessibility framework.
 *
 * AT-SPI2 is accessed via D-Bus. We use the `dbus-send` CLI tool or
 * the `atspi` Python module via subprocess for more complex operations.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');

const execAsync = promisify(exec);

const PYTHON_ACCESSIBILITY_COMMON = `
import json
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

TEXT_ROLES = {
    Atspi.Role.TEXT,
    Atspi.Role.ENTRY,
    Atspi.Role.PASSWORD_TEXT,
    Atspi.Role.TERMINAL,
    Atspi.Role.DOCUMENT_TEXT,
    Atspi.Role.PARAGRAPH,
}

def safe_state(node):
    try:
        return node.get_state_set()
    except Exception:
        return None

def has_state(node, state_type):
    state_set = safe_state(node)
    return bool(state_set and state_set.contains(state_type))

def has_text_capability(node):
    try:
        return bool(node.get_text_iface() or node.get_editable_text_iface())
    except Exception:
        return False

def is_editable_text_candidate(node):
    if node is None:
        return False
    try:
        role = node.get_role()
    except Exception:
        role = None

    editable = has_state(node, Atspi.StateType.EDITABLE)
    if not editable:
        return False

    return has_text_capability(node) or role in TEXT_ROLES

def walk_children(node, depth=0, max_depth=40):
    if node is None or depth > max_depth:
        return
    yield node
    try:
        child_count = node.get_child_count()
    except Exception:
        child_count = 0

    for i in range(child_count):
        try:
            child = node.get_child_at_index(i)
        except Exception:
            child = None
        if child:
            yield from walk_children(child, depth + 1, max_depth)

def find_focused_node(node):
    for candidate in walk_children(node):
        if has_state(candidate, Atspi.StateType.FOCUSED):
            return candidate
    return None

def editable_ancestors(node, max_depth=20):
    current = node
    depth = 0
    while current is not None and depth < max_depth:
        yield current
        try:
            current = current.get_parent()
        except Exception:
            current = None
        depth += 1

def resolve_target():
    desktop = Atspi.get_desktop(0)
    focused_node = None

    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        focused_node = find_focused_node(app)
        if focused_node:
            break

    if focused_node is None:
        return None

    for candidate in editable_ancestors(focused_node):
        if is_editable_text_candidate(candidate):
            return candidate

    for candidate in walk_children(focused_node):
        if is_editable_text_candidate(candidate):
            return candidate

    return None
`;

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
import sys
${PYTHON_ACCESSIBILITY_COMMON}

try:
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

    target = resolve_target()
    if target is None:
        print(json.dumps(result))
        sys.exit(0)

    result["couldNotGetTextBoxInfo"] = False
    result["isEditable"] = has_state(target, Atspi.StateType.EDITABLE)
    result["focusedElementHash"] = str(hash(target))

    text_iface = target.get_text_iface()
    if text_iface:
        char_count = text_iface.get_character_count()
        caret_pos = text_iface.get_caret_offset()
        full_text = text_iface.get_text(0, char_count) or ""

        result["contents"] = full_text
        if caret_pos >= 0:
            result["beforeText"] = full_text[:caret_pos]
            result["afterText"] = full_text[caret_pos:]

        n_selections = text_iface.get_n_selections()
        if n_selections > 0:
            sel = text_iface.get_selection(0)
            if sel:
                result["selectedText"] = full_text[sel.start_offset:sel.end_offset]

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
