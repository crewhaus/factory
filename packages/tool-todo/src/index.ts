import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * Built-in TodoWrite tool. Holds the current todo list in module-level
 * state — one list per process — and overwrites the entire list on each
 * call. Returns a markdown checklist for the model to read back.
 *
 * Layer R4. Pairs with the `target-cli` codegen contract (`todoWrite` export).
 */

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "low" | "medium" | "high";

export type Todo = {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly priority: TodoPriority;
};

const todoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  priority: z.enum(["low", "medium", "high"]),
});

const todoWriteSchema = z.object({
  todos: z.array(todoSchema),
});

let currentTodos: ReadonlyArray<Todo> = [];

export function getCurrentTodos(): ReadonlyArray<Todo> {
  return currentTodos;
}

export function __resetTodos(): void {
  currentTodos = [];
}

function statusBox(status: TodoStatus): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[-]";
  return "[ ]";
}

function renderMarkdown(todos: ReadonlyArray<Todo>): string {
  if (todos.length === 0) return "_no todos_";
  return todos.map((t) => `- ${statusBox(t.status)} (${t.priority}) ${t.content}`).join("\n");
}

export const todoWrite: RegisteredTool = buildTool({
  name: "TodoWrite",
  description:
    "Replace the per-session todo list with the supplied items and return the list as a markdown checklist.",
  inputSchema: todoWriteSchema,
  concurrencySafe: true,
  execute: async (input) => {
    currentTodos = input.todos.map((t) => ({ ...t }));
    return renderMarkdown(currentTodos);
  },
});
