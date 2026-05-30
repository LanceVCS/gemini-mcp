# Gemini CLI-based MCP Server

An MCP server implementation that wraps the Gemini CLI to add multi-turn conversation support, so your agent can hold a stateful back-and-forth with Google's Gemini models.

## Problem Solved

The Gemini CLI is stateless in headless mode (`gemini -p "..."`) — each invocation starts a fresh context with no memory of previous turns, so a conversation can't naturally be continued. This server keeps conversation history in memory and replays it on each turn, giving reliable multi-turn sessions through a single `conversationId`.

## How It Works

1. Acts as an MCP server (speaks JSON-RPC protocol)
2. Translates MCP `gemini` tool calls to headless `gemini -p` CLI commands
3. Runs Gemini sandboxed and read-only (`--approval-mode plan --sandbox`) — write and shell tools are blocked
4. Stores each exchange under a generated `conversationId` (in-memory, 2-hour TTL, max 25 conversations)
5. Translates MCP `gemini-reply` calls into a fresh CLI run with the full prior history replayed as context

## Prerequisites

- Node.js 14.0 or higher
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and configured
- Claude Code installed

## Installation

1. Clone the repository to the standard MCP servers location:
   ```bash
   git clone <repo-url> ~/.claude/mcp-servers/gemini-mcp
   cd ~/.claude/mcp-servers/gemini-mcp
   npm install
   ```

2. Add the MCP server to Claude Code:

   ```bash
   # Add the server to Claude Code
   claude mcp add --transport stdio gemini -- node ~/.claude/mcp-servers/gemini-mcp/index.js

   # Verify it's installed
   claude mcp list
   ```

You should see `gemini` in the list with a ✓ Connected status.

**Note:** The server will be available in your next Claude Code session. If you're in an active session, restart it to load the new MCP tools.

## Usage

Once configured, use the MCP tools as normal. The first call returns a `conversationId`:

```
conversationId: conv-abc123...

Here's the answer...
```

Agent extracts the ID and uses it for followups:

```javascript
mcp__gemini__gemini-reply({
  conversationId: "conv-abc123...",
  prompt: "follow-up question"
})
```

Conversations are held in memory — they auto-expire after 2 hours, and the oldest is evicted once 25 are active.