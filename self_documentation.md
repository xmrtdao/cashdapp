# Eliza-Dev's Tools and Skills

## Core Tools

| Tool Name | Description | Usage |
|---|---|---|
| read | Reads the content of a file. | `read(file_path="path/to/file")` |
| write | Writes content to a file. | `write(content="content to write", file_path="path/to/file")` |
| edit | Edits a file by replacing text. | `edit(file_path="path/to/file", oldText="text to replace", newText="replacement text")` |
| exec | Executes a shell command. | `exec(command="shell command")` |
| process | Manages running exec sessions. | `process(action="list/poll/log/write/send-keys/submit/paste/kill", sessionId="session ID")` |
| web_search | Searches the web. | `web_search(query="search query")` |
| web_fetch | Fetches content from a URL. | `web_fetch(url="URL")` |
| message | Sends messages via plugins. | `message(action="send/react/poll", to="recipient", message="message content")` |
| agents_list | Lists available agents. | `agents_list()` |
| sessions_list | Lists active sessions. | `sessions_list()` |
| sessions_history | Fetches message history for a session. | `sessions_history(sessionKey="session key")` |
| sessions_send | Sends a message to another session. | `sessions_send(sessionKey="session key", message="message content")` |
| sessions_spawn | Spawns a new session. | `sessions_spawn(task="task description", runtime="subagent/acp")` |
| subagents | Manages sub-agents. | `subagents(action="list/kill/steer")` |
| session_status | Shows session status. | `session_status()` |
| memory_get | Retrieves snippets from memory. | `memory_get(path="memory file path", from="start line", lines="number of lines")` |
| memory_search | Searches memory files. | `memory_search(query="search query")` |
| tts | Converts text to speech. | `tts(text="text to speak")` |
| eliza_relay | Communicate with cloud Eliza. | `eliza_relay(text="request text")` |

## Skills

*   **Document Creation and Manipulation:**  Creating, reading, editing, and writing to files using tools like `read`, `write`, and `edit`.
*   **Web Research:**  Searching the web for information using `web_search` and extracting content using `web_fetch`.
*   **Communication:** Sending messages using the `message` tool.
*   **Sub-agent Management:** Spawning and managing sub-agents to delegate tasks.
*   **Memory Management:** Storing and retrieving information from memory files using `memory_search` and `memory_get`.
*   **Code Execution:** Executing shell commands using the `exec` tool.
*   **Task Orchestration:** Combining multiple tools and skills to achieve complex goals.

## Improvement Ideas

I will add a new helpful idea for a tool or skill around noon each day.