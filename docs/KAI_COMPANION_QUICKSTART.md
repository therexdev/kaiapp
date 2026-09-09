See the [expanded Brain and Awareness guide](KAI_BRAIN_AWARENESS.md) for the new sidebar, source types, background checks and Markdown vault.

# KAI Brain, Workflows and Connections — Test guide

This update adds three entries near the top of KAI's sidebar. It uses the same Koinos AI Test profile and node. Quit the running app from its tray before installing an update; then reopen Test.

## Give KAI context

1. Open **Brain → Add a note**. Add a useful fact, preference, project, or person. Give it a clear title and optional tags. Pin only the facts that should stay prominent.
2. Open **Goals → Add a goal**. Record what matters, why it matters, and the next steps. High-priority active goals come first in KAI's reply context.
3. Use **Sources → Import text file** for a TXT, Markdown, CSV or JSON file up to 200 KB. Re-importing the same file name updates that source. Use distinct names for unrelated files.
4. **Import previous memories** brings KAI's existing remembered facts into a separate Brain source. It does not remove the old memory store.
5. Ask a question about your note using a local model or your configured OpenAI/Anthropic model. Relevant Brain notes and active goals help the final answer. In Agent mode or desktop KAI, KAI can also search Brain explicitly and ask to remember new facts.
6. Use **Export Brain** to save a Markdown snapshot. Exports include your notes/source content and goals, not connection tokens. The exported file is readable text; store it where you want your personal material to live.

Turn off **Use Brain in replies** to pause automatic recall. Explicit Brain tools still work when you ask KAI to use them. Delete a note to remove it from this Brain; remove a source to remove its indexed sections. Existing chat transcripts and exports are separate records.

The memory map is an organized tree of categories and sources. It is not yet an automatically inferred relationship graph or an LLM-generated summary tree.

## Connect an app

1. Open **Connections → Connection settings** and choose **KAI-managed** or **My Composio key**. Managed mode requires KAI account sign-in and an enabled server; personal mode requires your project API key from [Composio settings](https://dashboard.composio.dev/).
2. Open **Explore apps**. Search by app name, use the category selector, and choose a logo card. The full catalog loads from your selected Composio project; featured apps remain visible before setup.
3. Click **Connect** and finish sign-in in your browser. Return to KAI; it checks for the new account for up to five minutes. **Open sign-in again** and **Check connection** are available if needed.
4. In **Manage access**, name the account and choose actions. **Use in conversations** makes selected actions available to private/local KAI with approval. **Allow reviewed actions** enables actions that can change data or have no verified read-only behavior.
5. Enable **Allow Brain and workflow reads** to use selected read actions as data sources. Choose **Collect into Brain**, pick the data/action, and fill the fields (for example repository owner and name). Optional refresh runs every 20 minutes while KAI is open. A result is bounded to 200 KB, so use filters/limits for large accounts.
6. **Connected** shows account status and selected actions. You can add several accounts from one app. Disconnecting removes that Composio connection and pauses its sources; previously collected Brain notes remain until you remove those sources.

Composio hosts provider authentication; some services ask for provider API keys or extra fields instead of OAuth sign-in. Available apps/actions and permissions depend on the project and provider. Tools without verified read-only behavior require review and cannot be used for background collection. KAI access selections are local grants, distinct from the provider's OAuth scopes selected during authorization. If an app requires a custom OAuth configuration, configure it in your Composio project first; KAI reuses an enabled configuration when available.

Personal mode encrypts your Composio key in Electron and sends selected requests directly to Composio. Managed mode keeps the project key on the KAI server, which handles selected requests/results in transit. Composio stores provider credentials in either mode. Changing modes does not move accounts between projects. Source data stays local to this Brain and does not enter compute-worker APIs; Local-Only blocks connection traffic.

Server setup is documented in [the KAI server guide](https://github.com/therexdev/kai/blob/claude/kai-production-website-fqx4pf/docs/CONNECTIONS.md). Real provider sign-in requires a valid key and your own authorization; it is not enabled automatically by installing Test.

## Connect your own API

Open **Connections → Custom APIs** and pick a starter profile. Paste your token in the password field. KAI encrypts it with the OS credential store. You can edit the operation list to match the permissions and endpoints you want.

| Profile | First request | Setup requirement |
| --- | --- | --- |
| GitHub | Read my profile | Your own personal access token; grant only the repository access needed for later operations |
| Notion | Check integration | Your integration token; share the pages you want it to access with that integration |
| Slack | Check token | Your Slack app token, installed in the workspace with the scopes for the chosen operations |
| Home Assistant | Check server | Your server base URL and long-lived access token; use HTTPS remotely or a loopback endpoint on this computer |
| Custom API | Read status | Your API base URL, token/key header, and a real supported operation path |

Use **Open & test → Run request** to verify a read. A path such as `/repos/{owner}/{repo}/issues` takes variables such as:

```json
{"owner":"therexdev","repo":"kaiapp"}
```

A write operation takes a JSON body. For example, GitHub's create-issue operation accepts:

```json
{"title":"Review KAI companion setup","body":"Check Brain, Workflows and Connections in Test."}
```

Running that write displays a native approval prompt with the actual destination and body. It sends the request only after approval. This guide does not create an issue or connect any account for you.

The two optional connection grants are separate:

- **Let KAI use these operations:** exposes the saved operations to the desktop companion and main chat's Agent mode. KAI asks before each call, including reads.
- **Allow background GET requests:** permits selected sources/workflow read steps to run without a new prompt. Only configure genuinely read-only operations with GET. Writes still pause for approval.

For a Brain source, enable background reads, then open **Brain → Sources → Add API source**. Select the connection, its GET operation, and path variables. Sync now or opt into the 20-minute schedule. The source stores the returned text/JSON locally; this version does not follow pagination automatically.

Local-Only privacy blocks these API requests. Change to Local-First in **Local API → Privacy** when you want to use online connections. API tokens are never forwarded to the inference provider or earning workers. Changing the API destination requires entering the token again.

Provider setup references: [GitHub API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user), [Notion API](https://developers.notion.com/reference/retrieve-a-block), [Slack auth check](https://docs.slack.dev/reference/methods/auth.test/), [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/).

## Build a useful workflow

See the full [Workflows guide](KAI_WORKFLOWS.md) for the canvas, Copilot, templates, typed nodes, schedules, app events, approvals and recovery.

1. Install a local chat model if you want Agent nodes.
2. Open **Workflows → Templates → Project briefing**.
3. Select and configure the Brain and Agent nodes. Connect any added nodes by their ports.
4. **Validate**, **Save workflow**, then **Run** with a project name.
5. Inspect **Run history** and use **View on canvas** for the saved graph.
6. After a successful manual run, configure the Trigger schedule and enable automatic triggers.

Existing scheduled Tasks move into Workflows without duplicating their timers. Their previous chat answers remain in Chat. Brain's personal task board remains separate. The desktop must be open for automation. App and Brain writes pause for exact native review; uncertain interrupted writes are not automatically replayed.

## First things to try for KAI

- Import a short project status file, ask KAI for the next three priorities, then correct one fact in Brain and ask again.
- Create a manual project briefing and inspect each step's output.
- Connect GitHub with a scoped token, test a read, then create a source for one repository's open issues.
- Create an API digest from that source. Review its output before enabling a schedule.
- Ask desktop KAI to remember a preference. Confirm the native prompt, then verify the new note in Brain.

The [feature roadmap](KAI_COMPANION_ROADMAP.md), [Brain coverage](OPENHUMAN_BRAIN_COVERAGE.md) and [Workflows coverage](OPENHUMAN_WORKFLOW_COVERAGE.md) distinguish implemented behavior from remaining concepts such as automatic meeting attendance, a continuously edited Obsidian vault and general multi-agent orchestration.

KAI includes version-pinned read actions for GitHub, Gmail, Google Calendar, Google Drive, Notion, and Slack. These appear first in access settings. They were checked against Composio’s published action descriptions. A changed version requires review unless Composio supplies explicit read-only metadata. You can search the full action catalog as well.
