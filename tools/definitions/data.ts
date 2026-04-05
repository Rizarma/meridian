import type { ToolDefinition } from "../../types/index.js";

export const dataTools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: `Get current wallet balances for SOL, USDC, and all other token holdings.
Returns:
- SOL balance (native)
- USDC balance
- Other SPL token balances with USD values
- Total portfolio value in USD

Use to check available capital before deploying positions.`,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  {
    type: "function",
    function: {
      name: "swap_token",
      description: `Swap tokens via Jupiter aggregator.
Use when you need to rebalance wallet holdings, e.g.:
- Convert claimed fee tokens back to SOL/USDC
- Prepare token pair before deploying a position

WARNING: This executes a real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          input_mint: {
            type: "string",
            description: "Mint address of the token to sell",
          },
          output_mint: {
            type: "string",
            description: "Mint address of the token to buy",
          },
          amount: {
            type: "number",
            description: "Amount of input token to swap (in human-readable units, not lamports)",
          },
        },
        required: ["input_mint", "output_mint", "amount"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_token_info",
      description: `Get token data from Jupiter (organic score, holders, audit, price stats, mcap).
Use this to research a token before deploying or when the user asks about a token.
Accepts token name, symbol, or mint address as query.

Returns: organic score, holder count, mcap, liquidity, audit flags (mint/freeze disabled, bot holders %), 1h and 24h stats.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Token name, symbol, or mint address" },
        },
        required: ["query"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_token_holders",
      description: `Get holder distribution for a token by mint address.
Fetches top 100 holders — use limit to control how many to display (default 20).
Each holder includes: address, amount, % of supply, SOL balance, tags (Pool/AMM/etc), and funding info (who funded this wallet, amount, slot).
is_pool=true means it's a liquidity pool address, not a real holder — filter these out when analyzing concentration.

Also returns global_fees_sol — total priority/jito tips paid by ALL traders on this token (NOT Meteora LP fees).
This is a key signal: low global_fees_sol means transactions are bundled or the token is a scam.
HARD GATE: if global_fees_sol < config.screening.minTokenFeesSol (default 30), do NOT deploy.

NOTE: Requires mint address. If you only have a symbol/name, call get_token_info first to resolve the mint.`,
      parameters: {
        type: "object",
        properties: {
          mint: {
            type: "string",
            description:
              "Token mint address (base58). Use get_token_info first if you only have a symbol.",
          },
          limit: {
            type: "number",
            description: "How many holders to return (default 20, max 100)",
          },
        },
        required: ["mint"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_token_narrative",
      description: `Get the narrative or story behind a token from Jupiter ChainInsight.
Returns a plain-text description of what the token is about — its origin, theme, community, and activity.
Use during token evaluation to understand if there is a real catalyst driving attention and volume.

GOOD narrative signals (proceed with more confidence):
- Specific origin story: tied to a real-world event, viral moment, person, animal, place, or cultural reference
- Active community: mentions contests, donations, real-world actions, organized activities
- Trending catalyst: references something currently viral on X/CT (KOL call, news event, meme wave)
- Named entities: real identifiable subjects (a specific animal, person, project, game, etc.)

BAD narrative signals (caution or skip):
- Empty or null — no story at all
- Pure hype/financial language only: "next 100x", "to the moon", "fair launch gem" with no substance
- Completely generic: "community-driven token", "meme coin" with zero specific context
- Copy-paste of another token's narrative`,
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address (base58)" },
        },
        required: ["mint"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_top_lpers",
      description: `Get the top LPers for a pool by address — quick read-only lookup.
Use this when the user asks "who are the top LPers in this pool?" or wants to
know how others are performing in a specific pool without saving lessons.

Returns: aggregate patterns (avg hold time, win rate, ROI) and per-LPer summaries.
Requires LPAGENT_API_KEY to be set.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The pool address to look up top LPers for",
          },
          limit: {
            type: "number",
            description: "Number of top LPers to return. Default 5.",
          },
        },
        required: ["pool_address"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "study_top_lpers",
      description: `Fetch and analyze top LPers for a pool to learn from their behaviour.
Returns aggregate patterns (avg hold time, win rate, ROI) and historical samples.

Use this before deploying into a new pool to:
- See if top performers are scalpers (< 1h holds) or long-term holders.
- Match your strategy and range to what is actually working for others.
- Avoid pools where even the best performers have low win rates.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "Pool address to study top LPers for",
          },
          limit: {
            type: "number",
            description: "Number of top LPers to study. Default 4.",
          },
        },
        required: ["pool_address"],
      },
    },
  },
];
