# KAI Brain, Workflows and Connections — Test guide

This update adds three entries near the top of KAI's sidebar. It uses the same Koinos AI Test profile and node. Quit the running app from its tray before installing an update; then reopen Test.

## Give KAI context

1. Open **Brain → Add a note**. Add a useful fact, preference, project, or person. Give it a clear title and optional tags. Pin only the facts that should stay prominent.
2. Open **Goals → Add a goal**. Record what matters, why it matters, and the next steps. High-priority active goals come first in KAI's reply context.
3. Use **Sources & sync → Import text file** for a TXT, Markdown, CSV or JSON file up to 200 KB. Re-importing the same file name updates that source. Use distinct names for unrelated files.
4. **Import previous memories** brings KAI's existing remembered facts into a separate Brain source. It does not remove the old memory store.
5. Ask a question about your note using a local model or your configured OpenAI/Anthropic model. Relevant Brain notes and active goals help the final answer. In Agent mode or desktop KAI, KAI can also search Brain explicitly and ask to remember new facts.
6. Use **Export Brain** to save a Markdown snapshot. Exports include your notes/source content and goals, not connection tokens. The exported file is readable text; store it where you want your personal material to live.

Turn off **Use Brain in replies** to pause automatic recall. Explicit Brain tools still work when you ask KAI to use them. Delete a note to remove it from this Brain; remove a source to remove its indexed sections. Existing chat transcripts and exports are separate records.

The memory map is an organized tree of categories and sources. It is not yet an automatically inferred relationship graph or an LLM-generated summary tree.

## Connect your own API

Open **Connections** and pick a starter profile. Paste your token in the password field. KAI encrypts it with the OS credential store. You can edit the operation list to match the permissions and endpoints you want.

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

For a Brain source, enable background reads, then open **Brain → Sources & sync → Add API source**. Select the connection, its GET operation, and path variables. Sync now or opt into the 20-minute schedule. The source stores the returned text/JSON locally; this version does not follow pagination automatically.

Local-Only privacy blocks these API requests. Change to Local-First in **Local API → Privacy** when you want to use online connections. API tokens are never forwarded to the inference provider or earning workers. Changing the API destination requires entering the token again.

Provider setup references: [GitHub API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user), [Notion API](https://developers.notion.com/reference/retrieve-a-block), [Slack auth check](https://docs.slack.dev/reference/methods/auth.test/), [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/).

## Build a useful workflow

1. Install a local chat model from **Model library** if you want reasoning steps. Scheduled workflows do not use your private OpenAI/Anthropic keys.
2. Open **Workflows** and choose **Project briefing**.
3. Review the three steps: search Brain, ask the local model for a briefing, and keep the result. Edit the instructions and select the installed model.
4. Leave the schedule manual for the first test. Save, then choose **Run** and enter the project name.
5. Open **Run history** to inspect the output of every step. A failed step shows a failure; KAI does not report it as completed.
6. Once the routine does what you need, edit it and choose hourly, every six hours, daily, or weekly. Daily/weekly schedules use this computer's local time. Enable the saved schedule.

| Step | What it does |
| --- | --- |
| Search Brain | Retrieves notes matching its text |
| Ask local model | Produces text from the supplied instructions and previous output |
| Call a connection | Executes a saved API operation with configured variables/body |
| Continue if text matches | Continues only if the previous output contains the supplied text, ignoring case |
| Wait for approval | Pauses until you review and resume |
| Save to Brain | Shows the exact memory text for approval before saving |
| Result | Records the final text in run history |

Use `{{input}}` for the text supplied when you click Run, and `{{previous}}` for the prior step's output. Scheduled runs have empty input, so put a fixed project name or topic in the Brain-search step before enabling a schedule.

**Describe a workflow to KAI** asks the selected local model to draft steps in the builder. Inspect them before saving. You can also ask the companion to propose a workflow; proposals remain disabled drafts until you review them. Model-generated drafts can be imperfect, especially with small local models.

API writes and save-memory steps wait in Run history. Choose **Review & resume** to approve once or **Cancel run** to stop. A workflow has only one running/paused run at a time. Completed steps have durable checkpoints. If KAI closes during an action, the next launch marks the run interrupted and refuses to replay an uncertain step automatically.

The desktop must remain open, including in the tray, for schedules and source sync. Sleeping or closed computers do not run jobs. Missed schedules are coalesced into a later run rather than replayed in a burst. A pending approval prevents that workflow from starting another run.

Existing single-prompt tasks remain under **Tasks**, also reachable from Workflows. Existing email, calendar and MCP connections remain under **Tools**. Private model keys remain under **Settings**, reachable from **Connections → Models & other tools**.

## First things to try for KAI

- Import a short project status file, ask KAI for the next three priorities, then correct one fact in Brain and ask again.
- Create a manual project briefing and inspect each step's output.
- Connect GitHub with a scoped token, test a read, then create a source for one repository's open issues.
- Create an API digest from that source. Review its output before enabling a schedule.
- Ask desktop KAI to remember a preference. Confirm the native prompt, then verify the new note in Brain.

Advanced graph branches, automatic entity relationships, a continuously edited Obsidian vault, OAuth setup, event triggers, automatic meeting attendance, messaging channels, and background reflection are documented in the [feature roadmap](KAI_COMPANION_ROADMAP.md); they are not claimed as implemented in this first Test revision.
