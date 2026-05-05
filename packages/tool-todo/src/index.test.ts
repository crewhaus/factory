import { beforeEach, describe, expect, test } from "bun:test";
import { __resetTodos, getCurrentTodos, todoWrite } from "./index";

beforeEach(() => {
  __resetTodos();
});

describe("TodoWrite tool metadata", () => {
  test("name + flags", () => {
    expect(todoWrite.name).toBe("TodoWrite");
    expect(todoWrite.concurrencySafe).toBe(true);
    expect(todoWrite.readOnly).toBe(false);
    expect(todoWrite.destructive).toBe(false);
  });
});

describe("TodoWrite execute", () => {
  test("empty list renders placeholder", async () => {
    const out = await todoWrite.execute({ todos: [] });
    expect(out).toBe("_no todos_");
    expect(getCurrentTodos()).toEqual([]);
  });

  test("renders pending/in_progress/completed with priority", async () => {
    const out = await todoWrite.execute({
      todos: [
        { id: "1", content: "first", status: "pending", priority: "high" },
        { id: "2", content: "second", status: "in_progress", priority: "medium" },
        { id: "3", content: "third", status: "completed", priority: "low" },
      ],
    });
    expect(out).toBe(
      ["- [ ] (high) first", "- [-] (medium) second", "- [x] (low) third"].join("\n"),
    );
  });

  test("second call replaces — does not merge — the list", async () => {
    await todoWrite.execute({
      todos: [{ id: "a", content: "old", status: "pending", priority: "low" }],
    });
    const out = await todoWrite.execute({
      todos: [{ id: "b", content: "new", status: "completed", priority: "high" }],
    });
    expect(out).toBe("- [x] (high) new");
    const stored = getCurrentTodos();
    expect(stored.length).toBe(1);
    expect(stored[0]?.id).toBe("b");
  });

  test("getCurrentTodos reflects the most recent write", async () => {
    await todoWrite.execute({
      todos: [
        { id: "1", content: "alpha", status: "pending", priority: "medium" },
        { id: "2", content: "beta", status: "pending", priority: "medium" },
      ],
    });
    expect(getCurrentTodos().map((t) => t.id)).toEqual(["1", "2"]);
  });

  test("rejects malformed status via schema", () => {
    const result = todoWrite.inputSchema.safeParse({
      todos: [{ id: "1", content: "x", status: "bogus", priority: "low" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects malformed priority via schema", () => {
    const result = todoWrite.inputSchema.safeParse({
      todos: [{ id: "1", content: "x", status: "pending", priority: "urgent" }],
    });
    expect(result.success).toBe(false);
  });
});
