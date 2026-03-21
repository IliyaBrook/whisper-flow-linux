const EventEmitter = require('events');

function makeStream() {
  const stream = new EventEmitter();
  stream.destroy = jest.fn();
  return stream;
}

describe('ShortcutManager', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.XDG_SESSION_TYPE = 'wayland';
    process.env.DISPLAY = ':0';
    delete process.env.WAYLAND_DISPLAY;
  });

  test('starts xinput fallback on Wayland when evdev access is only partial', () => {
    const spawn = jest.fn(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.kill = jest.fn();
      return proc;
    });
    const spawnSync = jest.fn(() => ({ status: 0 }));

    jest.doMock('child_process', () => ({ spawn, spawnSync }));
    jest.doMock('fs', () => ({
      appendFileSync: jest.fn(),
      existsSync: jest.fn(() => true),
      readdirSync: jest.fn(() => ['keyboard-a-event-kbd', 'keyboard-b-event-kbd']),
      realpathSync: jest.fn((entry) => (
        entry.includes('keyboard-a') ? '/dev/input/event2' : '/dev/input/event8'
      )),
      openSync: jest.fn((devicePath) => {
        if (devicePath === '/dev/input/event2') {
          const err = new Error('permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return 39;
      }),
      createReadStream: jest.fn(() => makeStream()),
      readFileSync: jest.fn(),
    }));

    const { ShortcutManager } = require('../linux-helper/src/shortcuts');
    const manager = new ShortcutManager();

    manager.start();

    expect(spawn).toHaveBeenCalledWith('xinput', ['test-xi2', '--root'], {
      stdio: ['ignore', 'pipe', 'ignore']
    });
  });

  test('deduplicates repeated key state transitions before sending IPC events', () => {
    const spawnSync = jest.fn(() => ({ status: 0 }));

    jest.doMock('child_process', () => ({
      spawn: jest.fn(),
      spawnSync,
    }));
    jest.doMock('fs', () => ({
      appendFileSync: jest.fn(),
      existsSync: jest.fn(() => false),
      readdirSync: jest.fn(),
      realpathSync: jest.fn(),
      openSync: jest.fn(),
      createReadStream: jest.fn(),
      readFileSync: jest.fn(),
    }));

    const { ShortcutManager } = require('../linux-helper/src/shortcuts');
    const manager = new ShortcutManager();
    const ipc = { sendRequest: jest.fn() };
    manager.setIPC(ipc);

    manager._forwardKeyState(65, true);
    manager._forwardKeyState(65, true);
    manager._forwardKeyState(65, false);
    manager._forwardKeyState(65, false);

    expect(ipc.sendRequest).toHaveBeenCalledTimes(2);
    expect(ipc.sendRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        KeypressEvent: expect.objectContaining({
          payload: expect.objectContaining({
            eventType: 'key_event_press',
            key: 65,
          })
        })
      })
    );
    expect(ipc.sendRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        KeypressEvent: expect.objectContaining({
          payload: expect.objectContaining({
            eventType: 'key_event_release',
            key: 65,
          })
        })
      })
    );
  });
});
