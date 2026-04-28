## Proactive Checks
- Check the status of assigned tasks (e.g., those for antigravity-laptop-device, openclaw-main, or my own internal tasks). Are there any `BLOCKED` or `FAILED` tasks? - Use `openclaw status` and contact user if `BLOCKED` or `FAILED`
- Briefly review relevant system/edge function logs for critical errors, warnings, or anomalies (especially concerning task management).
- Prioritize `MEMORY.md` review and updates.
- Check the status of local repositories for uncommitted changes or pending merges.
= For LLM Use DEEPSEEK_API_KEY first
base_url	https://api.deepseek.com
api_key	sk-7e1c19bc87e946d8b225841c028832a8
model*	deepseek-v4-flash
deepseek-v4-pro
deepseek-chat (to be deprecated on 2026/07/24)
deepseek-reasoner (to be deprecated on 2026/07/24)
* The model names deepseek-chat and deepseek-reasoner will be deprecated on 2026/07/24. For compatibility, they correspond to the non-thinking mode and thinking mode of deepseek-v4-flash, respectively.

Invoke The Chat API
Once you have obtained an API key, you can access the DeepSeek model using the following example scripts in the OpenAI API format. This is a non-stream example, you can set the stream parameter to true to get stream response.

For examples using the Anthropic API format, please refer to Anthropic API.

curl
python
nodejs
curl https://api.deepseek.com/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -d '{
        "model": "deepseek-v4-pro",
        "messages": [
          {"role": "system", "content": "You are a helpful assistant."},
          {"role": "user", "content": "Hello!"}
        ],
        "thinking": {"type": "enabled"},
        "reasoning_effort": "high",
        "stream": false
      }'