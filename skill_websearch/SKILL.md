---
name: websearch-gemini
description: Use Eliza, powered by gemini, to enable web searches when web search is unavailable, to summarize results, and other internet tasks.
---

# Gemini Web Search

This Skill uses the `eliza-relay` tool to perform web searches using the Gemini language model. It can be used when the `web_search` or `browser` tool are unavailable.

## Usage

To perform a web search, use the following prompt:

`Use eliza-relay and ask Eliza to perform a web search for [your search query here]. Then summarize the top results`. 

For example:

`Use eliza-relay and ask Eliza to perform a web search for "current weather in London". Then summarize the top results`

## Notes

* This skill relies on the `eliza-relay` tool being properly configured.
* The quality of the search results depends on the capabilities of Gemini.
