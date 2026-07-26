import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockReadFile = jest.fn<(...args: unknown[]) => unknown>();
const mockWriteFile = jest.fn<(...args: unknown[]) => unknown>();
const mockMkdir = jest.fn<(...args: unknown[]) => unknown>();

jest.unstable_mockModule("node:fs/promises", () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

const { readConfig, writeConfig, getConfigPath } = await import("./config.js");

describe("readConfig", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
  });

  it("returns parsed config when file exists with valid JSON", async () => {
    mockReadFile.mockResolvedValue('{"key":"abc","model":"gpt-4"}');
    const config = await readConfig();
    expect(config).toEqual({ key: "abc", model: "gpt-4" });
  });

  it("returns empty object when file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const config = await readConfig();
    expect(config).toEqual({});
  });

  it("returns empty object when file contains invalid JSON", async () => {
    mockReadFile.mockResolvedValue("not-json");
    const config = await readConfig();
    expect(config).toEqual({});
  });

  it("returns partial config when file has subset of fields", async () => {
    mockReadFile.mockResolvedValue('{"key":"abc"}');
    const config = await readConfig();
    expect(config).toEqual({ key: "abc" });
    expect(config.model).toBeUndefined();
  });
});

describe("writeConfig", () => {
  beforeEach(() => {
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
  });

  it("creates the config directory", async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    await writeConfig({ key: "abc" });
    expect(mockMkdir).toHaveBeenCalled();
  });

  it("writes formatted JSON with trailing newline", async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    await writeConfig({ model: "gpt-4" });
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain('"model"');
    expect(written).toContain("gpt-4");
    expect(written.endsWith("\n")).toBe(true);
  });
});

describe("getConfigPath", () => {
  it("returns a string", () => {
    expect(typeof getConfigPath()).toBe("string");
  });

  it("contains zencommit/config.json", () => {
    expect(getConfigPath()).toContain("zencommit");
    expect(getConfigPath()).toContain("config.json");
  });
});
