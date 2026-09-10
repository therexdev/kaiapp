### Smoother GPU earning and accurate producer status

- Automated network probes now prefer one resident model per earning session, avoiding background model unload/reload cycles every few minutes. User-selected network models remain available.
- Block-producer checks inspect the actual node service when recent log output has no VHP estimate. A temporary or noisy log gap no longer claims the node may have stopped, while stopped, syncing and recovering states remain distinct.

### Security and reliability sweep

- Hardened remote API access, local browser access, desktop window permissions, wallet files and public web requests.
- Fixed truncated or incorrectly typed Agent Network results, lingering network requests after Stop, stalled MCP responses, and download failures that could crash the app.
- Local-Only earnings status stays offline while earning is stopped. Email requires encrypted delivery; calendar connections and event text have stronger validation.
- Updated vulnerable dependencies and added security regression checks to the Test release workflow. Scheduler authorization and request-handling fixes are included in the repository and require a separate server deployment.
- See the [audit findings, validation and remaining coverage](SECURITY_SWEEP_2026-09-10.md).

### Clearer navigation and node status

- Sidebar menu groups now expand one at a time. Open Workspace, Your toolkit or Contribute to reveal its options; the previous group retracts.
- Quick sync clearly shows that the node is stopped for a snapshot restore. Start/stop controls stay unavailable during the restore, and saved key registration no longer implies active block production.
- Dashboard status uses one colored dot, including an amber state for quick sync.

### Agent Network private service preview

- Agents content scrolls within its workspace while the app navigation stays in place.
- Added Agents with Discover, My agents, Jobs, Earnings, Activity and separate relay settings. Create a service from a template or reviewed workflow, request a signed free quote, run it, and inspect the encrypted result.
- Includes a headless client and independent relay implementation. Hosted workflows use isolated job data and installed local models; private Brain, app credentials and the earning wallet are unavailable to callers.
- This is the first foundation for the Agent Network v1 proposal. Paid services remain disabled: the new custody contracts, sponsorship and paid-network acceptance still need deployment and integration. No KAI is moved and no new rewards are emitted. See [setup and current coverage](agent-network/README.md).

### Cleaner producer wallet controls

- Producer address and public-key fields now match the node settings, with rounded borders and room to read their values. The Copy button sits beside the public key, actions wrap on smaller windows, and external signing has clearer spacing.

### Connected chat and instant workflows

- Main Chat and desktop KAI can discover connected accounts, inspect selected action inputs, and chain app actions using returned file/message IDs. Ask for a folder and spreadsheet, a document, an appointment, or a message. Each external call still uses exact native review.
- Ask KAI to find, inspect, run, check, stop or resume a saved workflow. Unreviewed drafts must first be saved in the builder; running a workflow does not enable a schedule.
- One-time action chains can run from chat and be saved as disabled workflow drafts. The tool loop now allows up to 24 steps.
- Action receipts appear in chat and under Connections → Connected apps. Partial and uncertain outcomes remain visible after restart; uncertain writes cannot auto-retry. Inspect the destination before acknowledging an uncertain receipt.
- Manage access now includes guidance and action-search shortcuts for Google Calendar/Docs/Sheets/Drive, Discord Bot, Slack, Gmail, Teams, Notion, GitHub issues, Todoist and OneDrive/Excel.
- Public research can continue after a private Brain lookup through a desktop-only tool that reviews the exact public query or URL. Private observations still cannot flow into ordinary Core/MCP tools.
- Your accounts must have the required selected actions and **Use in conversations** enabled. Provider scopes and actual account compatibility still need testing in your installation. Discord messages use the bot/app identity. No new hosting environment variables are needed.

See [connected chat setup and testing](KAI_CONNECTED_CHAT.md).

### External producer wallets

- Koinos Node now supports a watch-only producer address separate from the KAI earning wallet. Generate/copy/rotate the hot block key, verify registration on-chain, and prepare externally signed registration, burn and transfer transactions. Automatic funds operations are disabled in external mode. See [setup and offline signing](EXTERNAL_PRODUCER.md).

### Steadier KAI animations

- The Launch KAI card no longer jumps during desktop-provider status refreshes.
- Speaking keeps one continuous arm/head pose between audio phrases and buffering pauses. The mouth still follows audible playback, and the status bubble keeps a consistent size.

### KAI-managed connection fix

- Fixed the desktop account-service wiring that incorrectly showed managed connections as disabled even when the server was enabled. Connections now shares the account server and sign-in service used by Settings. Existing server environment variables and personal Composio keys need no changes.

### Workflows with a visual flow builder

- **A cleaner sidebar.** Brain, Workflows and Connections sit flush beside the main navigation, with compact left-aligned menus.
- **Build connected routines.** Drag nodes, connect branches, edit their settings, zoom/pan, auto-arrange and undo changes. Includes conditions, switches, merges, loops, sub-workflows, parsing, transformations and isolated JavaScript.
- **Build with KAI.** Describe a routine, review Copilot's graph proposal or choose from nine templates. Discover suggestions from selected context, optionally once a day.
- **Run when it matters.** Manual input, time-zone schedules, app/source change watches and Composio app events. Inspect each run's data, timing, retries and approvals on the canvas or in history.
- **Tasks moves into Workflows.** Existing scheduled prompts migrate with their timing and previous chat links; old timers stop to prevent duplicates. Brain's personal to-dos remain.
- **Review before changes.** App and Brain writes pause for approval, including individual items and nested flows. Preview uses simulated capability outputs without external changes.

Read the [Workflows guide](KAI_WORKFLOWS.md) and [OpenHuman coverage comparison](OPENHUMAN_WORKFLOW_COVERAGE.md). Live Composio events need the matching server update and KAI sign-in. Existing connection environment values remain valid; no new Composio API key is required. Schedules and workflow reasoning run on your desktop while KAI is open, using installed local models.

### A connected Brain, with Awareness

- **The same 1,516-app catalog in both connection modes.** Search the full list immediately, filter eight stable categories or authentication types, and browse compact logo cards. Category changes no longer repeat or grow the menu.
- **Sidebar navigation.** Brain, Workflows and Connections now use a left rail like Koinos Node.
- **A richer Brain.** Explore source/topic relationships, search by source/topic/date, maintain goals and tasks, and compare memory changes with their original text.
- **More sources.** Select local text folders, KAI conversations, public websites, RSS/Atom feeds and GitHub repositories, alongside your connected app reads. Each source has its own refresh control.
- **Awareness.** Choose Off, Observe or Assist, select what KAI can read, add custom background checks and use an installed local model for summaries, briefings and reviewable suggestions.
- **Visible background work.** Inspect the queue, results, retry/stop controls and activity; start reviewed workflows for follow-through.
- **Portable knowledge.** Export a new Markdown/Obsidian folder with linked sources, topics and memories.

Read the [Brain and Awareness guide](KAI_BRAIN_AWARENESS.md) and [OpenHuman feature coverage](OPENHUMAN_BRAIN_COVERAGE.md). The full app catalog includes OAuth, API credentials and other connection types; provider/project setup still applies. This update needs no new server environment variables.

### Connect without a settings loop

- **App cards keep the chosen app open.** Connect checks the current server status and explains whether KAI sign-in, a personal key, or a privacy change is needed.
- **Server setup and desktop sign-in are shown separately.** When the server enables Composio, KAI-managed connections need only your KAI account sign-in. Expired sessions get a clear sign-in prompt.
- **Key errors identify the right setting.** A rejected server Composio key asks the administrator to check it, without reporting your desktop sign-in as expired.
- **Fresh status without losing your place.** Refresh picks up a newly enabled server, keeps useful errors visible, and preserves a key or connection method being edited.

### Easier app connections

- **Explore your apps.** Search a catalog with platform logos, categories, and a guided browser sign-in. See your connected accounts and manage each one separately.
- **Choose who manages the connection.** Use **KAI-managed** connections after the server administrator enables Composio, or save your own Composio project key. Both use the same catalog and sign-in flow.
- **Choose what KAI can use.** Select actions, allow conversation access, and bring selected read-only data into Brain through ordinary input fields. Optional source refresh runs every 20 minutes while KAI is open. Actions that can make changes still require review.
- **Keep account boundaries clear.** Switching methods keeps projects separate. Personal keys stay encrypted on the desktop; the shared key stays on the server. Custom APIs remain available in their own tab.

## Companion workspaces: Brain, Workflows and Connections

- **Brain:** editable notes, people/projects/preferences, tags, pins, goals, a category map, text imports, selected API sources, optional 20-minute sync, and Markdown export. Relevant context supports private/local chat and desktop KAI.
- **Workflows:** visual ordered steps, local-model drafting, templates, manual/recurring schedules, API steps, conditions, approvals, cancellation and persistent run history. Reasoning uses installed local models; private provider keys remain reserved for attended chat.
- **Connections:** self-managed tokens/API keys, starter GitHub/Notion/Slack/Home Assistant operations, custom APIs, request testing and separate agent/background-read grants. Keys are encrypted in the desktop app; writes and model-requested calls ask for approval.
- Includes a [setup guide](KAI_COMPANION_QUICKSTART.md) and [full companion feature inventory/roadmap](KAI_COMPANION_ROADMAP.md), distinguishing this implementation from future OpenHuman-inspired capabilities.


### Tidier Developer Tools

- **Aligned fields and actions.** Multi-agent, Playground and Pipelines now use consistent labels, field heights and spacing. Saved-team controls stay together, and forms stack cleanly in smaller windows.
- **Compact agent cards.** Tool lists expand when needed, show the selected count, and keep checkboxes beside readable names. Role instructions stay in a normal text font; JSON editors keep their code formatting.
- **Clearer JSON controls.** Builder updates sit beside each JSON editor, with a reminder that saving and running use the JSON. Existing team definitions and execution behavior stay the same.

### More natural conversations and fewer provider cut-offs

- **Room to finish your question.** In **Voice & listening → Conversation pauses**, Natural allows a short thinking pause, Quick sends sooner, and Patient gives you more time. Natural is the default. Words spoken while KAI is still recognizing your question stay together in one request. This uses the existing local listener; no extra download is needed.
- **Interruptions still need “KAI.”** Recognizing the name stops the old reply, even if you are still finishing your new question. Ordinary dialogue during a reply cannot interrupt it. Stop and hiding KAI cancel pending input and reply audio. Microphone Off and listening-setting changes discard unfinished input.
- **Fix for frequent “output limit” errors.** Private Anthropic/OpenAI action planning has a larger allowance. If a plan hits that limit, KAI makes one attempt with more room before any action runs. Incomplete plans cannot reach the tool runner, and existing approvals still apply.
- **Long answers can finish.** A confirmed output limit can continue the answer once with the same provider. Recovery uses the original Stop button and deadline. If the answer is still too long, KAI keeps the partial text and explains how to continue, instead of cancelling its speech. A recovery request uses your provider account and may add usage; account errors and disconnected streams do not automatically retry or switch providers.

Pocket's continuous audio, character effects and voice selection stay in place. Conversation pauses change how long KAI waits after you speak, not the voice's synthesis speed. This is pause handling, not speaker identification or a new semantic turn-detection model.

### Pocket voice setup, right where you need it

- **A visible download button beside the voice selector.** Pocket setup now sits at the top of **Voice & listening**, with a clear blue **Download Pocket voices** button and progress. There is no need to scroll past the other voice settings.
- **Download directly from KAI’s prompt.** When a selected Pocket voice is missing, the desktop message includes the download button, progress and retry. Once ready, click **Try Alba** (or your selected Pocket voice) right there.
- **An easy sample after setup.** The same voice panel offers a named sample button after the download. Downloads still require your click, and installing alone keeps your existing voice selected.

### Try Pocket voices with KAI

- **Four optional English voices.** Download Pocket once in KAI’s **Voice & listening** panel, then choose Alba, Marius, Javert or Azelma. Your existing voice stays selected until you change it. The download is about 201 MB; no account, Python installation or subscription is needed.
- **Audio starts while the sentence is still generating.** Pocket sends small audio chunks to a continuous player. Cute, Squeak and Classic effects keep their pitch and timing across those chunks. Your usual reply-timing choice returns when you select another engine.
- **Compare on your computer.** “Hear a hello” uses the real engine, and the panel reports the last sentence’s startup time and buffering pauses. This is a trial, not a promise of faster speech on every computer. The first use after loading is slower.
- **Local and easy to stop.** Pocket runs in an isolated CPU process. Stop, voice-off and hiding KAI stop its audio; unused voices release their memory. Existing microphone behavior and the spoken “KAI” interruption rule are unchanged. This English bundle does not add Korean speech.

### Smoother thinking and clearer spoken answers

- **A proper hand at his chin.** KAI now rests a curled hand under his face, with upright knuckles. The same grip holds his magnifying glass while searching.
- **Steady thinking and searching.** His arm eases into position, his head nods gently, and web searches keep their animation between lookup steps. A greeting ends when KAI starts working, so the poses do not compete.
- **Answers without spoken web addresses.** Voice replies skip full URLs, numbered citations and source lists. Useful source links remain clickable in the text chat.
- **Emoji in plain words.** Common emoji get short names such as “smiley face emoji,” “thumbs up emoji” or “robot emoji.” Combined emoji are handled as one symbol. This works with fast Windows, browser and natural voices, including streamed replies.

### KAI can work in your browser and desktop apps

- **“Open Tubi” just opens Tubi.** Known website commands launch your default browser immediately. You can also give KAI a complete website address.
- **Ask about what is on your screen.** On Windows, KAI can inspect visible window controls, switch windows, click buttons, type into text fields and scroll. A vision-capable model can also see screenshots and propose visual clicks or drags. Try **“Play the movie on my screen.”** If several movies could match, tell KAI the title or point at it first.
- **Your existing browser session.** KAI works with the apps and browser where you are already signed in. It checks the updated screen after each action; availability depends on how the app exposes its controls and how well your selected model understands the task.
- **You stay in control.** Approve each desktop task once. Purchases, rentals, messages, destructive actions, unknown controls and visual clicks require another confirmation. Visual targets are marked on screen. **Ctrl+Alt+Backspace** stops control immediately; KAI reserves **F8** if that shortcut is already taken. The red Stop button and **KAI options → Stop desktop control** also work. Closing or hiding KAI ends permission.
- **Private to your desktop.** Choose an installed local model or your own OpenAI/Anthropic connection. The permission prompt tells you whether screen text and screenshots will go to your API provider. Desktop observations never overflow to network workers. Screenshots are held in memory for the current task and are not saved as chat attachments.

Passwords, CAPTCHAs, administrator prompts and terminal commands remain manual. Protected video cannot be inspected through screenshots; KAI uses visible player controls. No streaming subscription, rental or paid API connection is included or enabled automatically.

### Clear status bubbles and Korean Windows speech

- **The whole status bubble stays visible.** Thinking, speaking, microphone and Stop changes now update the native desktop window's visible area, including while KAI rests on the bottom edge.
- **Korean replies use an installed Korean Windows voice.** Your usual voice remains selected for later replies, and Cute, Squeak and Classic effects still apply. If Korean speech is missing, KAI explains how to add it through **Voice & listening → Add Windows voices**, followed by **Refresh voices**. Nothing is installed automatically.
- **A missing language no longer looks like a broken audio format.** KAI shows one helpful message, keeps the full text answer and lets the next conversation continue normally. Internal Windows IPC error text is removed.
- **Continuous replies handle different voice sample rates.** An English introduction and Korean answer can play together without a rate-mismatch error.

### A proper wave and faster character voices

- **A natural little wave.** KAI bends his elbow and shows an open palm. His wrist waves gently instead of swinging the entire arm backward. This works on the desktop and while resting along the edge.
- **Fast Windows voices with real character effects.** Open **Voice & listening → Use fast Cute KAI**. The installed Windows voices now produce local audio that KAI can actually reshape, so Cute KAI, the Squeak slider and Classic deeper KAI work even when the browser voice engine ignores pitch. No neural-model download or new account is needed. The list includes supported installed Windows and desktop voices, which vary by computer.
- **More installed options.** **Add Windows voices** opens Windows Speech settings. Install an available speech voice there, then **Refresh voices** in KAI. Only voices exposed by Windows' supported speech APIs appear; a Narrator-only voice is not promised to work in other apps.
- **Choose how replies start.** Quick start plays the first complete sentence and works best with fast voices. Head start prepares two sentences. **Whole reply** prepares and joins the reply audio first, then plays it continuously, avoiding waits for synthesis between sentences. It takes longer to begin; exceptionally long answers are read in bounded sections.

An explicitly selected browser Windows voice is upgraded to its matching installed voice when found. Existing natural voice selections stay selected. The four natural voices share one engine, so switching among them is not a speed upgrade. Stop, KAI-name interruptions, follow-ups, microphone cleanup and the shared wallet/node profile are preserved.

### Pick KAI up and bring him along

- **A little robot in your hand.** Pick KAI up by dragging him. His arms and legs dangle, his cape sways, and his body leans with your movement. Dropping him on the desktop gives a soft settling bounce.
- **A place on the desktop edge.** Drop KAI near the bottom of the usable screen and he rests with his hands along the edge above the taskbar. Slide him left or right, or pull upward to lift him back onto the desktop. His resting position is remembered.
- **No more bottom-to-top jump.** Movement follows the monitor under your cursor and keeps the native window inside that monitor's usable area, including when chat is open or displays change.
- **More expressive activities.** Thinking brings a hand to his chin with a question mark and a little idea bulb. Actual web searches bring a moving magnifying glass and floating pages. Speaking adds hand gestures; the mouth still follows audible playback.

Click KAI to open or minimize chat. **Animation off** and the system's reduced-motion preference stop the movement while retaining the edge pose. Your voice preferences, microphone controls and ongoing conversations continue to work while KAI is moved.

### KAI finds a cute little voice

- **Cute KAI is the new character voice.** Bella with a brighter, higher, lightly squeaky character treatment. The **Squeak** slider in **Voice & listening** goes from Gentle to Extra squeaky. Pitch and pacing are handled separately, so a higher voice does not race through every word. Classic deeper KAI and the unprocessed voices remain available.
- **Hear it immediately.** With Bella selected, **Hear a hello** uses a tiny bundled recording and applies your current character settings. No model startup or download is needed for that preview. Conversations reuse the same local voice files you already installed; first-time setup still requires a click.
- **Start with the first sentence.** **Quick start** is now the default. KAI speaks the first complete sentence as soon as its audio is ready while preparing the next. It no longer waits for two sentences. **Extra buffering** remains an option for slower computers; pauses can still occur when local synthesis cannot keep up.
- **Stay ready to talk.** While KAI is visible with voice replies enabled, the installed voice engine stays loaded. Setup prepares the first-use speech components too. Hiding KAI or turning off voice replies stops the keep-warm requests; idle voice memory is released after two minutes. No background microphone use is added.

This update selects Cute KAI with Bella once. Your choices after that persist. Open **Voice & listening → Hear a hello** to try it. The reference guided the character's pitch and energy; this is an original local character treatment, not a clone or ElevenLabs connection. Voice generation and processing stay on your computer, with no new account, API key or subscription.

### Meet the new KAI

- **A new character, inspired by your reference.** Glossy white armor, a cobalt cape and headset, a K badge, and an expressive cyan face. KAI looks around, blinks, leans in to listen, thinks, nods while speaking and gives a cheerful greeting. The mouth still moves only during audible playback.
- **A brighter app, from end to end.** Pearl and soft blue surfaces, deep navy text, electric blue controls, a new app icon and clearer navigation groups. Chat, Documents, Compare, Models, Tools, Tasks, Earn, Settings, Code and the embedded wallet/node screens share the new design.
- **A proper welcome from KAI.** The new chat home has a character greeting and three starting points for questions, building and ideas. Clicking one puts a draft in the composer for you to edit and send. The source/model controls have their own row, with more space for your message.
- **A lighter desktop companion.** Matching white conversation and voice cards, blue controls and a clear green mic indicator. KAI still launches compact. Chat, listening, interruptions and voice preferences work as before.
- **Room for smaller windows.** A Conversations button opens chat history in narrow windows. Model controls, forms and cards resize with the workspace. Keyboard focus and reduced-motion preferences are supported.

Install over the existing **Koinos AI Test** app after quitting it from the tray. Your shared profile, chats, wallet, downloaded models, private desktop provider settings and live earning/node data stay in place. This is a visual revision; it adds no new computer permissions or automatic microphone use.

### Your own OpenAI or Anthropic connection

- **Settings → Desktop AI connections** now accepts your own OpenAI and Anthropic API keys. Save a connection, then **Test & refresh models**, or enter a model ID from your provider account. The connection check lists models; it does not generate a paid test reply.
- **Choose your source in Chat**, then choose a model. **Use in chat** opens that picker from Settings. The desktop KAI **Brain** picker also includes connected models. Chat, Research, Agent and KAI's app tools use your chosen provider, with streamed answers and Stop support.
- **Private to your desktop.** Keys use encrypted OS storage and are never returned to chat pages, included in network model lists, or used for earning jobs. These connections are unavailable through the local/public API, remote access, Teams or scheduled tasks. Provider failures stop the request without switching to another source.
- **Your provider account pays for usage.** Questions, conversation context, attachments and relevant app tool results go directly to the selected provider. Local-Only blocks these online requests; choose **Local API → Privacy → Local-First** to allow them. This does not require a network wallet for provider chat. Your earning node retains its existing models and data.

Your API key is separate from your ChatGPT or Claude app login. Models and access depend on your provider account. Choosing a provider does not change KAI's locally generated voice or local microphone transcription.

### Your app, a question away

- **KAI can use the app's tools.** Desktop conversations can search the web, read pages and use connected tools, memory, workspace files, email and calendar through the existing permissions. Web access follows Privacy settings; Local-Only stays offline. Include your city for weather, or KAI can ask for it.
- **Ask about your real app.** Check KAI balance and pending earnings, KOIN/VHP wallet balances, node health and recent KOIN rewards, installed/downloadable models, documents, saved chats, scheduled tasks and connection status. Unavailable or stale data is reported instead of being treated as zero.
- **Ask KAI to do things.** Model downloads/removal, earning controls, node start/stop, document editing, scheduled prompts and supported settings changes show a native **Allow once** dialog before running. Tool activity appears in the conversation; web sources are clickable.
- **“Open up the application.”** KAI can bring up the main app or a specific screen while staying available beside it. Financial transactions, wallet passwords/backups, Docker setup and coding sessions use the existing app forms and their approval steps. Disabled sections open Settings first.

Simple balance/model questions go straight to the relevant app data before answering. Other tool requests may take extra model steps. Stop or hiding KAI cancels pending approvals and further steps; an action the app has already accepted may keep running. KAI's voice, follow-ups, shared wallet and live node data remain in place.

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
