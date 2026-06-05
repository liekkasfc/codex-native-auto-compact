# Codex Native Auto Compact

A userscript that automatically compresses Codex conversations when context usage is high.

## Features

- **Automatic context compression**: Monitors context usage and automatically triggers compression when threshold is reached
- **Accurate context detection**: Uses React fiber graph search, fetch/WebSocket/postMessage interception to read exact context usage
- **Configurable**: Adjustable threshold, polling interval, and cooldown settings
- **Multiple conversation support**: Handles multiple conversations independently with cooldown per conversation
- **Dry run mode**: Test without actually compressing

## Installation

### Using Codex++

1. Install [Codex++](https://github.com/BigPizzaV3/CodexPlusPlus)
2. Download the script from this repository
3. Place the script in your Codex++ user scripts directory:
   - macOS: `~/.config/Codex++/user_scripts/`
   - Linux: `~/.config/Codex++/user_scripts/`
   - Windows: `%APPDATA%\\Codex++\\user_scripts\\`
4. Enable the script in Codex++ settings

### Manual Installation

1. Install a userscript manager like [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. Install the script from the raw file in this repository

## Configuration

Configuration is stored in `localStorage` under the key `codexNativeAutoCompactConfig`. You can set it via the browser console:

```javascript
localStorage.setItem('codexNativeAutoCompactConfig', JSON.stringify({
  thresholdUsedPercent: 82,    // Compress when usage exceeds this percentage
  contextWindowOverride: 73728, // Use llama-server -c / --ctx-size instead of Codex UI model_context_window
  pollIntervalMs: 5000,         // How often to check context usage (ms)
  cooldownMs: 600000,           // Cooldown between compressions per conversation (ms)
  menuOpenDelayMs: 650,         // Delay after opening context menu (ms)
  confirmDelayMs: 650,          // Delay after clicking compress (ms)
  dryRun: false,                // If true, don't actually compress (for testing)
  debug: false                  // If true, log debug information
}));
```

Set `contextWindowOverride` to `0` or `null` to trust the context window reported by Codex. For a local `llama-server -c 73728`, keep it at `73728`; this prevents Codex Desktop metadata such as `258400` from making the used percentage look too low.

## How It Works

1. **Context Detection**: The script uses multiple methods to detect context usage:
   - React fiber graph search to find context usage objects in the React component tree
   - Intercepts fetch requests to capture context usage data from API responses
   - Intercepts WebSocket messages for real-time context updates
   - Intercepts postMessage events for additional context data
   - Falls back to approximate detection by analyzing page text

2. **Compression Trigger**: When context usage exceeds the configured threshold:
   - First tries to find a direct "Compress this conversation" button
   - If not found, opens the context menu and finds the compress command there
   - Clicks the compress button and confirms the action

3. **Conversation Isolation**: Each conversation is tracked independently with its own cooldown period to prevent excessive compression attempts.

## API

The script exposes an API via `window.__codexNativeAutoCompact`:

```javascript
// Get current context usage
window.__codexNativeAutoCompact.readUsage();

// Start the auto-compact timer
window.__codexNativeAutoCompact.start();

// Stop the auto-compact timer
window.__codexNativeAutoCompact.destroy();

// Get current state
window.__codexNativeAutoCompact.getState();

// Get current configuration
window.__codexNativeAutoCompact.readConfig();
```

## License

MIT
