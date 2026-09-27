**Improved in 0.3.8:** the Classic balloon now looks like the Office Assistant's: a pale yellow balloon with a long, thin tail, a flat white field and a flat Send button.

**Improved in 0.3.7:** the speech balloons look more like the real thing. Classic is now the Office 97/2000 Assistant balloon, macOS matches a real macOS popover, Windows 98 uses its own system font, and System 7 text is a little larger. Text fields no longer light up while you type, and the Assistant Settings window keeps one size when you switch tabs.

**New in 0.3.6:** no Ollama? The pet still keeps you company. Click it for jokes, riddles, little games and predictions, in English or Chinese to match your Mac, and poke it a few times in a row to see what happens. A new Chat switch in Assistant Settings > Behavior turns Ollama on or off.

**Fixed in 0.3.5:** the pet no longer floats over full-screen videos and apps; it slides away with your desktop and comes back when you leave full screen.

**Fixed in 0.3.4:** quitting Deskling no longer shows a "JavaScript error in the main process" box that keeps coming back after you click OK.

**Improved in 0.3.3:** the pet no longer lists what it can and cannot do when you just greet it or ask for a joke, keeps small talk short in every response style, and the Friendly, Professional and Playful styles now sound clearly different.

**Fixed in 0.3.2:** switching characters while Claude Code works no longer makes the old and new characters flicker in turn, and switching several times in a row lands on your last pick.

**Fixed in 0.3.1:** after you click the pet, it goes back to working along with Claude Code as soon as you switch to another app (it used to wait until you closed its balloon). It also keeps only the latest Claude Code notices in its chat, so it no longer forgets your own conversation.

**New in 0.3.0: your pet works along with Claude Code.** Turn it on in **Assistant Settings → Behavior → Claude Code → Work along**. While a Claude Code session works, the pet works too. When Claude needs your OK or an answer, stops with an error, or finishes a longer task, the pet says so in its balloon; click the balloon to jump back to your terminal, or ask the pet what Claude did. The switch adds a few hooks to `~/.claude/settings.json` (backed up first); turn it off to remove them.

Custom characters can now say who they are (under their name in **Character**), so the pet introduces itself as that character instead of making something up.

Download **Deskling-…-arm64.dmg** (Apple silicon Macs), open it and drag Deskling to Applications.

Deskling isn't signed with an Apple Developer ID, so the first time you open it macOS says it can't verify the developer:

1. Click **Done** (not Move to Trash).
2. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to "Deskling was blocked".
3. Confirm with **Open Anyway** and your password.

If macOS says Deskling "is damaged", run this once in Terminal:

```
xattr -dr com.apple.quarantine /Applications/Deskling.app
```

Later versions install themselves: the pet tells you when one is out, and **Update to …** in its right-click menu does the rest.

Deskling needs [Ollama](https://ollama.com) with a local model, e.g. `ollama pull qwen2.5:1.5b`.
