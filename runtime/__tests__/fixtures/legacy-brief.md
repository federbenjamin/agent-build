class: R1 — operator, 2026-09-28
model: opus — a design choice

# Brief — every chat send goes through one typed write

A brief in the shape before `## Parts` and `budget:` existed.

## Target files

- src/server/send.ts
- packages/core/src/chat/**
- .claude/build/notes.md — the hand-tester section

## Hand test

- H1 · a signed-in user who sends hi gets a reply
  - run: `curl -s http://127.0.0.1:54321/functions/v1/chat`
  - pass: exit 0; the output holds `"ok":true`
  - needs: stack
- H2 · the send wrote one message row
  - run: `psql "$APP_PG_URL" -c 'select count(*) from messages'`
  - pass: the count is one more than before H1

## Deliverables

- Every chat write goes through `send.ts`.
- The core package exports the write's type.

```yaml
deliverables:
  - id: d1
    description: "every chat write goes through send.ts"
    covered_by: [judgment]
  - id: d2
    description: "the core package exports the write's type"
    covered_by: [judgment]
```

--- brief complete ---
