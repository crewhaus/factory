/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { ONCHAIN_TOOLS } from "./index";

let catalog: ToolCatalog;
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of ONCHAIN_TOOLS) catalog.register(tool);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(ONCHAIN_TOOLS.length);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("AddressCheck"),
      { address: VITALIK },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"valid":true');
  });

  test("input is validated before execute", async () => {
    const result = await executeTool(lookup("AddressCheck"), { address: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
  });

  test("a library refusal is an error result, not a crash", async () => {
    const result = await executeTool(
      lookup("AbiEncodeCall"),
      { signature: "f(uint8)", args: ["999"] },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("uint8");
  });

  test("every tool can be dispatched with a minimal valid input", async () => {
    const inputs: Record<string, unknown> = {
      AbiEncodeCall: { signature: "totalSupply()", args: [] },
      AbiDecode: { data: `0x${"0".repeat(64)}`, types: ["uint256"] },
      FunctionSelector: { signature: "transfer(address,uint256)" },
      AddressCheck: { address: VITALIK },
      TypedDataHash: { personalSignMessage: "hi" },
      TokenUnits: { amount: "1", decimals: 18 },
      DefiMath: { operation: "minimumOut", quotedOut: "100", slippageBps: 0 },
    };
    for (const tool of ONCHAIN_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });
});

describe("the pre-flight these exist for", () => {
  test("check an address, build the calldata, and confirm what a signature would cover", async () => {
    // 1. The address is checksummed, so a typo would have been caught.
    const checked = await executeTool(
      lookup("AddressCheck"),
      { address: VITALIK },
      { toolUseId: "p1" },
    );
    const address = JSON.parse(checked.content);
    expect(address.valid).toBe(true);
    expect(address.hadChecksum).toBe(true);

    // 2. The amount becomes base units exactly.
    const units = await executeTool(
      lookup("TokenUnits"),
      { amount: "1.5", decimals: 18 },
      { toolUseId: "p2" },
    );
    const baseUnits = JSON.parse(units.content).baseUnits;
    expect(baseUnits).toBe("1500000000000000000");

    // 3. The calldata is built from both, and its selector is the one a
    //    block explorer would show for an ERC-20 transfer.
    const encoded = await executeTool(
      lookup("AbiEncodeCall"),
      { signature: "transfer(address,uint256)", args: [address.checksummed, baseUnits] },
      { toolUseId: "p3" },
    );
    const calldata = JSON.parse(encoded.content);
    expect(calldata.selector).toBe("0xa9059cbb");
    expect(calldata.bytes).toBe(68);

    // 4. The same amount one wei different produces different calldata,
    //    which is what makes checking the bytes worth doing at all.
    const other = await executeTool(
      lookup("AbiEncodeCall"),
      {
        signature: "transfer(address,uint256)",
        args: [address.checksummed, "1500000000000000001"],
      },
      { toolUseId: "p4" },
    );
    expect(JSON.parse(other.content).data).not.toBe(calldata.data);
  });
});
