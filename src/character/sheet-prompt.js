// The image-model prompt for a Deskling sprite sheet (copied from Settings >
// Character). Its cell order is the one sheet-import.js reads; its rules follow
// how the importer lines poses up (by the feet) and how the frame tables play
// them (every action leaves cell 1 and returns to it).

export const SHEET_PROMPT = `Generate ONE single image now: a complete sprite sheet for an original desktop-pet mascot.

Character: [describe your character — if this is left as is, invent a charming original mascot]
Style: [e.g. clean 2D cartoon — if left as is, pick a fitting style]

DESIGN
- Compact, chunky full-body character that stays readable when shown about 90 px tall: large head, big expressive eyes, short limbs.
- Bold, even dark outline around the whole character; big simple shapes and flat colours. No fine texture, gradients, glow or shadows.
- No thin, floating or detached parts.
- The character must not contain the background colour or anything close to it.

LAYOUT — very important
- Landscape 3:2 image, an invisible grid of exactly 8 columns x 5 rows = 40 cells.
- Exactly one full-body pose per cell, centered in its cell, with clear empty space around it. Nothing crosses into a neighbouring cell, nothing is cropped.
- The character is identical in every cell: same face, proportions, colours, outline and style. Only pose and expression change.
- Same size as cell 1 in every cell (except the appearing / disappearing cells).
- Same facing direction as cell 1 in every cell.
- In every standing cell the feet stay planted exactly where they are in cell 1; only the upper body, arms and face move.
- Within each group of four cells, poses change gradually: the first cell of a group is only a small step away from cell 1.
- No motion lines, action marks, sweat drops or any detached strokes: every cell is one single connected character.

CELLS, left to right, row by row
Row 1:
 1 neutral relaxed standing pose, arms at sides, friendly, looking at the viewer
 2 same, eyes half closed (blink)
 3 same, eyes fully closed (blink)
 4 same, body very slightly raised, chest out (breathing in)
 5 thinking: one hand raised to the chin
 6 thinking: hand on chin, eyes looking up-left
 7 thinking: hand on chin, eyes looking up-right
 8 thinking: tapping the chin, eyebrows raised
Row 2:
 9 listening: perks up, eyes wide
10 listening: upper body leans slightly toward the viewer, head tilted
11 listening: head tilted, one hand cupped near the ear
12 listening: attentive smile, both hands together
13 talking: mouth open, one hand palm-up to the side
14 talking: mouth closed, hand still out
15 talking: mouth wide open, both hands gesturing outward
16 talking: mouth half open, index finger raised, making a point
Row 3:
17 confused: head tilted, brows knitted
18 confused: hand raised to the head
19 confused: scratching the head, mouth pulled to one side
20 confused: small shrug, hand still on head
21 agreeing: head nodding down, eyes closed in a smile
22 agreeing: head up, big smile
23 agreeing: thumbs-up, big smile
24 agreeing: both arms raised happily
Row 4:
25 waving: one arm raised high
26 waving: hand waving to the left, excited face
27 waving: hand waving to the right
28 waving: small hop off the ground, still waving (the only cell where the feet leave the ground)
29 sleepy: eyelids drooping
30 sleepy: eyes closed, head nodding forward
31 asleep: still standing in the same spot, head drooped, eyes closed
32 asleep: same as 31, body slightly lower (breathing out)
Row 5:
33 appearing: tiny squashed version on the ground line
34 appearing: half size, stretching upward
35 appearing: slightly taller than normal (overshoot)
36 appearing: slightly squashed, almost normal
37 disappearing: slightly squashed, eyes closed
38 disappearing: half size, shrinking toward the ground line
39 disappearing: small
40 disappearing: tiny dot on the ground line

BACKGROUND: one solid flat #FF00FF colour across the whole image, perfectly uniform (use #00FF00 instead if the character is pink or purple).
Do NOT draw grid lines, cell borders, labels, numbers, text, arrows, shadows, floor, motion lines, sparkles, speech or thought bubbles, or Z letters.

Before finishing, check: exactly 40 poses in 8 columns x 5 rows; same size, same facing and same feet position as cell 1; no text, lines or detached marks; a flat background.
`;
