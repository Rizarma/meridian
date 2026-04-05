# Plan

> This file is the **only tracked file** in this folder. Plan subfolders are gitignored via `plan/.gitignore` — each developer keeps their own plans locally.
>
> **Purpose:** This document serves as the convention guide for creating and organizing planning documents in this project. Read this before creating a new plan.

---

## What This Folder Is For

The `plan/` folder is a space for local planning work — architecture decisions, refactor roadmaps, feature proposals, and spikes. Plans are intentionally **not shared via git** so developers can think and draft freely without polluting the repo history.

What *is* shared (this file) is the **convention** — so that plans made independently still follow a consistent structure and are easy to hand off when needed.

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
- Date and time reflect when the plan was **created**
- Title is lowercase kebab-case, no special characters
- Keep the title short and descriptive (3–5 words)

### Files Inside a Plan Folder

Every plan folder must contain a `README.md` as its primary document. For larger plans, break details into separate files and use `README.md` as the outline.

```
{plan-folder}/
  README.md           # Required — outline or the plan itself
  phase-1-*.md        # Optional — detail files for each phase or section
  diagram.md          # Optional — Mermaid diagrams, ASCII art
  spike.ts            # Optional — proof-of-concept code
  notes.md            # Optional — raw research notes
```

---

## Plan README Template

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

Not every section is required — use judgment based on scope.

