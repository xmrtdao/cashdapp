# Edge Function URLs

This file contains a list of known and used Edge Function URLs.

## Working Edge Function URLs

- `node C:\Users\PureTrek\Desktop\DevGruGold\suite\scripts\eliza-relay.mjs`: Command to interact with the cloud Eliza.
- `https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/agent-manager`: URL for the Agent Manager (assigning tasks to agents).
- `https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/task-orchestrator`: URL for the Task Orchestrator.
- `https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/system-status`: URL for the system status.
- `https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/community-spotlight-post`: This is the Edge function to post a community discussion highlight on GitHub.

## Potentially Working Edge Function URLs (Requires Further Testing)

- `https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/python-executor`: URL for the Python executor.
- `https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/create-suite-quote`: This function creates a quote in our VSCO system for a new potential licensing customer of our Suite AI service and requires parameters: company_name and contact_email.
- `https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/deepseek-chat`: This Edge function powers the chat for the CTO, likely requires input data, and I was unable to successfully call it with the available tools.
- `https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/ecosystem-monitor`: I was unable to successfully call this function due to network or other issues.

## WhatsApp Gateway Notes

The WhatsApp gateway may disconnect and reconnect periodically. This can potentially impact automated processes that rely on the gateway, such as the `task-digest` cron job. Further investigation is needed to understand the expected frequency of disconnections and to implement appropriate error handling or retry mechanisms.