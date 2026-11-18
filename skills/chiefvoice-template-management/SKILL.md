---
name: chiefvoice-template-management
description: Create or update Chiefvoice prompt templates and their tools in the Chiefvoice web console. Use when the user asks to edit a live-agent or post-call template, its prompt, output schema, completion requirements, or tools.
---

# Manage Chiefvoice templates

Use the authenticated Chiefvoice UI at `https://chiefvoice.elvoryx.in/` for template changes. Templates may be referenced by the attendance-call service, so confirm the intended call scenario and template type before changing a similarly named entry.

## Establish scope

- Identify whether the requested item is a live-agent template, post-call template, or a tool configuration. Do not edit another type as a workaround.
- Search the template list and inspect the full name, type, and current content. Names may not be unique; distinguish duplicates by their IDs or other visible identifiers before editing.
- Preserve unrelated prompt text, tools, output schema, and completion requirements. Make only the requested changes.
- If the user has supplied scenario rules or an output schema, treat those as the source of truth. Keep the spoken prompt and post-call fields consistent with each other and with the backend's expected contract; do not invent new required output fields.
- Use the Chiefvoice UI and the available browser automation. Do not ask the user to paste API keys, bearer tokens, or webhook secrets into chat.

## Edit or create

1. Open the relevant template or tools area in the authenticated console.
2. For an update, re-check the template identity immediately before saving. For a new template, use a name that identifies the scenario and whether it is live-agent or post-call; avoid creating a duplicate when an existing template can be updated.
3. Update only the requested prompt, tool list, schema, or completion requirements. For a new tool, verify its type and configuration in the UI and attach it only to the requested template.
4. Review the complete result before saving: scenario behavior, language/tone, required fields, allowed values, tool availability, and consistency between what the caller is asked and what the post-call output must report.
5. Save, then reopen or refresh the item and confirm the change persisted. Report the template name/type and a concise summary of fields changed.

## Guardrails

- Never place a real call, trigger a test call, publish an unrelated configuration, or modify other templates unless the user explicitly requested that action.
- A template save is an external change. Follow the user's request for the specified template changes, but stop if the target is ambiguous, the UI shows unexpected duplicate candidates, or the proposed edit would change unrelated live behavior; explain the ambiguity and ask which target to use.
- Do not claim a prompt or tool is configured until the saved state is visible in the console.
- Do not expose credentials or sensitive call data in notes, screenshots, or the final summary.
