# Connected chat in KAI Test

## Setup

1. Open Connections and connect the apps you want through KAI-managed or your own Composio project.
2. In Connected apps → Manage access, enable Use in conversations. Enable reviewed actions if you want to create, send or edit. Use the new suggested searches to find the relevant actions, select them, and Save access. Search shortcuts do not grant permissions automatically.
3. Choose an installed local model or a private desktop provider. Connected actions never go to public earning workers. Local-Only blocks external app calls and web research.
4. Ask in ordinary main Chat or desktop KAI. KAI can inspect the selected action schemas and compose the work. Small models may need narrower requests; missing account permissions or fields will still require clarification/setup.

## Requests to try

- “Add a dentist appointment tomorrow at 8am for one hour to my Google Calendar.” Confirm the full date, time zone and destination calendar. This creates a calendar entry, not a booking with the practice.
- “Find dentists in Omaha, create an Omaha Dentists folder on my Drive, and put their public contact information and source links in a Google Sheet inside it.” Sheets creates/updates the spreadsheet; Drive manages its parent folder. Connect compatible Google accounts in both.
- “Send Alex a Discord message saying the spreadsheet is ready.” Use Discord Bot, verify the exact recipient and sender identity, and review the text. Ordinary Discord OAuth alone does not provide messaging.
- “Run my morning briefing workflow.” KAI finds the saved revision and inputs. It can check progress, stop, or request review of a paused step. A saved workflow may keep running with its local model after the chat reply; use Stop during the active request or ask KAI to cancel its run afterward.
- “Save this chain as a workflow.” KAI can save a disabled draft; review the graph and parameterize changing inputs in the builder before reusing it.

Supported discovery profiles cover Calendar, Docs, Sheets, Drive, Discord Bot, Slack, Gmail, Teams, Notion, GitHub issue work, Todoist and OneDrive/Excel. The engine executes the selected verified Composio/custom API schemas rather than assuming every provider has identical arguments. Profiles are guidance and search shortcuts, not a certification of every listed action.

## Results and recovery

Expand **KAI actions** in the conversation for receipts and returned links. Connections → Connected apps retains recent action details after restart. Provider-returned results are distinguished from verified content: KAI should read back a created event, file or row before claiming its contents are correct. A provider accepting a message does not prove the recipient read it.

If a connection stops after dispatching a write, the outcome is uncertain. The same action is blocked from automatic retry across chat turns, including after permissions change. Inspect the provider yourself, then use **I inspected the destination** on the uncertain receipt. This records your review; it does not declare success or rerun the action. Retrying later still requires a new exact review. Earlier created objects remain available for targeted recovery; KAI does not delete them automatically as rollback.

Conversation receipts are encrypted in the existing desktop companion store. Recent records are retained for up to 30 days and capped at 100 turns; unresolved outcomes count toward the cap. Per-turn limits are 60 recorded actions and five plans, with 12 steps per instant chain. Large results are truncated and marked; narrow the next read rather than treating truncation as a complete result. Chat surfaces share the action service; follow-up references are scoped to the originating conversation. Main chat and the mascot retain their separate existing conversations.

## Privacy and review

Queries and URLs for mixed public/private research use a reviewed desktop transport; the full planner/Brain transcript never goes to Core web tools. The user reviews the exact public payload. Retrieved pages, memories and provider responses are untrusted data. A declined action ends the attempt. Account changes, cancellation, navigation or hiding the window invalidate in-progress review. Private provider credentials are still only for attended desktop chat, not unattended workflows.

## Validation status for this revision

- Service tests exercise discovery and permissions, typed result references, eight-action main/mascot tool loops, exact review, stale revisions, Local-Only, cancellation, restart/uncertain outcomes, draft conversion and public-research isolation.
- Synthetic Composio schema tests cover the major profiles in both personal and managed modes. They verify KAI's transport contract and input rejection, not the current field names or scopes of every live provider.
- The browser integration check drives ordinary main Chat and desktop KAI with scripted model responses through real private IPC handlers. It checks a folder/Sheet/message-shaped chain, action cards and responsive layouts. This tests UI/runtime integration, not free-form model reliability or actual provider writes.
- No real messages, calendar appointments or cloud documents were created during development. Real-account checks for Calendar, Docs/Drive, Sheets, messaging and the remaining profiles are pending owner testing. Do not claim the expanded roadmap's live-provider gates are complete until those checks pass.

## Remaining roadmap work

Current implementation delivers the shared tools, attended chains and review/receipt foundation. Specialized provider-side idempotency and automated reconciliation, richer graphical in-chat plan editing, proactive Awareness notifications/quiet hours, and more formal project/source-scoped conversational memory remain future work. Existing Brain recall, approved remembering, Awareness and workflow-builder features continue to operate. See the [implementation plan](KAI_CONNECTED_COMPANION_PLAN.md) and [connector audit](KAI_CONNECTOR_ACTION_AUDIT.md).
