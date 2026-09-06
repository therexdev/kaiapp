# KAI desktop companion

Choose **Launch KAI** in the app's left sidebar. The main window moves out of the way and the same Core, wallet and earning node keep running. KAI appears above your desktop as a small animated robot. The tray menu also offers **Launch KAI companion** and **Hide KAI companion**.

- Click KAI or the chat bubble to open the conversation panel. Drag the robot to move him; his position is remembered and kept within a connected display's usable area.
- Type a question and press Enter. Shift+Enter adds a line. Replies stream from the selected model. KAI starts with the model selected in the main app and offers other downloaded models in the Brain menu.
- Tap the microphone, speak, then tap it again to finish and ask KAI. On Windows, the first use offers the existing local speech-engine download (about 156 MB). Audio is transcribed on this computer. If there is already a typed draft, voice is appended to that draft for review before sending.
- Voice mode turns spoken replies on. The footer's **Voice replies** button toggles playback using installed system voices. Stop interrupts generation or playback. Escape cancels a recording or response before collapsing the panel.
- Conversations are saved in the existing app history with a **KAI** title. The plus button starts a new conversation without deleting the old one.
- Minimize the conversation to leave the robot on the desktop. **Open full app** returns to the normal app. The robot's three-dot menu offers a greeting, an animation toggle, and hiding to the tray.

KAI floats, blinks, looks around and rests when idle. Listening, thinking, speaking, greeting and dragging each have their own articulated animation. System reduced-motion preferences and the animation toggle are respected. The vector rig uses no extra AI model, WebGL engine or video decoder. Hiding the companion pauses its animation and stops microphone recording and voice playback.

This first revision is a conversational desktop companion. It does not operate other applications, inspect the screen, or execute commands. Those capabilities can be added separately to the existing tool and approval system.

Windows has the pinned local voice engine. On platforms without that engine, typing remains available; spoken replies depend on installed system voices. Chat routing retains the app's existing privacy/network policy. Choosing a network model or using the app's Local-First fallback can send prompts to the configured network, just as in the main chat.

## Verification

The normal suite checks context budgeting, streaming boundaries and errors, model selection, window positioning, and IPC sender validation. The browser test exercises streaming chat, history, stop, real browser audio capture with a simulated microphone, local WAV submission, speech playback, microphone cleanup and motion controls. Test CI saves welcome and conversation screenshots.

Windows additionally launches the real companion controller and preload in Electron against a temporary fixture. It checks the transparent, always-on-top sandboxed window, launch/return behavior, streaming chat, compact/expanded bounds, and reusing one mascot window. The existing shared-live-profile and OS-credential check remains mandatory. Packaged ASAR verification checks every companion runtime asset is included.
