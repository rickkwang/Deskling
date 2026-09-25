# Deskling

*A little creature that lives on your desktop.*

A lightweight desktop pet that is also an AI assistant. It uses Microsoft Agent characters (Clippy by default) and a model already installed in your local Ollama.

```
npm install
npm start                      # the pet (tray 📎: show/hide/quit; right-click the pet for the menu)
npm run selftest               # end-to-end: idle → click → listening → thinking → speaking → idle
npm test                       # runtime semantics (exit branches, queue, idle levels)
npm run validate               # validate every characters/*/character.json
npm run preview -- --preview=clippy   # QA: play every animation with its state tags
npx electron . --audit                # QA: every character — sprite cells non-empty, every animation ends visible,
                                      #     state/idle animations start and settle on the rest pose
npx electron . --selftest --quiet --character=merlin   # end-to-end flow for one character (screenshots in qa/<id>/)
npx electron . --selftest --quiet --balloon=win98      # same, with one balloon theme
```

## Menus and settings

- Right-click or long-press the pet: **Speech** (read replies aloud), **Character ▸**, **New Conversation**, **Assistant Settings…**, **Quit Assistant**.
- **Assistant Settings** has two tabs:
  - **Character**: the Desktop Assistant on/off switch, the character grid, Size, and the speech Balloon style (Classic, Aqua, macOS, Windows 98, System 7).
  - **Behavior**: Greeting, Speech, Response Style (Concise, Normal, Chatty, Detailed, Friendly, Professional, Playful), local Model, and free-form Instructions (up to 500 characters).
- Settings are saved to `~/Library/Application Support/Deskling/settings.json`.
- `electron . --settings-preview=character|behavior` captures the settings window to `qa/` for QA.

## Layout

```
characters/<id>/character.json + spritesheet.png   data-only Character packages
src/character/   schema validation (shared by the tools and the renderer)
src/runtime/     AnimationPlayer (frames, branching, exit branches) + CharacterRuntime (queue, states, idle levels)
src/ai/          Ollama provider (local models only, never pulls) + Assistant (persona, history)
src/main/        Electron shell: transparent pet + balloon windows, drag, menus, tray, settings
src/renderer/    pet, speech balloon, settings UI; selftest, preview, audit
tools/           clippy.js → Character importer, validator
```

To add a custom character, put `character.json` + a spritesheet in
`~/Library/Application Support/Deskling/characters/<id>/` and run `npm run validate -- <dir>`.
The character must map the states `idle listening thinking speaking confused acknowledge getAttention explain show hide`
(each tagged `official` or `app-mapped`) and have a `persona` with a `systemPrompt` and a list of `greetings`
(one is picked at random whenever the character says hello).

## Characters and credits

Bundled: Clippy, Links, Rover, Merlin, Genie, Peedy, Genius, Rocky, F1 (frame tables from
[clippy.js](https://github.com/clippyjs/clippy.js), MIT) and Office Logo (from [ryOS](https://github.com/ryokun6/ryos)),
converted with `npm run import:clippyjs -- <agents dir>`. The character art is Microsoft's and is included
for local, non-commercial use only; each `character.json` records its `provenance`.

The speech balloon themes follow Apple's and Microsoft's own guidelines and system colours; their sources, and the
bundled Geneva 9 / Chicago 12 bitmap fonts (by Giles Booth, CC BY) and Windows 98 scroll-bar art (98.css, MIT), are
listed in [`src/renderer/balloon-themes/CREDITS.md`](src/renderer/balloon-themes/CREDITS.md).
