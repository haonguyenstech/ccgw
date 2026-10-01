# ccgw Figma Bridge

The Figma plugin half of `ccgw connector add figma-local`. It is the plugin from
[grab/cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp)
(MIT, see LICENSE) with these changes:

- usage analytics removed — it only talks to `ws://localhost:3055`
- connects on open and reconnects on its own, always on channel `ccgw`
- ccgw wording in the UI
