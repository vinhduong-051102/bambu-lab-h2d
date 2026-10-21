# "AI tối ưu" button

The button sits left of **Slice plate** in Bambu Studio's top bar. It is compiled into Studio
(`studio/bambustudio/ai-button.patch`), so changing its look or placement means rebuilding the image.

What a click does is not compiled in: Studio runs `/opt/studio-ai/on-click` (this folder, mounted read-only)
when that file exists and is executable, without waiting for it. Without it, Studio shows a "coming soon" message.
Changing `on-click` needs no rebuild.
