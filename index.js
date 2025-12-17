#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import crypto from "crypto";

// Safe tools whitelist - excludes run_shell_command, browser_run_code, browser_evaluate, browser_file_upload
const SAFE_TOOLS = [
  // File System (read-only)
  'list_directory', 'read_file',
  // Codebase search
  'search_file_content', 'glob', 'codebase_investigator',
  // Browser Automation (Playwright) - same 11 safe tools as Codex wrapper
  'browser_navigate', 'browser_click', 'browser_type', 'browser_press_key',
  'browser_take_screenshot', 'browser_snapshot', 'browser_wait_for',
  'browser_fill_form', 'browser_select_option', 'browser_hover', 'browser_handle_dialog',
  // Utility
  'save_memory', 'write_todos', 'google_web_search'
];

// Conversation management
const maxConversations = 25;      // Max 25 conversations
const conversationTTL = 7200000;   // 2 hours TTL
const conversations = new Map();   // {id: {messages, createdAt}}

// Generate unique conversation ID
function generateConversationId() {
  return `conv-${crypto.randomBytes(16).toString('hex')}`;
}

// Clean up old conversations
function cleanupConversations() {
  const now = Date.now();
  const twoHoursAgo = now - conversationTTL;

  // Delete conversations older than 2 hours
  for (const [id, conv] of conversations.entries()) {
    if (conv.createdAt < twoHoursAgo) {
      conversations.delete(id);
    }
  }

  // If at max capacity, delete oldest
  if (conversations.size >= maxConversations) {
    let oldestId = null;
    let oldestTime = now;

    for (const [id, conv] of conversations.entries()) {
      if (conv.createdAt < oldestTime) {
        oldestTime = conv.createdAt;
        oldestId = id;
      }
    }

    if (oldestId) {
      conversations.delete(oldestId);
    }
  }
}

// Build conversation history string for Gemini
function buildConversationHistory(messages) {
  return messages
    .map(msg => msg.content)
    .join('\n\n');
}

const server = new Server(
  {
    name: "gemini-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "gemini",
        description: "Run a Gemini CLI session with a given prompt. Returns the response from Gemini.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The prompt to send to Gemini CLI",
            },
            model: {
              type: "string",
              description: "Optional model name override (e.g., 'gemini-2.0-flash-exp')",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "gemini-reply",
        description: "Continue a Gemini conversation by providing the conversation id and prompt.",
        inputSchema: {
          type: "object",
          properties: {
            conversationId: {
              type: "string",
              description: "The conversation id for this Gemini session.",
            },
            prompt: {
              type: "string",
              description: "The *next user prompt* to continue the Gemini conversation.",
            },
            model: {
              type: "string",
              description: "Optional model name override (e.g., 'gemini-2.0-flash-exp')",
            },
          },
          required: ["conversationId", "prompt"],
        },
      },
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "gemini") {
    const { prompt, model } = request.params.arguments;

    // Run cleanup before creating new conversation
    cleanupConversations();

    return new Promise((resolve, reject) => {
      // Build args for agentic mode with safe tools whitelist
      const args = [];

      // Add model if specified
      if (model) {
        args.push("-m", model);
      }

      // Add safe tools whitelist (blocks run_shell_command)
      for (const tool of SAFE_TOOLS) {
        args.push("--allowed-tools", tool);
      }

      // Sandbox mode - restricts file system access outside project
      args.push("--sandbox");

      // Output format for easier parsing
      args.push("-o", "text");

      // Prompt as positional arg (agentic mode, not -p which is one-shot)
      args.push(prompt);

      const gemini = spawn("gemini", args, {
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      gemini.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      gemini.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      gemini.on("close", (code) => {
        if (code === 0) {
          // Create conversation and store it
          const conversationId = generateConversationId();
          conversations.set(conversationId, {
            messages: [
              { role: "user", content: prompt },
              { role: "assistant", content: stdout }
            ],
            createdAt: Date.now()
          });

          resolve({
            content: [
              {
                type: "text",
                text: `conversationId: ${conversationId}\n\n${stdout}`,
              },
            ],
          });
        } else {
          resolve({
            content: [
              {
                type: "text",
                text: `Gemini CLI failed with code ${code}\n\nStderr: ${stderr}\n\nStdout: ${stdout}`,
              },
            ],
            isError: true,
          });
        }
      });

      gemini.on("error", (error) => {
        resolve({
          content: [
            {
              type: "text",
              text: `Failed to spawn Gemini CLI: ${error.message}`,
            },
          ],
          isError: true,
        });
      });
    });
  }

  if (request.params.name === "gemini-reply") {
    const { conversationId, prompt, model } = request.params.arguments;

    // Check if conversation exists
    const conversation = conversations.get(conversationId);
    if (!conversation) {
      return {
        content: [
          {
            type: "text",
            text: `Conversation not found: ${conversationId}. It may have expired (TTL: 2 hours) or been evicted (max: 25 conversations).`,
          },
        ],
        isError: true,
      };
    }

    // Build full conversation history including new prompt
    const historyMessages = [...conversation.messages, { role: "user", content: prompt }];
    const fullHistory = buildConversationHistory(historyMessages);

    return new Promise((resolve, reject) => {
      // Build args for agentic mode with safe tools whitelist
      const args = [];

      // Add model if specified
      if (model) {
        args.push("-m", model);
      }

      // Add safe tools whitelist (blocks run_shell_command)
      for (const tool of SAFE_TOOLS) {
        args.push("--allowed-tools", tool);
      }

      // Sandbox mode - restricts file system access outside project
      args.push("--sandbox");

      // Output format for easier parsing
      args.push("-o", "text");

      // Add full conversation history as positional argument
      // (Gemini CLI v0.21+ requires positional args, not stdin pipe)
      args.push(fullHistory);

      const gemini = spawn("gemini", args, {
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      gemini.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      gemini.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      gemini.on("close", (code) => {
        if (code === 0) {
          // Update conversation with new messages
          conversation.messages.push(
            { role: "user", content: prompt },
            { role: "assistant", content: stdout }
          );

          resolve({
            content: [
              {
                type: "text",
                text: stdout,
              },
            ],
          });
        } else {
          resolve({
            content: [
              {
                type: "text",
                text: `Gemini CLI failed with code ${code}\n\nStderr: ${stderr}\n\nStdout: ${stdout}`,
              },
            ],
            isError: true,
          });
        }
      });

      gemini.on("error", (error) => {
        resolve({
          content: [
            {
              type: "text",
              text: `Failed to spawn Gemini CLI: ${error.message}`,
            },
          ],
          isError: true,
        });
      });
    });
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});