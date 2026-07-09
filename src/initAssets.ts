#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { getAssetFilePath } from "./config.js";
import type { AssetCatalog } from "./types.js";

const configuredPath = getAssetFilePath();
const filePath = path.resolve(process.cwd(), configuredPath);
const force = process.argv.includes("--force");

const emptyCatalog: AssetCatalog = {
  version: 1,
  updatedAt: new Date().toISOString(),
  assets: []
};

try {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (!force) {
    try {
      await fs.access(filePath);
      console.log(`Asset catalog already exists: ${filePath}`);
      console.log("Use npm run init:assets:force to overwrite it with an empty catalog.");
      process.exit(0);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }

  await fs.writeFile(filePath, `${JSON.stringify(emptyCatalog, null, 2)}\n`, "utf8");
  console.log(`Initialized empty asset catalog: ${filePath}`);
} catch (error) {
  console.error("Failed to initialize asset catalog:", error);
  process.exit(1);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
