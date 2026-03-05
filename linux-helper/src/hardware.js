/**
 * Hardware information for Linux Helper
 * Gathers info about connected input devices
 */

const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * Get hardware info (mice, keyboard type, etc.)
 */
async function getHardwareInfo() {
  const result = {
    hasAppleFnKey: false,
    isClamshellMode: false,
    connectedMice: [],
  };

  try {
    // Read /proc/bus/input/devices
    if (fs.existsSync('/proc/bus/input/devices')) {
      const content = fs.readFileSync('/proc/bus/input/devices', 'utf8');
      const devices = content.split('\n\n');

      for (const device of devices) {
        // Check for mice
        if (device.includes('mouse') || device.includes('Mouse') || device.includes('EV=17')) {
          const nameMatch = device.match(/N: Name="([^"]+)"/);
          const vendorMatch = device.match(/I:.*Vendor=([0-9a-fA-F]+)/);
          const productMatch = device.match(/I:.*Product=([0-9a-fA-F]+)/);

          if (nameMatch) {
            result.connectedMice.push({
              name: nameMatch[1],
              isExternal: true,
              vendorId: vendorMatch ? vendorMatch[1] : '',
              productId: productMatch ? productMatch[1] : '',
            });
          }
        }

        // Check for Apple keyboard (Fn key)
        if (device.includes('Apple') && device.includes('Keyboard')) {
          result.hasAppleFnKey = true;
        }
      }
    }

    // Check clamshell mode (laptop lid)
    try {
      const lidState = fs.readFileSync('/proc/acpi/button/lid/LID0/state', 'utf8');
      result.isClamshellMode = lidState.includes('closed');
    } catch {
      // No lid = desktop = not clamshell
      result.isClamshellMode = false;
    }
  } catch (err) {
    console.error(`getHardwareInfo error: ${err.message}`);
  }

  return result;
}

module.exports = { getHardwareInfo };
