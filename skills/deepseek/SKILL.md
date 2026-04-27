---
name: deepseek
description: >
  Query the DeepSeek V4 API endpoint for advanced reasoning or chat completion.
  Requires a valid DEEPSEEK_API_KEY in the environment.
---

# DeepSeek V4 Skill

## Usage

Send a chat completion request to the DeepSeek V4 endpoint.

### CURL Example (PowerShell)

```powershell
$headers = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $env:DEEPSEEK_API_KEY"
}
$body = @{
    model = "deepseek-chat"
    messages = @(
        @{ role = "user"; content = "Hello, DeepSeek!" }
    )
} | ConvertTo-Json
Invoke-RestMethod -Uri "https://api.deepseek.com/chat/completions" -Method Post -Headers $headers -Body $body
```

## Configuration

The skill expects `DEEPSEEK_API_KEY` to be configured in OpenClaw's environment or global config.
Endpoint: `https://api.deepseek.com/chat/completions` (DeepSeek Chat API).
