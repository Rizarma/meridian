# Security Policy

This document outlines known security considerations, accepted risks, and mitigation strategies for the Meridian DLMM liquidity provider agent.

## Reporting Security Issues

If you discover a security vulnerability, please report it privately by emailing the maintainers. Do not open public issues for security bugs.

---

## Known Accepted Risks

### 1. `bigint-buffer` Buffer Overflow (HIGH Severity, CVSS 7.5)

**Status:** ⚠️ Accepted with monitoring  
**GitHub Alert:** [Dependabot #1](https://github.com/Rizarma/meridian/security/dependabot/1)

#### Details
- **Package:** `bigint-buffer@1.1.5`
- **Vulnerability:** Buffer Overflow in `toBigIntLE()` function
- **Impact:** Application crash via malicious input
- **Affected Versions:** 0.0.0 to 1.1.5
- **Patched Version:** None available

#### Dependency Chain
```
@meteora-ag/dlmm
  → @solana/spl-token
    → @solana/buffer-layout-utils
      → bigint-buffer@1.1.5
```

#### Rationale for Acceptance
1. **Transitive dependency:** Meridian does not directly use `bigint-buffer`
2. **No patched version available:** Cannot upgrade to fix
3. **Limited exposure:** Vulnerable function is deep in Solana/Meteora stack
4. **Input control:** No user-controlled input reaches the vulnerable function

#### Mitigation
- Monitor upstream Solana/Meteora packages for updates
- Run `pnpm outdated @meteora-ag/dlmm @solana/spl-token @solana/web3.js bigint-buffer` regularly
- Documented: 2025-04-25
- Review Date: 2025-05-25

---

### 2. `uuid` Buffer Bounds Check (MEDIUM Severity)

**Status:** ⚠️ Partially mitigated (mixed versions in dependency tree)  
**GitHub Alert:** [Dependabot #2](https://github.com/Rizarma/meridian/security/dependabot/2)

#### Details
- **Package:** `uuid@8.3.2` (vulnerable) and `uuid@11.1.0` (patched)
- **Vulnerability:** Missing buffer bounds check in v3/v5/v6 when external output buffers provided
- **Impact:** Silent partial writes without RangeError
- **Affected Versions:** uuid < 9.x (specifically v3/v5/v6 with external buffers)

#### Dependency Chain (Vulnerable)
```
jayson@4.3.0
  → @solana/web3.js@1.98.4
    → @coral-xyz/anchor
      → @meteora-ag/dlmm

node-cron@3.0.3
  → dlmm-agent
```

#### Dependency Chain (Patched)
```
rpc-websockets@9.3.8
  → @solana/web3.js@1.98.4
```

#### Rationale
- **Transitive dependency:** No direct usage in Meridian
- **Limited exposure:** Vulnerable code path (v3/v5/v6 with external buffers) not used
- **Mixed tree:** Some dependencies already use patched v11.1.0

#### Mitigation
- Attempt safe dependency updates: `pnpm update @solana/web3.js jayson uuid`
- Consider `pnpm.overrides` only after compatibility testing
- Documented: 2025-04-25
- Review Date: 2025-05-25

---

## CodeQL Security Alerts

### Clear-Text Logging of Sensitive Information

**Status:** ✅ False Positives (hardened with redaction)  
**GitHub Alerts:** [#6](https://github.com/Rizarma/meridian/security/code-scanning/6), [#3](https://github.com/Rizarma/meridian/security/code-scanning/3)

#### Alert #6: `src/infrastructure/logger.ts:148`
- **Finding:** `console.log(line)` flagged as clear-text logging
- **Reality:** Data is sanitized via `sanitizeMessage()` before logging (line 143)
- **Patterns redacted:**
  - Solana keypair arrays (64+ bytes)
  - Solana private keys (base58, 32-44 chars)
  - API keys (OpenAI/OpenRouter format: `sk-...`)
  - Generic tokens (32+ alphanumeric)
  - Hex secrets (32-64 chars)
  - Long numbers (10+ digits)

#### Alert #3: `src/repl.ts:920`
- **Finding:** `originalLog.apply(console, args)` flagged as clear-text logging
- **Reality:** UI wrapper that passes through to original console.log without interception
- **Purpose:** REPL terminal UI management (status bar redraw)
- **No data transformation:** Does not persist, transform, or forward logs

#### Dismissal Rationale
Both alerts are false positives given:
1. Logger applies comprehensive PII/secrets redaction
2. REPL wrapper is passthrough UI behavior
3. Regression tests verify redaction: `test/regression-sanitize-message.test.ts`

---

## Security Hardening Measures

### Log Sanitization

All console and file output passes through `sanitizeMessage()` which redacts:

| Pattern | Example | Replacement |
|---------|---------|-------------|
| Keypair arrays | `[12, 34, 56, ...]` (64+ bytes) | `[REDACTED_KEYPAIR]` |
| Solana keys | `5KT6iW...` (base58, 32-44 chars) | `[REDACTED_KEY]` |
| API keys | `sk-abc123...` | `[REDACTED_API_KEY]` |
| Tokens | `a1b2c3d4...` (32+ chars) | `[REDACTED_TOKEN]` |
| Hex secrets | `a1b2c3d4...` (32-64 chars) | `[REDACTED_HASH]` |
| Long IDs | `1234567890` (10+ digits) | `[REDACTED_NUMBER]` |

### Regression Testing

Security-critical patterns are tested in:
- `test/regression-sanitize-message.test.ts`

Run with: `pnpm test:phase0:all`

### Dependency Monitoring

```bash
# Check for outdated packages
pnpm outdated

# Audit for vulnerabilities
pnpm audit

# Trace specific packages
pnpm why bigint-buffer
pnpm why uuid
```

---

## Prevention Measures

### CI/CD Security

Recommended additions to CI pipeline:

```yaml
# Dependency audit
- name: Audit dependencies
  run: pnpm audit --audit-level=moderate

# Secret scanning
- name: Secret scan
  uses: gitleaks/gitleaks-action@v2
```

### Pre-Commit Hooks

Ensure `.env` and secrets never committed:

```bash
# Already configured via package.json lint-staged
pnpm lint:check
```

### Dependabot Configuration

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
```

---

## Security Decision Log

| Date | Decision | Owner | Rationale | Review Date |
|------|----------|-------|-----------|-------------|
| 2025-04-25 | Accept `bigint-buffer` risk | @Rizarma | No patch available, transitive only, no user input path | 2025-05-25 |
| 2025-04-25 | Monitor `uuid` mixed versions | @Rizarma | Partially patched, attempt safe updates first | 2025-05-25 |
| 2025-04-25 | Dismiss CodeQL clear-text alerts | @Rizarma | False positives - hardened with redaction | N/A |

---

## Contact

For security questions or to report issues:
- GitHub Security Advisories: https://github.com/Rizarma/meridian/security
- Maintainer: See repository contributors
