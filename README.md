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
  thresholdUsedPercent: 68,    // Compress early enough to leave room for the compact request
  contextWindowOverride: null,  // Trust Codex/provider metadata unless an override is needed
  forceContextWindowOverride: false, // If true, apply contextWindowOverride even when provider is unknown
  unknownContextWindowFallback: null, // Use only when provider/model/baseUrl are unavailable
  modelContextWindowOverrides: {}, // Optional model-name or /regex/ overrides
  providerContextWindowOverrides: {
    "llama.cpp": 73728,
    "localhost:8888": 73728
  },
  autoDiscoverContextWindow: true, // Try provider endpoints like /props and /v1/models
  contextWindowDiscoveryTimeoutMs: 1500,
  contextWindowDiscoveryTtlMs: 600000,
  minRemainingTokensBeforeCompact: 20000, // Also compact when remaining tokens fall below this buffer
  minRemainingTokensToAttemptCompact: 12000, // Stop retrying if too little room remains for the compact request itself
  pollIntervalMs: 5000,         // How often to check context usage (ms)
  busyRetryMs: 1000,            // Retry quickly when compact is pending but Codex is busy
  idleObserverDebounceMs: 150,  // Debounce DOM idle detection before retrying pending compact
  cooldownMs: 120000,           // Cooldown between compressions per conversation (ms)
  missingTriggerRetryMs: 10000, // Short retry delay when the compact UI trigger is temporarily hidden
  slashMenuOpenDelayMs: 650,    // Delay after typing "/" to open the command menu (ms)
  slashMenuCommandTimeoutMs: 4000, // Maximum time to wait for the slash compact command (ms)
  slashMenuCommandPollIntervalMs: 250, // Poll interval while waiting for slash menu command (ms)
  menuOpenDelayMs: 650,         // Delay after opening context menu (ms)
  confirmDelayMs: 650,          // Delay after clicking compress (ms)
  onlyWhenIdle: true,           // Avoid compacting while Codex is generating or reconnecting
  verifyAfterCompact: true,     // Re-read usage after compacting and record whether it dropped
  verifyDelayMs: 8000,          // Delay before verifying compaction result (ms)
  verifyTimeoutMs: 60000,       // Maximum time spent waiting for usage to drop (ms)
  verifyPollIntervalMs: 3000,   // Poll interval while verifying compaction result (ms)
  verifyMinReductionTokens: 1000, // Minimum token drop considered a successful compact
  dryRun: false,                // If true, don't actually compress (for testing)
  debug: false                  // If true, log debug information
}));
```

Set `contextWindowOverride` to `0` or `null` to trust the context window reported by Codex. For a local `llama-server -c 73728`, prefer `providerContextWindowOverrides` or `modelContextWindowOverrides` instead of a global override; this prevents Codex Desktop metadata such as `258400` from making the used percentage look too low without incorrectly applying `73728` to GPT/OpenAI sessions.

If Codex exposes token usage but does not expose `provider`, `model`, or `baseUrl`, set `unknownContextWindowFallback` to the real context window for that dedicated third-party API instance:

```javascript
localStorage.setItem('codexNativeAutoCompactConfig', JSON.stringify({
  unknownContextWindowFallback: 73728
}));
```

Leave it as `null` for mixed-provider Codex sessions, because different models can have different context windows.

When `autoDiscoverContextWindow` is enabled, the script tries to discover a provider-reported context window from endpoints such as `/props`, `/v1/models`, and `/models`, then caches the result briefly. This works only when the provider exposes fields such as `context_length`, `max_context_length`, `max_model_len`, `n_ctx`, or `num_ctx` and the page is allowed to fetch that endpoint. If the provider does not expose the value or CORS blocks the request, use an override.

With a `73728` context window, keep `thresholdUsedPercent` around `65`-`70`. Native compact still has to send the current conversation plus system/tool wrapper tokens, so waiting until `82%` can leave too little room and make the compact request itself exceed the server context. `minRemainingTokensBeforeCompact` provides an additional fixed safety buffer for third-party APIs whose real context window is smaller than Codex metadata reports.

If `remainingTokens` falls below `minRemainingTokensToAttemptCompact`, the script records `too-late-for-compact` and stops attempting automatic compaction for that tick. At that point the native compact request itself may no longer fit in the provider context window, so retrying can cause reconnect loops.

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
   - If no context menu trigger is visible, opens the slash command menu and selects the compact command
   - Clicks the compress button and confirms the action
   - Skips attempts while Codex appears busy if `onlyWhenIdle` is enabled
   - Keeps a pending compact when usage is above threshold but Codex is busy, then retries immediately when the UI becomes idle
   - Uses a short retry delay instead of full cooldown when the compact trigger is temporarily missing
   - Verifies the result afterward and records `usage-reduced` or `usage-not-reduced`

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

// Inspect provider context-window discovery cache
window.__codexNativeAutoCompact.getContextWindowDiscovery();
```

## License

MIT
