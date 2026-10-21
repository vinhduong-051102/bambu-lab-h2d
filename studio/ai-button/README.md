# "AI tối ưu" button

The button sits left of **Slice plate** in Bambu Studio's top bar. It is compiled into Studio
(`studio/bambustudio/ai-button.patch`), so changing its look, what Studio measures or how it applies the
result means rebuilding the image.

A click (when this folder, mounted read-only at `/opt/studio-ai`, has an executable `on-click`):

1. Studio writes `/tmp/studio-ai/request.json`: the printer, process and filament presets, every numeric,
   on/off and choice setting of the edited process preset (the gateway picks the ones the AI may change), and each object's size, volume, bed-contact area and overhang area.
2. Studio runs `on-click /tmp/studio-ai/request.json /tmp/studio-ai/response.json` and waits without blocking
   (the button shows "AI đang phân tích...").
3. `on-click` gets the setting changes from the gateway (`STUDIO_AI_URL`, default
   `http://host.docker.internal:3000/api/studio/ai-optimize`) and writes the JSON answer to `response.json`:
   - with `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`): it posts the request to `$STUDIO_AI_URL/prompt`,
     runs `claude -p` with that prompt and output schema (no tools, no settings files, 5-minute limit), and posts
     `{request, proposal}` to `$STUDIO_AI_URL/check`. Claude is billed to that Claude subscription.
   - without it: it posts the request to `$STUDIO_AI_URL`, and the gateway asks Claude with its `ANTHROPIC_API_KEY`.
4. Studio lists the proposed changes with their reasons, with a box for the user's opinion:
   - **Áp dụng** loads them into the edited process preset, as if they had been typed in the Process tab: they
     show as modified and can be reset there. Studio then runs `gateway POST ai-sessions/<id>/applied` so the
     gateway knows which proposal was used.
   - **Hỏi lại AI** (once the box has text) runs step 1 again with `follow_up: {session_id, comment}` in the
     request: the gateway puts the earlier proposal and the comment in the prompt.

**Báo cáo in**, left of **AI tối ưu**, reports how a print with the AI's settings came out. Studio runs
`gateway GET ai-sessions?limit=30` and shows the recent proposals (the newest applied one without a report is
preselected), the outcomes and problems the gateway lists, and a note box. **Gửi báo cáo** runs
`gateway POST ai-sessions/<id>/feedback`.

`gateway <GET|POST> <path under /api/studio> <body.json|-> <response.json>` is the small script both buttons use
for those routes. It finds the gateway from `STUDIO_AI_URL`, like `on-click`.

`on-click` and `gateway` change without a rebuild. Without `on-click`, Studio shows a "coming soon" message.

`response.json` is `{"success": true, "session_id": "...", "summary": "...", "changes": [{"key", "label", "value", "reason"}]}`,
or `{"success": false, "message": "..."}`, which Studio shows as an error.
