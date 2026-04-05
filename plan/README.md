# Planning

This folder contains planning documents for Meridian — architecture decisions, refactor roadmaps, and feature proposals.

> **Note:** Only this `README.md` is tracked in git. Plan subfolders are gitignored — each developer keeps their own plans locally. Use this file as a guide for naming conventions and structure.

---

## Folder & File Naming Convention

### Plan Folder

Each plan lives in its own subfolder:

```
{yyyy-mm-dd}-{hh-mm}-{kebab-case-title}/
```

**Examples:**
```
2026-04-05-15-23-refactor-roadmap/
2026-04-10-09-00-add-caching-layer/
2026-05-01-14-30-hive-mind-v2-design/
```

Rules:
- Date and time reflect when the plan was created
- Title is lowercase kebab-case, no special characters
- Keep the title short and descriptive (3–5 words)

### Files Inside a Plan Folder

Every plan folder must contain a `README.md` as its primary document. Additional supporting files are optional.

```
{plan-folder}/
  README.md           # Required — the plan itself
  diagram.md          # Optional — Mermaid diagrams, ASCII art
  spike.ts            # Optional — proof-of-concept code
  notes.md            # Optional — raw research notes
```

---

## Plan README Structure

Each `README.md` should follow this structure:

```markdown
# {Title}

**Date:** yyyy-mm-dd
**Branch:** {branch-name}
**Status:** draft | in-progress | done | abandoned

## Context
Why this plan exists. What problem it solves.

## Goal
What success looks like.

## Approach
How we plan to achieve it.

## Tasks
Step-by-step breakdown.

## Risk Notes
Known risks, gotchas, rollback strategy.
```

Not every section is required for every plan — use judgment based on scope.

---

## Index

| Date | Plan | Status |
|------|------|--------|
| 2026-04-05 | [Refactor Roadmap](./2026-04-05-15-23-refactor-roadmap/README.md) | draft |
