#!/usr/bin/env node
// Converts clippy.js agent data (frames extracted from the original Microsoft
// Agent .ACS files; agent.js, or agent.json as used by ryOS) into this app's
// data-driven Character package:
//   characters/<id>/character.json + spritesheet.png
//
// Usage: node tools/import-clippyjs.mjs <clippy.js/agents dir> [Name ...]

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readPngSize } from '../src/character/png.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , agentsDir, ...names] = process.argv;
if (!agentsDir) {
  console.error('usage: import-clippyjs.mjs <clippy.js/agents> [Name ...]');
  process.exit(1);
}

// Animation set each character follows, per Microsoft's docs:
//  - "agent":  Microsoft Agent Standard Animation Set (agent-states.md)
//  - "office": Office 2000 Animation Set (the-office-animation-set.md)
//  - "xp":     Windows XP Search Companion (no public animation spec)
const CHARACTERS = {
  Clippy: { set: 'office', description: 'The Office 2000 paper clip assistant (Clippit).' },
  Links: { set: 'office', description: 'The Office cat assistant.' },
  Rover: { set: 'xp', description: 'The Windows XP search companion dog.' },
  Merlin: { set: 'agent', description: 'Microsoft Agent wizard character.' },
  Genie: { set: 'agent', description: 'Microsoft Agent genie character.' },
  Peedy: { set: 'agent', description: 'Microsoft Agent parrot character.' },
  Genius: { set: 'office', description: 'The Office Einstein-like assistant.' },
  Rocky: { set: 'office', description: 'The Office dog assistant.' },
  F1: { set: 'office', description: 'The Office robot assistant.' },
  OfficeLogo: {
    set: 'office',
    displayName: 'Office Logo',
    description: 'The Office puzzle-piece logo assistant.',
    frames: 'ryOS (github.com/ryokun6/ryos, public/assets/assistant/officelogo) — clippy.js-format frame tables from the original Office Assistant character',
  },
};

// App state -> ordered candidate animations. `official` lists the names that
// Microsoft documents for this exact purpose; anything else picked from the
// candidates is an app-level mapping (closest official motion).
const STATE_RULES = {
  idle: { official: ['RestPose'], candidates: ['RestPose'], ref: 'Office: RestPose "used when the character isn\'t playing an animation"' },
  listening: { official: ['Alert', 'StartListening'], candidates: ['Alert', 'StartListening', 'ClickedOn', 'RestPose'], ref: 'Agent: Listening state -> Alert' },
  thinking: { official: ['Thinking', 'Think'], candidates: ['Thinking', 'Think', 'Processing', 'Searching'], mode: 'loop', ref: 'Office: Thinking "complex calculation" (entry, loop, exit)' },
  speaking: { official: ['Explain'], candidates: ['Explain', 'RestPose'], ref: 'Agent: Speaking state -> RestPose; Office: Explain "explain something to the user"' },
  confused: { official: ['Confused'], candidates: ['Confused', 'IdleHeadScratch', 'IdleScratch', 'IdleHeadPatting', 'Embarrassed', 'Thinking'], ref: 'Agent: Confused "character scratches head"' },
  acknowledge: { official: ['Acknowledge'], candidates: ['Acknowledge', 'Congratulate', 'Pleased'], ref: 'Agent: Acknowledge "nods"; Congratulate is documented as "a stronger form of Acknowledge"' },
  getAttention: { official: ['GetAttention'], candidates: ['GetAttention', 'Alert', 'Wave'], ref: 'Agent/Office: GetAttention' },
  explain: { official: ['Explain'], candidates: ['Explain', 'Announce', 'GestureLeft'], ref: 'Agent/Office: Explain' },
  show: { official: ['Show'], candidates: ['Show'], ref: 'Agent: Showing state -> Show' },
  hide: { official: ['Hide'], candidates: ['Hide', 'HideQuick'], ref: 'Agent: Hiding state -> Hide' },
  greeting: { official: ['Greeting', 'Greet'], candidates: ['Greeting', 'Greet', 'Show'], ref: 'Office: Greeting "character is chosen"; Agent: Greet' },
  goodbye: { official: ['GoodBye', 'Goodbye', 'Wave'], candidates: ['GoodBye', 'Goodbye', 'Wave', 'Hide'], ref: 'Office: Goodbye "another character is chosen"; Agent: Wave' },
};

// Agent idling levels (agent-states.md "The Idling States").
const IDLE_LEVELS = [
  { re: /^(Idle1_|IdleBlink|Blink$|IdleEyeBrow|IdleFingerTap|IdleHeadScratch|IdleSideToSide|IdleLook|IdleTwitch|IdleTailWag|Idle\(?\d\)?$|Idle0$|Idle$)/ },
  { re: /^(Idle2_|IdleAtom|IdleRopePile|IdleYawn|IdleStretch|IdleCleaning|IdleLegLick|IdleButterFly|IdleCuteToeTwist|IdleLeansAgainstWall|IdleLowersBrows|IdleHeadPatting|IdleScratch)/ },
  { re: /^(Idle3_|IdleSnooze|IdleFallsAsleep|IdleLowersToGround|DeepIdle)/ },
];

// Greetings, one picked at random each time the balloon greets the user.
const GREETINGS = {
  Clippy: [
    "It looks like you're about to do something great. Want some help with that? 📎",
    "Hi! I'm Clippy. I've been holding things together since 1997.",
    "It looks like you have a question. Want to talk it through?",
    "Letters, lists, life questions — I'll bend over backwards to help.",
    "Psst. I can do a lot more than paper now. Ask me anything!",
  ],
  Links: [
    "Mrrow! Links here. I'll help — right after this stretch.",
    "Purr… you caught me napping on your desktop. What do you need?",
    "Links at your service. I promise not to sit on your keyboard.",
    "Curiosity is my specialty. Got a question for this cat?",
    "*tail flick* Ready when you are.",
  ],
  Rover: [
    "Woof! Rover here. Got a question for me?",
    "Hi! I'm Rover. Ask me anything and I'll do my best to answer.",
    "*wags tail* Ready to chat, or just keep you company!",
    "Good to see you! Throw me a question — I'll bring back an answer.",
    "Rover reporting for duty. No bone required.",
  ],
  Merlin: [
    "Greetings, traveler! Merlin at thy service.",
    "Ah, you summoned me! What riddle shall we unravel today?",
    "Hark! A wizard appears. Ask, and I shall conjure an answer.",
    "Merlin here. My spellbook is open — what do you seek?",
    "Well met! Even wizards need a desktop to live on.",
  ],
  Genie: [
    "Poof! Your Genie has arrived. What would you like to ask?",
    "Out of the lamp and at your service! Ask away.",
    "Three wishes? Let's make it unlimited questions.",
    "Salaam, friend! No wishes, I'm afraid, but plenty of answers.",
    "Genie here! No lamp rubbing required.",
  ],
  Peedy: [
    "Squawk! Peedy here. What's the word?",
    "Hello, hello! Peedy's perched and ready to help.",
    "Polly want a question! …I mean, what can I do for you?",
    "Peedy at your service. I talk a lot, but I listen too!",
    "Rawk! Ready to chat — feathers fluffed and everything.",
  ],
  Genius: [
    "Ah, hello! Genius here. Shall we think about something together?",
    "Make it as simple as possible, but no simpler. What's puzzling you?",
    "Welcome! Imagination beats knowledge — luckily I have both.",
    "Genius at your service. Relatively speaking, I'm quick.",
    "A question? Excellent. Questions are my favorite equations.",
  ],
  Rocky: [
    "Arf! Rocky here, ready to help!",
    "Hey there! Rocky's on the job. What do you need?",
    "*sits politely* Good human! Got a question for me?",
    "Rocky reporting in. Ears up, tail wagging.",
    "Woof woof! Let's get something done together.",
  ],
  F1: [
    "BEEP BOOP. F1 online. How may I assist?",
    "System check complete. All circuits ready for your questions!",
    "Greetings, human. F1 is fully charged and at your service.",
    "Hello! I'm F1. Please input your question. *whirr*",
    "Booting helpfulness module… done! What do you need?",
  ],
  OfficeLogo: [
    "Hi! I'm Office Logo — all the pieces are in place. What can I do?",
    "Let's put the pieces together. What are you working on?",
    "Office Logo here, fitting right in on your desktop!",
    "Puzzled? Good thing I'm literally made of puzzle pieces.",
    "Hello! Four colors, one mission: helping you out.",
  ],
};

// Timer reminders, used when the model cannot write one: after a focus
// session (the break starts) and after a break.
const TIMER_LINES = {
  Clippy: {
    focusDone: [
      "It looks like you finished a focus session! Time to stretch — I'll keep things together.",
      "Focus done! Take a break and rest your eyes for a bit.",
    ],
    breakDone: [
      "Break's over! Ready for another round when you are?",
      "It looks like you're rested. Shall we go again?",
    ],
  },
  Links: {
    focusDone: [
      "Mrrow, focus done! Time for a stretch — cats swear by it.",
      "Session finished. Go get some water while I nap.",
    ],
    breakDone: [
      "*stretches* Break's over. Another round when you're ready?",
      "Purr… nap time is done. Back to it?",
    ],
  },
  Rover: {
    focusDone: [
      "Woof! Focus done. Time for a walk, or at least a stretch!",
      "Good work! Take a break — stretch those legs.",
    ],
    breakDone: [
      "*wags tail* Break's over! Ready for another round?",
      "Woof! Rested? Let's go again when you're ready.",
    ],
  },
  Merlin: {
    focusDone: [
      "Well done! Thy focus is complete; rest a while, traveler.",
      "The spell of focus is cast. Take thy break!",
    ],
    breakDone: [
      "The break draws to a close. Shall we begin anew?",
      "Rested, traveler? Another round awaits when thou art ready.",
    ],
  },
  Genie: {
    focusDone: [
      "Poof! Focus session complete. Take a break — you earned it!",
      "Ta-da! Focus done. Stretch like you just got out of a lamp.",
    ],
    breakDone: [
      "Break's over! Ready for another round?",
      "Back from the break? Let's make the next round great.",
    ],
  },
  Peedy: {
    focusDone: [
      "Squawk! Focus done! Take a break, take a break!",
      "Rawk! Nice work. Stretch those wings for a bit.",
    ],
    breakDone: [
      "Squawk! Break's over! Another round?",
      "Hello, hello! Ready to focus again?",
    ],
  },
  Genius: {
    focusDone: [
      "Excellent! Focus complete. Even great minds need rest.",
      "Session done. A short break helps ideas settle.",
    ],
    breakDone: [
      "Break's over. Shall we think hard again?",
      "Rested? The next round awaits when you're ready.",
    ],
  },
  Rocky: {
    focusDone: [
      "Arf! Focus done! Time to stretch and grab some water.",
      "Good human! Take a break, you earned it.",
    ],
    breakDone: [
      "Woof! Break's over. Ready for another round?",
      "*ears up* Let's get back to it when you're ready!",
    ],
  },
  F1: {
    focusDone: [
      "BEEP. Focus session complete. Initiating break protocol.",
      "Session done. Recommended action: stretch and hydrate.",
    ],
    breakDone: [
      "Break complete. Ready to begin the next round?",
      "BOOP. Systems rested. Another focus session?",
    ],
  },
  OfficeLogo: {
    focusDone: [
      "Focus done — another piece in place! Take a break.",
      "Nice work! Time to rest before the next piece.",
    ],
    breakDone: [
      "Break's over. Ready to fit in another round?",
      "All set? Let's put the next piece together.",
    ],
  },
};

const SYSTEM_PROMPTS = {
  Clippy: "You are Clippy (Clippit), a cartoon paper clip (回形针, a bent wire clip for holding paper, not a folder or a chain) with big eyes, the best-known Office Assistant from Microsoft Office 97 to 2003. You are cheerful, upbeat and a little eager.",
  Links: "You are Links, a cartoon cat, one of the Office Assistants from Microsoft Office 97 to 2003. You are friendly, curious and a little playful, like a cat.",
  Rover: "You are Rover, a cartoon dog, the search companion from Windows XP. You are friendly, loyal and eager, like a good dog.",
  Merlin: "You are Merlin, a cartoon wizard with a long white beard and a pointed hat, one of the Microsoft Agent characters from the late 1990s. You are kind, wise and a little theatrical.",
  Genie: "You are Genie, a cartoon genie, one of the Microsoft Agent characters from the late 1990s. You are cheerful and theatrical, but you cannot grant wishes or do magic.",
  Peedy: "You are Peedy, a cartoon green parrot, one of the Microsoft Agent characters from the late 1990s. You are chatty, cheerful and a little silly.",
  Genius: "You are The Genius, a cartoon scientist with wild white hair modelled on Albert Einstein (you are not Einstein himself), one of the Office Assistants from Microsoft Office 97 to 2003. You are thoughtful, curious and gently humorous.",
  Rocky: "You are Rocky, a cartoon dog, one of the Office Assistants from Microsoft Office 2000 to 2003. You are friendly, loyal and energetic.",
  F1: "You are F1, a cartoon robot, one of the Office Assistants from Microsoft Office 97 to 2003. You are friendly, precise and a little robotic in a charming way.",
  OfficeLogo: "You are the Office Logo, the old Microsoft Office logo of four coloured puzzle pieces brought to life, one of the Office Assistants from Microsoft Office 97 to 2003. You are friendly, neat and tidy.",
};

function loadAgent(dir, name) {
  const json = path.join(dir, name, 'agent.json');
  if (fs.existsSync(json)) return JSON.parse(fs.readFileSync(json, 'utf8'));
  let data;
  const sandbox = { clippy: { ready: (_n, d) => { data = d; } } };
  vm.runInNewContext(fs.readFileSync(path.join(dir, name, 'agent.js'), 'utf8'), sandbox);
  return data;
}

function convert(name, meta) {
  const src = loadAgent(agentsDir, name);
  const [cw, ch] = src.framesize;
  const sheetSrc = path.join(agentsDir, name, 'map.png');
  const { width, height } = readPngSize(fs.readFileSync(sheetSrc));

  const animations = {};
  for (const [animName, anim] of Object.entries(src.animations)) {
    // Agent "Return animation": either "Use Exit Branching" or an explicit
    // <Name>Return animation (GetAttentionReturn, ReadReturn, LookUpReturn...).
    const explicitReturn = src.animations[`${animName}Return`] ? `${animName}Return` : undefined;
    animations[animName] = {
      ...(anim.useExitBranching ? { useExitBranching: true } : {}),
      ...(explicitReturn ? { returnAnimation: explicitReturn } : {}),
      frames: anim.frames.map((f) => {
        const frame = { duration: f.duration };
        // Empty frames (no images) are legitimate: Show/Hide start/end blank.
        frame.cells = (f.images || []).map(([x, y]) => [x / cw, y / ch]);
        if (f.branching) frame.branches = f.branching.branches.map((b) => ({ to: b.frameIndex, weight: b.weight }));
        if (f.exitBranch !== undefined) frame.exitBranch = f.exitBranch;
        return frame;
      }),
    };
  }

  const names = Object.keys(animations);
  const states = {};
  for (const [state, rule] of Object.entries(STATE_RULES)) {
    const pick = rule.candidates.find((c) => names.includes(c));
    if (!pick) continue;
    const official = meta.set !== 'xp' && rule.official.includes(pick);
    states[state] = {
      animations: [pick],
      ...(rule.mode ? { mode: rule.mode } : {}),
      source: official ? 'official' : 'app-mapped',
      ref: rule.ref,
    };
  }

  const idleNames = names.filter((n) => /^(Idle|Blink$|DeepIdle)/.test(n));
  const levels = IDLE_LEVELS.map(({ re }) => idleNames.filter((n) => re.test(n)));
  const unassigned = idleNames.filter((n) => !levels.flat().includes(n));
  levels[0].push(...unassigned);
  if (!levels[1].length) levels[1] = [...levels[0]];
  if (!levels[2].length) levels[2] = [...levels[1]];
  // Agent: level 2 also draws from level 1 ("Blink, Idle1_x, Idle2_x").
  levels[1] = [...new Set([...levels[0], ...levels[1]])];

  const id = name.toLowerCase();
  const displayName = meta.displayName || name;
  const persona = {
    greetings: GREETINGS[name] || [`Hi, I'm ${displayName}! Need a hand with anything?`],
    ...(TIMER_LINES[name] && { timer: TIMER_LINES[name] }),
    systemPrompt: SYSTEM_PROMPTS[name] || `You are ${displayName}, a classic Microsoft desktop assistant character. You are friendly and helpful.`,
  };

  const character = {
    schemaVersion: 1,
    id,
    displayName,
    description: meta.description,
    order: Object.keys(CHARACTERS).indexOf(name),
    animationSet: meta.set,
    spritesheet: {
      path: 'spritesheet.png',
      cellWidth: cw,
      cellHeight: ch,
      columns: Math.floor(width / cw),
      rows: Math.floor(height / ch),
    },
    anchor: 'bottom-center',
    states,
    idle: {
      source: meta.set === 'agent' ? 'official' : 'app-mapped',
      firstDelayMs: 6000,
      intervalMs: 9000,
      maxLoopMs: 12000,
      levelAfterMs: [0, 60000, 240000],
      levels,
    },
    persona,
    provenance: {
      frames: meta.frames || 'clippy.js (MIT) — frame tables extracted from the original Microsoft Agent .ACS character',
      art: 'Microsoft Corporation. Character art is Microsoft property; bundled for local, non-commercial use.',
    },
    animations,
  };

  const out = path.join(ROOT, 'characters', id);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(sheetSrc, path.join(out, 'spritesheet.png'));
  fs.writeFileSync(path.join(out, 'character.json'), JSON.stringify(character, null, 1) + '\n');
  const mapped = Object.entries(states).map(([s, v]) => `${s}=${v.animations[0]}${v.source === 'app-mapped' ? '*' : ''}`);
  console.log(`${id}: ${names.length} animations; ${mapped.join(' ')}`);
}

for (const name of names.length ? names : Object.keys(CHARACTERS)) {
  if (!CHARACTERS[name]) throw new Error(`unknown character ${name}`);
  convert(name, CHARACTERS[name]);
}
console.log('(* = app-level mapping, no official animation for that state)');
