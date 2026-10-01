// Cuts a window's material to a shape.
//
// Electron's vibrancy fills the window (rounded, on macOS 26) with the system
// material; a balloon wants it only inside its outline, tail and all. The
// material is an NSVisualEffectView, which takes a mask image: the view is
// found in the window and handed the outline as a PNG (through the
// Objective-C runtime, like native-drag.js).

import { createRequire } from 'node:module';

let objc; // undefined: not loaded yet; null: unavailable

function load() {
  if (objc !== undefined) return objc;
  objc = null;
  if (process.platform !== 'darwin') return objc;
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const lib = koffi.load('/usr/lib/libobjc.A.dylib');
    const size = koffi.struct('GlassMaskSize', { width: 'double', height: 'double' });
    const id = 'uintptr_t';
    objc = {
      cls: lib.func('objc_getClass', id, ['str']),
      sel: lib.func('sel_registerName', id, ['str']),
      send: lib.func('objc_msgSend', id, [id, id]),
      send1: lib.func('objc_msgSend', id, [id, id, id]),
      sendBytes: lib.func('objc_msgSend', id, [id, id, 'void *', 'size_t']),
      sendSize: lib.func('objc_msgSend', 'void', [id, id, size]),
    };
  } catch (e) {
    console.warn(`[glass] no shaped material: ${e.message}`);
  }
  return objc;
}

// The window's material view (Electron adds one with setVibrancy), or 0.
function materialView(o, view, depth = 0) {
  if (!view || depth > 6) return 0;
  if (Number(o.send1(view, o.sel('isKindOfClass:'), o.cls('NSVisualEffectView'))) & 0xff) return view;
  const subviews = o.send(view, o.sel('subviews'));
  const n = Number(o.send(subviews, o.sel('count')));
  for (let i = 0; i < n; i++) {
    const found = materialView(o, o.send1(subviews, o.sel('objectAtIndex:'), i), depth + 1);
    if (found) return found;
  }
  return 0;
}

// Shows the window's material only where `png` (a Buffer; the window's size
// is `width` × `height` points) is opaque. True if the mask was set.
export function setMaterialMask(win, png, width, height) {
  const o = load();
  if (!o) return false;
  try {
    const content = win.getNativeWindowHandle().readBigUInt64LE(0);
    const window = o.send(content, o.sel('window'));
    // The material sits beside the web contents, under the window's frame view.
    const view = materialView(o, o.send(o.send(window, o.sel('contentView')), o.sel('superview')));
    if (!view) return false;
    const data = o.sendBytes(o.cls('NSData'), o.sel('dataWithBytes:length:'), png, png.length);
    const image = o.send1(o.send(o.cls('NSImage'), o.sel('alloc')), o.sel('initWithData:'), data);
    if (!image) return false;
    o.sendSize(image, o.sel('setSize:'), { width, height });
    o.send1(view, o.sel('setMaskImage:'), image);
    o.send(image, o.sel('release'));
    o.send(window, o.sel('invalidateShadow'));
    return true;
  } catch (e) {
    console.warn(`[glass] mask failed: ${e.message}`);
    return false;
  }
}
