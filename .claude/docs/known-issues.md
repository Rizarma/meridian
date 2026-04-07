# Known Issues / Tech Debt

## `get_wallet_positions` role scoping

The `get_wallet_positions` tool is registered with `roles: ["GENERAL"]` only, and intentionally excluded from `MANAGER_TOOLS` and `SCREENER_TOOLS` in `src/agent/tool-sets.ts`.

This is **intentional**: the tool is for researching *external* wallets (copy-trading), while the agent's own positions are accessed via `get_my_positions`. Do not move it into the MANAGER or SCREENER sets.
