# QCM Agentic App — Developer Guide

## Stack
- **Backend**: Node.js ≥18 · Express · `@anthropic-ai/sdk` (`claude-sonnet-4-6`)
- **Frontend**: Vanilla JS · Server-Sent Events · no build step
- **API**: Oracle ATP via ORDS (REST) — existing system, **do NOT rebuild**
- **Brand**: `#F47920` orange · `#222E5F` navy · `#009FDE` cyan

---

## Project Structure

```
bg-qcm-agentic-app/
├── server.js           # Express server, SSE management, in-memory session store
├── agent/
│   ├── agent.js        # Two-phase agent loop: plan (no tools) → execute (with tools)
│   ├── tools.js        # Claude tool definitions (9 tools) + CRITICAL_TOOLS set
│   └── executor.js     # ORDS HTTP calls — one async function per tool
└── public/
    ├── index.html      # 30/70 split layout (chat | workspace)
    ├── styles.css      # Brand colour system, dark navy theme
    └── app.js          # SSE client, plan/log/result rendering
```

---

## Real ORDS Endpoints

**Base URL**: `https://g4b9bc24e36abdb-atpintellinum.adb.us-ashburn-1.oraclecloudapps.com/ords/qcm_demo/quality`

Filters are passed as **request headers** (not query params) unless the OpenAPI spec says otherwise.

| Tool | Method | Path | Notes |
|------|--------|------|-------|
| `get_quality_cases` | GET | `/case` | Headers: `caseNumber`, `caseTypeName`, `status`, `facilityCode` |
| `create_quality_case` | POST | `/case` | Body: `description`, `caseTypeId`, `priorityLevel`, `affectedLotLpn` |
| `get_case_types` | GET | `/case-types` | Headers: `caseTypeName`, `isActive` |
| `get_reason_codes` | GET | `/reason-code` | Headers: `reasonCode`, `severity` |
| `lock_inventory` | POST | `/case-lock-mapping` | Body: `caseId`, `targetType`, `targetValue` — also calls WMS |
| `unlock_inventory` | POST | `/case-unlock-mapping` | Body: `caseLockId` |
| `get_case_lock_mappings` | GET | `/case-lock-mapping` | Headers: `caseNumber`, `itemNumber`, `status` |
| `get_case_audit` | GET | `/case-audit` | Headers: `caseNumber`, `newStatus`, `oldStatus` |
| `get_lock_audit` | GET | `/case-lock-audit` | Headers: `caseNumber`, `itemNumber`, `status` |

---

## Agent Execution Loop

```
1. User sends natural language message  (POST /api/chat)
2. Phase 1 — Planning
   Claude called WITHOUT tools (no risk of accidental execution)
   Output format enforced by PLAN_SYSTEM prompt:
     PLAN:
     1. [tool_name]: description
     IMPACT: one sentence
     REQUIRES_CONFIRMATION: YES | NO
3. SSE events emitted: status(planning) → plan({steps, impact})
4. If REQUIRES_CONFIRMATION: YES
   → SSE: confirmation_required  →  UI shows Confirm/Cancel
   → Agent pauses on a Promise  →  resolved by POST /api/confirm
5. Phase 2 — Execution
   Claude called WITH tools; loops until stop_reason = end_turn (no tool calls)
   Per tool call: step_start → executeTool() → step_complete | step_error
6. SSE: complete({summary, stats})  →  UI renders results + summary
```

---

## Environment Variables

```bash
ANTHROPIC_API_KEY=              # required
ORDS_BASE_URL=                  # optional — defaults to demo instance
ORDS_USERNAME=                  # optional basic auth
ORDS_PASSWORD=                  # optional basic auth
ORDS_BEARER_TOKEN=              # optional bearer auth
PORT=3000                       # optional
CLAUDE_MODEL=claude-sonnet-4-6  # optional
```

Copy `.env.example` → `.env` and fill in values.

---

## UI Layout

```
┌─────────────────────────────────────────────────────────┐
│  Header  [QCM Agent]  [status badge]  [New]             │
├────────────────┬────────────────────────────────────────┤
│  Chat  (30%)   │  Workspace  (70%)                      │
│                │  ① Plan  — steps with live status      │
│  Messages      │  ② Actions — Confirm / Cancel          │
│  history       │  ③ Execution Logs — expandable         │
│                │  ④ Results — stats cards + tables      │
│  [input]       │                                        │
└────────────────┴────────────────────────────────────────┘
```

---

## Human-in-the-Loop

Always confirm before:  `lock_inventory` · `unlock_inventory` · `create_quality_case`

Detected automatically when Claude outputs `REQUIRES_CONFIRMATION: YES` in Phase 1.
The agent never executes write operations without an explicit UI click.

---

## Local Setup

```bash
cp .env.example .env    # add ANTHROPIC_API_KEY
npm install
npm run dev             # → http://localhost:3000
```

## Vercel Deployment

```bash
npm i -g vercel
vercel                  # set env vars in Vercel dashboard
```

> **Vercel Hobby note**: Function timeout is capped at **10 s**. Simple read-only queries
> work fine; complex multi-step runs may timeout. Use Vercel Pro (60 s) or
> Railway/Render for full agentic operations.

---

## Adding a New Tool

1. Add definition to `agent/tools.js` → `toolDefinitions`
2. Add executor to `agent/executor.js` → `toolExecutors`
3. Mention the tool name in `PLAN_SYSTEM` in `agent/agent.js`
4. Add a friendly label in `public/app.js` → `toolLabel()`

---

## Constraints

- Never rebuild the ORDS database or schema
- Agent MUST plan before acting — no silent tool calls
- Write operations always require explicit user confirmation
- Prompt caching enabled on both system prompts (`cache_control: ephemeral`)
- Do NOT add a chatbot fallback — this is an agent, not a Q&A bot

---

## Phase Roadmap

| Phase | Status | Scope |
|-------|--------|-------|
| 1 — MVP | ✅ Done | All 9 tools, two-phase agent, SSE streaming, confirmation flow |
| 2 — Hardening | Next | Retry failed steps, pagination, partial-success handling |
| 3 — Intelligence | Future | RAG on SOPs/QC rules, memory, event-driven triggers |
