# Building Custom Tools

The `agent-coworker` toolbelt is designed to be extensible. Developers can build and add custom tools to enable new capabilities for the agent. This guide explains how tools are structured, registered, and how to implement essential features like security approvals, cancellation, and logging.

## Tool Structure and Registration

Custom tools are implemented in the `src/tools/` directory. Each tool should ideally be contained in its own file (e.g., `src/tools/myCustomTool.ts`) and export a function that returns the tool definition.

Once a tool is created, it must be registered in the core toolbelt by adding it to the `createTools` function inside `src/tools/index.ts`.

```typescript
// src/tools/index.ts
import { myCustomTool } from './myCustomTool';
import type { ToolContext } from './types';

export function createTools(ctx: ToolContext) {
  return {
    // Built-in tools
    bash: bashTool(ctx),
    read: readTool(ctx),
    // ...
    
    // Your custom tool
    myCustomTool: myCustomTool(ctx),
  };
}
```

## Vercel AI SDK and Zod

Tools are built using the Vercel AI SDK `tool()` wrapper. This wrapper provides a standard interface for defining the tool's description, parameters (using Zod for schema validation), and the execution logic.

The `parameters` property (the `inputSchema`) ensures that the agent provides correctly typed arguments before the tool's execution function is invoked.

## The `ToolContext` Object

Every tool is passed a `ToolContext` object (`ctx`). This context bridges the tool with the underlying system, providing access to logging, security mechanisms, and execution control.

### Security and Approvals: `ctx.approveCommand()`

For tools that perform potentially destructive or sensitive actions (like executing terminal commands, modifying infrastructure, or sending emails), you must enforce the WebSocket-based command approval mechanism.

Call `await ctx.approveCommand(descriptionOfAction)` before performing the action. This will pause the tool execution and prompt the user in the TUI/CLI for approval.

- If the user approves (or if the `--yolo` flag is active), the function resolves and execution continues.
- If the user denies the request, an error is thrown, halting the tool execution safely.

### Handling Cancellations: `ctx.abortSignal`

Tool executions can be cancelled by the user mid-flight. Always check `ctx.abortSignal?.aborted` during long-running operations or loops to ensure the tool stops processing promptly when cancelled.

### Logging: `ctx.log()`

Use `ctx.log(message)` to stream execution logs back to the user interface. This is crucial for providing real-time feedback on the tool's progress, especially for tools that take a long time to complete or have multiple steps.

## Code Example: A Simple Custom Tool

Here is a complete example of a custom tool demonstrating these concepts:

```typescript
// src/tools/myCustomTool.ts
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolContext } from './types'; 

export function myCustomTool(ctx: ToolContext) {
  return tool({
    description: 'A custom tool that simulates a long-running, sensitive operation.',
    parameters: z.object({
      targetName: z.string().describe('The name of the target to operate on.'),
      iterations: z.number().min(1).max(10).default(3).describe('Number of steps to perform.'),
    }),
    execute: async ({ targetName, iterations }) => {
      // 1. Log the start of the operation
      ctx.log(`Starting operation on target: ${targetName}`);

      // 2. Request user approval for a sensitive action
      await ctx.approveCommand(`Initialize custom operation on ${targetName}`);

      for (let i = 1; i <= iterations; i++) {
        // 3. Check for cancellation
        if (ctx.abortSignal?.aborted) {
          ctx.log(`Operation cancelled by user at step ${i}.`);
          throw new Error('Operation aborted');
        }

        // Simulate work
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // 4. Log progress
        ctx.log(`Completed step ${i} of ${iterations}...`);
      }

      ctx.log('Operation finished successfully.');
      return `Successfully completed ${iterations} steps on ${targetName}.`;
    },
  });
}
```
