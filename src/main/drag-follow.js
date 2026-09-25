// Decides where the pet window goes while it is being dragged.
//
// macOS may refuse a position and move the window itself (e.g. Stage Manager
// pushes windows out of its strip on the left of the screen). Re-requesting a
// refused position every frame makes the pet visibly jitter against the OS, so
// refusals are learned as limits for the rest of the drag.

const RECENT = 12; // our own recent requests; their move echoes aren't refusals

export class DragFollower {
  constructor() {
    this.reset();
  }

  reset() {
    this.limit = { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
    this.recent = [];
    this.last = null;
  }

  // Returns the position to request for `target`, or null if nothing changes.
  next(target) {
    const { minX, maxX, minY, maxY } = this.limit;
    const x = Math.min(Math.max(target.x, minX), maxX);
    const y = Math.min(Math.max(target.y, minY), maxY);
    if (this.last && this.last.x === x && this.last.y === y) return null;
    this.last = { x, y };
    this.recent.push(this.last);
    if (this.recent.length > RECENT) this.recent.shift();
    return this.last;
  }

  // Called with the window's actual position whenever it moves.
  observe(actual) {
    if (!this.last) return;
    if (this.recent.some((p) => p.x === actual.x && p.y === actual.y)) return;
    // Not where we asked for: the OS moved it. Don't ask to go past it again.
    const want = this.last;
    if (actual.x > want.x) this.limit.minX = Math.max(this.limit.minX, actual.x);
    if (actual.x < want.x) this.limit.maxX = Math.min(this.limit.maxX, actual.x);
    if (actual.y > want.y) this.limit.minY = Math.max(this.limit.minY, actual.y);
    if (actual.y < want.y) this.limit.maxY = Math.min(this.limit.maxY, actual.y);
    this.last = { ...actual };
  }
}
