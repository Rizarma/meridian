# Code Style Guidelines

Naming conventions and development standards for the Meridian codebase.

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Variables/functions | camelCase | `getPoolData`, `isValid` |
| Constants | UPPER_SNAKE_CASE | `MAX_RETRIES`, `API_URL` |
| Types/interfaces | PascalCase | `PoolData`, `ConfigOptions` |
| Files | kebab-case | `pool-screening.ts`, `health-check.ts` |
| Classes | PascalCase | `RateLimiter`, `StateManager` |
| Enums | PascalCase + UPPER_SNAKE_CASE values | `enum ExitReason { STOP_LOSS, TAKE_PROFIT }` |
| Private methods | Underscore prefix | `_internalMethod()` |
| Boolean variables | Prefix with `is`, `has`, `should`, `can` | `isActive`, `hasBalance` |

## Code Quality Checklist

Before committing:

1. **Type check:** `pnpm typecheck` — must pass
2. **Lint/format:** Pre-commit hooks run Biome automatically
3. **Test in dry-run:** `pnpm dev` for behavior validation

## File Organization

- Keep files under 300 lines when possible
- One logical concern per file
- Group related exports in `index.ts` barrels
- Place types in `src/types/` or co-locate with implementation

## Error Handling

- Use specific error types, not generic `Error`
- Log at the point of failure, not just at boundaries
- Always await promises in `try/catch` blocks

## Comments

- Explain **why**, not what
- Document non-obvious business logic
- Keep JSDoc for public APIs
