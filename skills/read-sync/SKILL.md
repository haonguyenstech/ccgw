---
name: read-sync
description: Read the latest ccgw handoff note in this project's knowledge (what was done in the gateway Claude Desktop / Claude Code since) and confirm it is understood. Use when the user says "read sync", "read-sync", "đọc sync", "read handoff", "đọc handoff", or asks to read a "Handoff - … .md" file.
---

# Read the latest ccgw handoff

`ccgw handoff` puts one knowledge file per chat into a claude.ai project, named
`Handoff - <chat title> (<8-char id>).md`. Each starts with:

```
# Handoff: <chat title>

_… Handed off <YYYY-MM-DD HH:MM> UTC. Written by ccgw handoff._
```

then `## Handoff note` (goal, done, decisions, state, still to do, next step),
`## What Claude Code touched`, `## Files produced` and
`## Conversation in Claude Code` (the full record).

## Steps

1. Find the project knowledge files whose name starts with `Handoff - `.
   - If the user named a chat or file, use that one.
   - Otherwise take the latest: the one whose `Handed off … UTC` time is newest.
     Older notes without that phrase: use the end of the `… – … UTC` range on
     the same line.
   - None found: say there is no ccgw handoff in this project's knowledge
     (run `ccgw handoff` on the Mac first) and stop.
2. Read the whole file, not just the note: the conversation is the record and
   wins where the note disagrees.
3. Reply with **only** a one-line confirmation, in the user's language
   (Vietnamese if they wrote Vietnamese), for example:

   `✓ Đã đọc hiểu thành công handoff "<chat title>" (<YYYY-MM-DD HH:MM> UTC).`

   Do not summarize, do not start on the next step, do not ask questions. Keep
   what you read in mind and carry on from it when the user's next message
   asks for work.
