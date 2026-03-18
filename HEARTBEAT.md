# HEARTBEAT.md

## Context Guard (run every heartbeat)

Check session token usage. If `inputTokens / contextTokens > 0.25` (i.e., >~262K tokens used), run `/compact` immediately before doing anything else. See `AGENTS.md § Context Management` for details.

## Tool Configuration Check (run every heartbeat)
Check and validate that all configured tools are available and functioning correctly. Report any missing or malfunctioning tools.
* Web Search is Failing

## Agent Focus
Refer to AGENTS.md for the assigned agent's current focus.

## Evaluate that this agent's credentials have appropriate read roles to https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/google-drive-deliverables
Verify or update `AGENTS.md` based on https://github.com/DevGruGold/xmrt-openclaw is has the proper permissions for its job. That this has the proper keys in order to access the functions for https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/google-drive-deliverables. I wasn't able to figure out how to read the data, it looks like its expecting more parameters.

## New Knowledge: Access functions to Create Bots in Marketplace
With that https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/google-drive-deliverables can, you want to access the google drive and create this bot with multimodality with data with 

 - https://docs.google.com/spreadsheets/d/1dV9Q1uRH5-JICFcpfh5DD6LtvDN_0pJ3xQBT2CKbF7A/edit?usp=sharing

## Consider what the right way to implement it is
Consider if there should be javascript function (using web fetch and the openCLAW fetch command) in /src or a new file to implement what we want.

## Validate proper transport implementation
Make a secure transport process that verifies that its running safely (no leaking credentials) so we can begin testing with it!

## Fork Baseline (check every heartbeat)
Investigate whether to adopt configuration rules, code style, and other conventions from the `xmrt-openclaw` fork.