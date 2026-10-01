// Hands a drag that is under way over to macOS.
//
// A window the system drags behaves like any other: held at the side of the
// screen it goes to the next desktop, and Stage Manager or the menu bar never
// fight over where it is. Electron only starts such a drag from a mouse-down on
// an app-region, which swallows the click, so the window is asked directly
// (performWindowDragWithEvent, through the Objective-C runtime).

import { createRequire } from 'node:module';

const MOUSE_DOWN = 1; // NSEventTypeLeftMouseDown
const MOUSE_DRAGGED = 6; // NSEventTypeLeftMouseDragged

let objc; // undefined: not loaded yet; null: unavailable

function load() {
  if (objc !== undefined) return objc;
  objc = null;
  if (process.platform !== 'darwin') return objc;
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const lib = koffi.load('/usr/lib/libobjc.A.dylib');
    objc = {
      cls: lib.func('objc_getClass', 'uintptr_t', ['str']),
      sel: lib.func('sel_registerName', 'uintptr_t', ['str']),
      send: lib.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']),
      send1: lib.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uintptr_t']),
    };
  } catch (e) {
    console.warn(`[drag] no native drag: ${e.message}`);
  }
  return objc;
}

// True if macOS took the drag over. Call while the mouse button is held, in
// response to the press or a move; otherwise (or off macOS) returns false.
export function startNativeDrag(win) {
  const o = load();
  if (!o) return false;
  try {
    const event = o.send(o.send(o.cls('NSApplication'), o.sel('sharedApplication')), o.sel('currentEvent'));
    if (!event) return false;
    const type = Number(o.send(event, o.sel('type')));
    if (type !== MOUSE_DOWN && type !== MOUSE_DRAGGED) return false;
    const view = win.getNativeWindowHandle().readBigUInt64LE(0);
    o.send1(o.send(view, o.sel('window')), o.sel('performWindowDragWithEvent:'), event);
    return true;
  } catch (e) {
    console.warn(`[drag] native drag failed: ${e.message}`);
    return false;
  }
}
