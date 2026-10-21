# "AI tối ưu" button

The button sits left of **Slice plate** in Bambu Studio's top bar. It is compiled into Studio
(`studio/bambustudio/ai-button.patch`), so changing its look, what Studio measures or how it applies the
result means rebuilding the image.

A click (when this folder, mounted read-only at `/opt/studio-ai`, has an executable `on-click`):

1. Studio writes `/tmp/studio-ai/request.json`: the printer, process and filament presets, the current values
   of the process settings the AI may change, and each object's size, volume, bed-contact area and overhang area.
2. Studio runs `on-click /tmp/studio-ai/request.json /tmp/studio-ai/response.json` and waits without blocking
   (the button shows "AI đang phân tích...").
3. `on-click` posts the request to the gateway (`STUDIO_AI_URL`, default
   `http://host.docker.internal:3000/api/studio/ai-optimize`) and writes the JSON answer to `response.json`.
4. Studio lists the proposed changes with their reasons. On **Yes** it loads them into the edited process
   preset, as if they had been typed in the Process tab: they show as modified and can be reset there.

`on-click` changes without a rebuild. Without it, Studio shows a "coming soon" message.

`response.json` is `{"success": true, "summary": "...", "changes": [{"key", "label", "value", "reason"}]}`,
or `{"success": false, "message": "..."}`, which Studio shows as an error.
