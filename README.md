# Deskling

*A little creature that lives on your desktop.*

A lightweight desktop pet that is also an AI assistant. It uses Microsoft Agent characters (Clippy by default) and a model already installed in your local Ollama.

## Install

Download the latest `.dmg` from [Releases](https://github.com/rickkwang/Deskling/releases) (Apple silicon Macs),
open it and drag Deskling to Applications. You also need [Ollama](https://ollama.com) with a model, e.g.
`ollama pull qwen2.5:1.5b`.

Deskling isn't signed with an Apple Developer ID, so macOS blocks the first launch: click **Done**, then
**System Settings → Privacy & Security → Open Anyway**. If macOS says the app "is damaged", run
`xattr -dr com.apple.quarantine /Applications/Deskling.app` once. After that it updates itself: the pet tells you
when a new version is out, and **Update to …** in its right-click menu installs it and restarts.

## Develop

```
npm install
npm start                      # the pet (tray 📎: show/hide/quit; right-click the pet for the menu)
npm run selftest               # end-to-end: idle → click → listening → thinking → speaking → idle
npm test                       # runtime semantics (exit branches, queue, idle levels)
npm run validate               # validate every characters/*/character.json
npm run dist                   # release/: Deskling-<version>-arm64.dmg + .zip + latest-mac.yml (ad-hoc signed)
npm run preview -- --preview=clippy   # QA: play every animation with its state tags
npx electron . --audit                # QA: every character — sprite cells non-empty, every animation ends visible,
                                      #     state/idle animations start and settle on the rest pose
npx electron . --selftest --quiet --character=merlin   # end-to-end flow for one character (screenshots in qa/<id>/)
npx electron . --selftest --quiet --balloon=win98      # same, with one balloon theme
npx electron . --selftest --edge --hold=60000 --timer-demo=60   # QA: start the focus timer at once, 60x fast
```

## Menus and settings

- Right-click or long-press the pet: **Speech** (read replies aloud), **Character ▸**, **Focus Timer ▸**, **New Conversation**, **Assistant Settings…**, **About Deskling** (version), **Check for Updates…** (or **Update to …** once one is out), **Quit Assistant**. The tray menu has **Focus Timer ▸**, About and the update item too.
- **Focus Timer** (Pomodoro): a focus session, then a break that starts on its own; after the break it waits for you to start the next round. A pill above the pet's head counts down in the balloon style (click it to pause, resume or start the next round). When a phase ends it plays the chosen sound and the character says a line written by the model, or a preset one from its `persona.timer` when the model is unavailable; with the pet hidden, a system notification does instead.
- **Assistant Settings** has two tabs:
  - **Character**: the Desktop Assistant on/off switch, the character grid, Size, and the speech Balloon style (Classic, Aqua, macOS, Windows 98, System 7).
    **Add…** at the end of the grid makes a character from a generated sprite sheet (**copy the prompt** gives the image-model prompt): pick the image, name it, and it is added and selected. A custom character can be renamed (click its name) or deleted.
  - **Behavior**: Greeting, Speech, Response Style (Concise, Normal, Chatty, Detailed, Friendly, Professional, Playful), local Model, the Focus timer (focus and break length in hours, minutes and seconds; the end Sound), and free-form Instructions (up to 500 characters).
- Settings are saved to `~/Library/Application Support/Deskling/settings.json`.
- `electron . --settings-preview=character|behavior` captures the settings window to `qa/` for QA.

## Releasing

Bump `version` in `package.json`, commit, then `git tag v<version> && git push origin main v<version>`.
`.github/workflows/release.yml` runs the tests, builds the ad-hoc signed app and publishes the release with
`.github/release-notes.md`. Installed copies find it through `latest-mac.yml` (`src/main/updater.js`): they download
the zip, check its SHA-512, and swap the app in place, which avoids Squirrel.Mac's need for a Developer ID.

## Layout

```
characters/<id>/character.json + spritesheet.png   data-only Character packages
src/character/   schema validation (shared by the tools and the renderer)
src/runtime/     AnimationPlayer (frames, branching, exit branches) + CharacterRuntime (queue, states, idle levels)
src/ai/          Ollama provider (local models only, never pulls) + Assistant (persona, history)
src/main/        Electron shell: transparent pet + balloon windows, drag, menus, tray, settings
src/renderer/    pet, speech balloon, settings UI; selftest, preview, audit
tools/           clippy.js and generated-sheet → Character importers, validator
```

To add a custom character, put `character.json` + a spritesheet in
`~/Library/Application Support/Deskling/characters/<id>/` and run `npm run validate -- <dir>`.
The character must map the states `idle listening thinking speaking confused acknowledge getAttention explain show hide`
(each tagged `official` or `app-mapped`) and have a `persona` with a `systemPrompt` and a list of `greetings`
(one is picked at random whenever the character says hello). Optionally, `persona.timer.focusDone` and
`persona.timer.breakDone` list the lines it says when a focus session or a break ends and the model cannot write one.
With `"animationSet": "office"` the character enters with its `greeting` and leaves with its `goodbye` (as the Office
assistants do); otherwise it enters with `show`, then `greeting` to say hello, and leaves with `hide`.

A character can also be made from one generated image: an 8 × 5 grid of poses on a flat `#FF00FF` (or `#00FF00`)
background, in the order listed at the top of `src/character/sheet-import.js`. Then run
`npm run import:sheet -- <image> --name "My Pet"`. It keys out the background, drops stray marks, stands every pose
on the same ground line, scales it to Clippy's height (`--height` to change) and writes the frame tables, timed like
the Agent characters, to the user characters folder.

## Characters and credits

Bundled: Clippy, Links, Rover, Merlin, Genie, Peedy, Genius, Rocky, F1 (frame tables from
[clippy.js](https://github.com/clippyjs/clippy.js), MIT) and Office Logo (from [ryOS](https://github.com/ryokun6/ryos)),
converted with `npm run import:clippyjs -- <agents dir>`. The character art is Microsoft's and is included
for local, non-commercial use only; each `character.json` records its `provenance`.

The speech balloon themes follow Apple's and Microsoft's own guidelines and system colours; their sources, and the
bundled Geneva 9 / Chicago 12 bitmap fonts (by Giles Booth, CC BY) and Windows 98 scroll-bar art (98.css, MIT), are
listed in [`src/renderer/balloon-themes/CREDITS.md`](src/renderer/balloon-themes/CREDITS.md).

The focus timer sounds (classic Mac OS, Mail and MSN Messenger sounds, taken from ryOS) are listed in
[`src/renderer/sounds/CREDITS.md`](src/renderer/sounds/CREDITS.md).
