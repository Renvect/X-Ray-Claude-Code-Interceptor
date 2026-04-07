# X-Ray Claude Code Interceptor

X-Ray Claude Code Interceptor is an advanced tooling and diagnostic proxy designed to seamlessly intercept, analyze, and optimize traffic between [Claude Code](https://github.com/anthropics/claude-code) and the Anthropic API. 

## 🎯 Purpose

This tool was specifically built to figure out **what is causing spikes in token usage and burning up limits**. By standing between the Claude CLI and the Anthropic endpoints, it provides full transparency into the payloads being shuttled back and forth. 

It accomplishes token limits optimization by providing:
- **Token Usage Forensics**: Detailed turn-by-turn breakdowns of token expenditures.
- **Smart Stripping**: Heuristics that dynamically strip huge payloads (e.g., outdated tool results, deep bash outputs, read commands) when they are no longer necessary for the current context.
- **System Prompt Analysis**: Deep-level tracking of changes to Claude's system prompts.

## 🚀 How to Run and Deploy

### Recommended Deployment (using `start.bat`)

Always use the included `start.bat` script. It handles port management, proxy startup, and environment configuration automatically.

```powershell
cd "path/to/X-Ray-Claude-Code-Interceptor"
.\start.bat
```

**What `start.bat` does under the hood:**
1. Kills any hung services previously occupying port `3579`.
2. Starts the interception server (`proxy.js`) in a minimized background window.
3. Sets up the current terminal session with `$env:ANTHROPIC_BASE_URL="http://127.0.0.1:3579"`
4. Launches Claude via the local `claude-monitor.js` wrapper, ensuring payload interception is fully hooked.
5. Provide you with access to the real-time **X-RAY Dashboard** at `http://localhost:3579`.

---

### ⚠️ Manual Run Warnings 

If you try to manually point Claude to the proxy without starting the proxy server first, you **will encounter errors**. 

For example, attempting to run this standalone payload:
```powershell
$env:ANTHROPIC_BASE_URL="http://localhost:3579"; node "C:/nvm4w/nodejs/node_modules/@anthropic-ai/claude-code/cli.js"
```
WILL FAIL and throw a connection refused error if `start.bat` (and effectively `proxy.js`) has not been initiated beforehand. Always launch with the batch script to guarantee the background service is actively listening.

## 📁 System Core Files

- `start.bat` - The entry point to correctly launch the proxy and initialize the customized CLI environment. 
- `proxy.js` - The backend interception engine. It receives Anthropic API calls, performs payload analysis (and optional smart stripping), logs them via `.jsonl`, and broadcasts metrics to the dashboard via Server-Sent Events (SSE).
- `claude-monitor.js` - A wrapper launcher around the actual Claude executable to guarantee environment setup and Node module preload configurations are locked in.
- `dashboard.html` - The frontend interface connecting to the proxy on port `3579` to visualize real-time tokens, spikes, payload contents, and system instructions.

## 📊 Sample Logs

**Where are active logs stored?**
The proxy natively records live active sessions as `.jsonl` (JSON Lines) tracking files (`manifest.jsonl`, `session.jsonl`, `wagon.jsonl`, etc.). These files are generated and stored directly in the main root folder, `X-Ray-Claude-Code-Interceptor`. 

The included `Logs/` directory contains standard `.json` format exports from recent live testing sessions (such as today's). These logs represent the direct output of the proxy's real-time analysis detailing exactly how the system prompt shifts, where heavy tool payloads execute, and what inflates the context window.

**How to view logs in the dashboard:**
The live X-RAY dashboard (`http://localhost:3579`) automatically reads from the active `.jsonl` files.
If you have exterior or exported logs (like the sample ones provided in the `Logs/` directory), simply drop them into the **root project directory**. The system scripts will automatically detect, restore, and load them so they become immediately viewable in your dashboard!

## 🤝 Open Source & Contributing

We believe that debugging these black-box AI tools benefits the entire developer community! 

This repository is completely open-source. **Anyone is free to use it, develop upon it, and contribute back.** If you find a new bug, come up with better stripping heuristics, or want to enhance the dashboard—pull requests and forks are highly encouraged!
