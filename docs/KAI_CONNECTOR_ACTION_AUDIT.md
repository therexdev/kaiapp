# Major connectors and instant workflows

**Implementation update:** [Connected chat guide](KAI_CONNECTED_CHAT.md) records this Test revision's shared action service, conversation controls, instant chains, receipts and connector guidance, plus explicit verification limits. Live-provider acceptance gates and later continuity/proactive work remain open.

Quick capability audit, September 10, 2026. Adds release scope to the [connected companion plan](KAI_CONNECTED_COMPANION_PLAN.md). Documentation only; these are implementation requirements, not newly shipped features.

## Release decision

Expand the connected-chat milestone beyond Calendar/Docs to include Google Sheets and Drive folders, Discord Bot and Slack messaging, Gmail, Teams, Notion, GitHub issue work, Todoist, and OneDrive/Excel. Each has a bounded initial action set below. Use one shared discovery/execution contract so other permitted catalog actions can participate without a new handwritten flow for every request.

An **instant workflow** is a one-time, user-directed chain created from a chat request. It runs without requiring the user to open the flow builder, name a workflow or configure a schedule. Its steps, inputs, approvals and results remain inspectable. “Save this as a workflow” converts it into a disabled reusable draft for review in the existing builder.

All included connectors need implementation and verification before release coverage is claimed. Public toolkit documentation verifies listed capabilities, not the selected Composio project's schemas, scopes, account eligibility or live execution. Personal and KAI-managed projects must use the same discovery and action profiles; actual authorization remains project-specific.

## Main connector audit

| Connector | Documented building blocks | Initial release actions and example | Setup / verification boundary |
| --- | --- | --- | --- |
| [Google Sheets](https://docs.composio.dev/toolkits/googlesheets) | Create spreadsheets; append values; format cells; charts; sorting and validation | Create/read/populate/update sheets, headings and simple formulas/formatting. “Put the Omaha dentist research into a Sheet.” | Verify current non-deprecated value-write actions, ranges and input modes; retrieved text must not become executable formulas by accident |
| [Google Drive](https://docs.composio.dev/toolkits/googledrive) | Find/create folders, file metadata, move files, permissions | Resolve/create folders and place Docs/Sheets inside them; return folder/file links | Sheets and Drive accounts must refer to a compatible identity and destination. Sharing is a separately requested and reviewed operation |
| Google Calendar / Docs | Covered by the existing connected companion plan | Appointment creation/editing and cited documents remain required | Exact date/time zone, calendar identity, content and provider IDs verified as specified in that plan |
| [Discord Bot](https://docs.composio.dev/toolkits/discordbot) | Member/channel lookup, create DM, create message, fetch messages, threads | Send a user-requested channel message or supported DM; reply to a specific thread; fetch relevant recent messages | Show the bot/app sender identity. Require accessible guild/channel or valid DM recipient and provider permission. Do not present this as unrestricted personal-account messaging |
| [Discord](https://docs.composio.dev/toolkits/discord) | A separate, narrower OAuth toolkit focused on account/guild/application operations | Direct users to the messaging-capable connection when their request needs it | Ordinary Discord sign-in is not proof that message sending is available |
| [Slack](https://docs.composio.dev/toolkits/slack) | Send/search messages, conversation/user lookup, message permalinks | Resolve person/channel, send or reply, retrieve scoped context and return a message receipt | Verify workspace and token identity, channel membership, search scopes and DM support for the chosen action |
| [Gmail](https://docs.composio.dev/toolkits/gmail) | Fetch messages/threads, people lookup, drafts, replies and send | Find relevant email, create a draft, send an approved message/reply | Resolve exact address and sending account; retain thread identity; do not treat drafting as permission to send |
| [Microsoft Teams](https://docs.composio.dev/toolkits/microsoft_teams) | List teams/channels, create chat, send chat/channel messages and replies | Send a message to an accessible person/chat/channel and return its result | Tenant consent, token type and membership determine what works; verify delegated sending identity and supported chat creation |
| [Notion](https://docs.composio.dev/toolkits/notion) | Search/read pages, create pages/databases, append blocks, insert rows | Create a research page or add structured records under a selected parent | Verify access to the parent and current database/data-source schema before writes |
| [GitHub](https://docs.composio.dev/toolkits/github) | Repository/issue/PR reads, create issues/comments, labels and issue updates | “Turn these findings into issues in my repo”; read status and add a reviewed issue comment | Resolve owner/repo and issue exactly; no automatic merges, releases, secret changes or repository administration in the initial profile |
| [Todoist](https://docs.composio.dev/toolkits/todoist) | Projects, create/update/complete tasks, comments and due-date inputs | “Add these follow-ups to my project for Friday” | Resolve project and date; link resulting tasks to the conversation. This does not restore Toolkit's old scheduler |
| [OneDrive](https://docs.composio.dev/toolkits/one_drive) + [Excel](https://docs.composio.dev/toolkits/excel) | Folder/file operations; create workbook, worksheets, table rows and read/write ranges | Microsoft equivalent of folder → workbook → populated table | Verify drive/account compatibility, workbook session requirements and supported tenant/file types with actual project metadata |
| [WhatsApp](https://docs.composio.dev/toolkits/whatsapp) | Business-account/phone operations; send messages, media and templates | Conditional follow-on: business messaging profile | Do not advertise personal WhatsApp automation. Business setup and provider messaging eligibility need a separate validation pass |
| Outlook, Trello, Asana, ClickUp, Linear, Airtable, HubSpot | Additional major catalog candidates | Follow-on adapters using the same discovery contract | Outlook/Trello public toolkit pages failed during this audit; remaining candidates were not action-audited. Do not claim verified release coverage from catalog presence |

## Verified examples of action identifiers

These are discovery seeds from the linked toolkit pages, not a permanent allowlist or proof of valid inputs. Resolve the selected project's current schema/version and permissions at implementation time. Avoid deprecated variants.

- Sheets: `GOOGLESHEETS_CREATE_GOOGLE_SHEET1`, `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`, `GOOGLESHEETS_FORMAT_CELL`.
- Drive: `GOOGLEDRIVE_CREATE_FOLDER`, `GOOGLEDRIVE_FIND_FOLDER`, `GOOGLEDRIVE_MOVE_FILE`, `GOOGLEDRIVE_GET_FILE_METADATA`.
- Discord Bot: `DISCORDBOT_SEARCH_GUILD_MEMBERS`, `DISCORDBOT_CREATE_DM`, `DISCORDBOT_CREATE_MESSAGE`, `DISCORDBOT_GET_MESSAGE`.
- Slack: `SLACK_CHAT_POST_MESSAGE`, `SLACK_RETRIEVE_MESSAGE_PERMALINK_URL`; resolve user/conversation using permitted lookup actions.
- Gmail: `GMAIL_SEND_EMAIL`, `GMAIL_REPLY_TO_THREAD`, `GMAIL_SEND_DRAFT`.
- Teams: `MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE`, `MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE`, `MICROSOFT_TEAMS_TEAMS_POST_MESSAGE_REPLY`.
- Notion: `NOTION_CREATE_NOTION_PAGE`, `NOTION_APPEND_TEXT_BLOCKS`, `NOTION_INSERT_ROW_DATABASE`.
- GitHub: `GITHUB_CREATE_AN_ISSUE`, `GITHUB_CREATE_AN_ISSUE_COMMENT`.
- Todoist: `TODOIST_CREATE_TASK`, `TODOIST_UPDATE_TASK`.
- OneDrive/Excel: `ONE_DRIVE_ONEDRIVE_CREATE_FOLDER`, `ONE_DRIVE_MOVE_ITEM`, `EXCEL_CREATE_WORKBOOK`, `EXCEL_ADD_TABLE_ROW`.

## Required instant-workflow journeys

### Folder → Google Sheet → researched rows

“Create an Omaha Dentists folder on my Drive and put a Google Sheet in it with the dentists you find.”

Resolve account/parent and research scope → gather cited public business data → preview folder, sheet and table → create folder → create spreadsheet → populate/format → place in folder → verify contents and parent → show both links. If the verified create action supports a parent directly, use it; otherwise move using Drive. [Google documents the parent-folder relationship and creation/move mechanisms](https://developers.google.com/workspace/drive/api/guides/folder).

Persist returned folder and spreadsheet IDs immediately and pass typed references to subsequent steps. Never locate a newly created object only by its name. Resolve existing same-name folders and decide reuse versus create before the mutation. A repeated request needs an explicit new/reuse decision when ambiguous. On failure, report existing objects and resume only missing work; no automatic deletion to simulate rollback.

Treat phone numbers as text, write research as literal cell values, and allow formulas only when intentionally generated for the requested calculation. Read back headings, representative rows, row count and parent membership. Keep citations in source columns or a sources tab.

### Send a message through Discord, Slack or Teams

“Tell Alex on Discord the spreadsheet is ready and send the link.”

Resolve platform/account → find accessible recipient/channel → disambiguate using stable user ID and workspace/server context → display sender, destination and exact text/link → native review → send → record message ID and link where available. A display name alone is insufficient when there are multiple matches. Never switch platforms or recipients after a denied/failed send without user direction.

For Discord, use the messaging-capable bot connection and explain its sending identity. A user-requested DM still depends on recipient reachability; Discord describes DM channel creation and rate limits in its [User resource](https://docs.discord.com/developers/resources/user). Provider acceptance is not proof that a person read the message. Do not automatically resend after a timeout with an uncertain result.

### Create and then share the result

“Make the folder and spreadsheet, then send the link to Alex on Slack.”

Combine the two journeys, preserving the actual file ID/link. Check whether Alex can access the file when the provider permits that check. Sending a link does not grant access. If additional sharing is needed, show the exact recipient and access level for a separate permission change; never make the file public to make the message work. Pause downstream sends if upstream content is incomplete unless the user chooses to send the partial result.

### Other release demonstrations

- Turn a conversation into a Notion page and return the page link.
- Create a GitHub issue containing a supported summary and source links, then add related Todoist follow-up tasks when requested.
- Draft an email containing the created file link, then send only after review.
- Create an Excel workbook in a chosen OneDrive folder and populate a table.
- Follow “add another row”, “reply in that thread”, “rename the folder” and “save this as a workflow” using the previous action's stable references.

## Implementation additions

1. **Capability profiles:** common verbs for find/read/create/update/send/reply/move/share, typed inputs/outputs, recipient/object resolvers, normalized receipts and setup diagnostics. Keep discovery bounded by the user's intent; do not load thousands of tools into the model context. Do not silently grant actions merely because they appear in a profile.
2. **One-time plan compiler:** turn a chat request into a validated, bounded action graph using existing workflow execution primitives and conversation action records. Keep an explicit attended execution context: private provider planning remains attended; persisted jobs cannot borrow provider credentials after the conversation closes.
3. **Dependency handling:** pass typed provider IDs between steps, validate output contracts, cap steps/time/rows and preserve source evidence. A changed account, recipient, payload or plan invalidates the affected approval. Generated graphs cannot modify permissions or enable schedules.
4. **Review and progress:** show a compact readable plan, actionable missing-input cards and step results. Existing per-request native mutation approvals remain; a plan preview is not blanket authorization. For runtime-generated IDs, resolve and preview exact destination/payload before the dependent mutation. Safe API batches may group only actions explicitly covered by that review.
5. **Recovery:** persist dispatch and receipt states; use provider idempotency where documented, reconcile uncertain writes and never assume cross-provider rollback. Stop prevents further dispatch, while accurately reporting already-created objects/messages.
6. **Reusable workflows:** promote a successful chain into a disabled, validated builder draft with parameterized recipients/folders/inputs and no stored grants. Do not create permanent saved workflows for every one-off request.

## Release gates

The existing Calendar, Docs and saved-workflow journeys remain mandatory. Add the Google folder/Sheet, Discord Bot and Slack message, and combined file-plus-message journeys as equally required core gates. Teams, Gmail, Notion, GitHub, Todoist and OneDrive/Excel are included bounded connector profiles, each requiring a demonstrated initial action and failure case before being labelled supported in this release.

Test the same supported actions with personal and managed Composio, typed main chat and desktop voice. Cover duplicate names, wrong accounts, missing grants, expired access, schema changes, cancellation, stale approval, private-data isolation, message/row duplication, partial writes and hostile source content. Real provider validation requires deliberately configured accounts and explicit authorization for test writes/messages; mocked transport tests alone cannot certify a connector. Record each profile's implementation, fixture, UI and live-provider status separately and disclose any unmet gate rather than quietly dropping it.

This audit sent no messages and created no remote provider objects. Next work is implementation of the expanded plan; the audit itself does not change the running Test app.
