/**
 * Hand-rolled JSON Schema mirror of @crewhaus/spec's Zod discriminated
 * union, scoped to autocomplete / lint surface VS Code consumes.
 * Drift-tested in spec-schema.test.ts against TARGET_SHAPES.
 */

const permissionRule = {
  type: "object",
  required: ["type", "pattern"],
  properties: {
    type: { enum: ["alwaysAllow", "alwaysDeny", "alwaysAsk"] },
    pattern: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

const permissions = {
  type: "object",
  properties: {
    mode: { enum: ["default", "plan", "auto"] },
    rules: { type: "array", items: permissionRule },
  },
  additionalProperties: false,
} as const;

const channelsBlock = {
  type: "object",
  properties: {
    slack: {
      type: "object",
      required: ["botToken", "signingSecret"],
      properties: {
        botToken: { type: "string", minLength: 1 },
        signingSecret: { type: "string", minLength: 1 },
        appToken: { type: "string", minLength: 1 },
      },
    },
    telegram: {
      type: "object",
      required: ["botToken", "secretToken"],
      properties: {
        botToken: { type: "string", minLength: 1 },
        secretToken: { type: "string", minLength: 1 },
      },
    },
    discord: {
      type: "object",
      required: ["applicationId", "botToken", "publicKeyHex"],
      properties: {
        applicationId: { type: "string", minLength: 1 },
        botToken: { type: "string", minLength: 1 },
        publicKeyHex: { type: "string", minLength: 1 },
      },
    },
    whatsapp: {
      type: "object",
      required: ["phoneNumberId", "accessToken", "appSecret"],
      properties: {
        phoneNumberId: { type: "string", minLength: 1 },
        accessToken: { type: "string", minLength: 1 },
        appSecret: { type: "string", minLength: 1 },
      },
    },
    imessage: {
      type: "object",
      properties: {
        chatDbPath: { type: "string" },
        cursorPath: { type: "string" },
      },
    },
  },
} as const;

const cliShape = {
  type: "object",
  required: ["name", "target", "agent"],
  properties: {
    name: { type: "string", minLength: 1 },
    target: { const: "cli" },
    agent: {
      type: "object",
      required: ["model", "instructions"],
      properties: {
        model: { type: "string", minLength: 1 },
        instructions: { type: "string", minLength: 1 },
      },
    },
    tools: { type: "array", items: { type: "string" } },
    permissions,
    mcp_servers: { type: "object" },
  },
  additionalProperties: false,
} as const;

const workflowShape = {
  type: "object",
  required: ["name", "target", "model", "steps"],
  properties: {
    name: { type: "string", minLength: 1 },
    target: { const: "workflow" },
    model: { type: "string", minLength: 1 },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "instructions"],
        properties: {
          name: { type: "string", minLength: 1 },
          instructions: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          tools: { type: "array", items: { type: "string" } },
        },
      },
    },
    permissions,
  },
} as const;

const channelShape = {
  type: "object",
  required: ["name", "target", "agent", "channels", "routing"],
  properties: {
    name: { type: "string", minLength: 1 },
    target: { const: "channel" },
    agent: {
      type: "object",
      required: ["model", "instructions"],
      properties: {
        model: { type: "string", minLength: 1 },
        instructions: { type: "string", minLength: 1 },
        tools: { type: "array", items: { type: "string" } },
      },
    },
    channels: channelsBlock,
    routing: {
      type: "object",
      required: ["sessionKey"],
      properties: { sessionKey: { enum: ["thread", "user", "channel"] } },
    },
    permissions,
  },
} as const;

function shapeWithTarget(target: string, extra: Record<string, unknown> = {}) {
  return {
    type: "object",
    required: ["name", "target"],
    properties: {
      name: { type: "string", minLength: 1 },
      target: { const: target },
      permissions,
      ...extra,
    },
  } as const;
}

export const specSchemaJson = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://crewhaus.io/schemas/spec.json",
  title: "CrewHaus Spec",
  description: "v0 spec discriminated on `target`. Mirrors @crewhaus/spec.",
  oneOf: [
    cliShape,
    workflowShape,
    channelShape,
    shapeWithTarget("graph", {
      entry: { type: "string", minLength: 1 },
      nodes: { type: "object" },
      edges: { type: "array" },
    }),
    shapeWithTarget("managed", {
      tenants: { type: "object" },
    }),
    shapeWithTarget("pipeline", {
      stages: { type: "array" },
    }),
    shapeWithTarget("crew", {
      roles: { type: "object" },
    }),
    shapeWithTarget("research", {
      retrieve: { type: "object" },
    }),
    shapeWithTarget("batch", {
      worker: { type: "object" },
    }),
    shapeWithTarget("voice", {
      voice: { type: "object" },
    }),
    shapeWithTarget("browser", {
      driver: { type: "object" },
    }),
    shapeWithTarget("eval", {
      agent: { type: "object" },
      dataset: { type: "object" },
      graders: { type: "array" },
    }),
  ],
} as const;
