// Microsoft Agent exit semantics, shared by the player and the validator:
// while an animation is exiting, a frame's `exitBranch` is taken if it has one,
// otherwise it plays on in sequence (no random branching), and the last frame
// ends the animation.
export function exitNext(frames, i) {
  if (i === frames.length - 1) return frames.length;
  return frames[i].exitBranch ?? i + 1;
}
