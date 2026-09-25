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
