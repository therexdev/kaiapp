### KAI interruptions, smoother sentences and a deeper robot voice

- **Say “KAI” to interrupt.** Say the name alone to stop the reply, or begin your new question with it. “Hey KAI” still works. Ordinary speech no longer interrupts a reply, including profiles that previously disabled the name requirement.
- **Keep talking after a reply.** Follow-ups still need no wake phrase for a minute after KAI finishes. A question spoken immediately after a separate “KAI” cue is retained while the cue is being recognized.
- **Complete sentences before playback.** KAI no longer speaks a short opening fragment while the rest of that sentence is still being synthesized. Longer sentences are assembled into one audio clip, and the next sentences are prepared ahead. This favors smoother speech and can increase the initial wait; slower computers can still pause between sentences.
- **The same voice, a little more KAI.** Heart stays the default voice. The new **KAI** voice character sounds slightly deeper with a light electronic texture. Choose **Natural · original sound** under **Voice & listening → Voice character** to compare. No additional voice download is needed.

### Calmer listening with a TV nearby

- **TV nearby** is the new default microphone setting. It requires stronger, longer speech and rejects more quiet background dialogue. **Voice & listening** also offers balanced and quiet-room settings, with a live microphone level indicator.
- **Say “Hey KAI” to interrupt a reply** is on by default. Movie dialogue no longer pauses or replaces a reply unless the name is recognized. You can turn this option off for immediate speech-onset interruption in a quieter room. Follow-up questions after KAI finishes still need no wake phrase; tapping the mic always interrupts directly.
- The mouth moves only when audio actually starts playing, and stops when audio pauses or ends. Preparing a voice no longer looks like silent talking.
- KAI prepares a shorter first clause and loads the installed voice engine while listening or thinking. This reduces startup work after text arrives. Local voice generation, particularly compatibility mode, can still take several seconds.

KAI does not recognize your individual voice yet. Sensitivity filters sound level, not speaker identity: a loud movie can still trigger a follow-up after the reply. Keep background sound below the listening level, move the microphone closer, or turn hands-free listening off when needed.

### KAI listening stability repair

- Fixed a reply getting stuck on pause when another sound arrived during transcription.
- Background noise no longer blocks a voice that is still being prepared. KAI briefly checks your microphone level when listening starts and filters steady hum more reliably.
- The microphone indicator stays on while listening, recognizing words and replying. Temporary recognition errors keep the same microphone session open.
- Unconfirmed interruptions have a time limit, so they cannot leave KAI silent indefinitely. Confirmed questions still interrupt and retain the conversation.

### Natural voice startup repair

- KAI now automatically recovers when Windows cannot load its native voice DLL. The compatible engine uses the same local Heart, Bella, Puck and Emma voices and your existing voice download.
- The setup card shows a clear error and **Retry natural voice** if setup fails, instead of staying on “Warming up.” Retrying verifies and reuses downloaded files.
- Compatibility mode can take longer to generate speech. Replies still start playing as phrases become ready, and Stop and interruptions cancel pending audio.

### A more natural conversation with KAI

- **Heart is now the default voice.** KAI offers a one-time 93 MB natural-voice download right beside the robot. No account or subscription is needed. The old automatic computer voice no longer takes over silently. You can preview Heart, Bella, Puck and Emma in **Voice & listening**.
- **Tap the mic and talk.** You do not need a wake phrase or a second tap to send. Pause briefly and KAI answers. The waveform button enables “Hey KAI” when you want to start hands-free.
- **Keep the conversation going.** After waking KAI, ask follow-up questions without repeating its name. KAI stays in conversation for a minute after each reply. Say “That’s all” to return to wake-only listening, or “Stop listening” to switch the microphone off.
- **Interrupt naturally.** Start speaking during a reply and KAI pauses its voice. Once your words are recognized, it stops the old response and answers with the earlier conversation and your new request in context. Echo cancellation and a local echo check help prevent KAI from answering itself.
- **Just the robot by default.** Voice questions do not open the chat panel. Click the chat bubble to open it and the minus button to minimize it again. A Stop button is available beside the robot during replies.
- **More responsive listening.** Quieter speech is detected, pauses are shorter, and capture continues while earlier audio is being transcribed.

Listening remains opt-in, with a green microphone indicator. Hiding KAI, returning to the full app or quitting turns it off. Microphone audio stays on this computer; accepted questions go to your selected chat model. Local transcription and voice generation still take some processing time, and speaker/microphone hardware affects interruption performance.

Test continues using your existing profile, wallet, models and earning node.
