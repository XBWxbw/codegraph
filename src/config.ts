/**
 * Project Configuration
 *
 * Reads and writes `.codegraph/config.json` for per-project settings.
 * The config file is optional — all fields have sensible defaults.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from './directory';
import { Language } from './types';

/**
 * Per-project CodeGraph configuration.
 * Stored as `.codegraph/config.json` inside the project root.
 */
export interface CodeGraphConfig {
  /**
   * Languages to exclude from indexing.
   * Files whose detected language is in this list will be skipped
   * during scanning and parsing. Useful for large codebases where
   * certain languages (e.g. Python, Lua in UE projects) are not
   * the primary focus and their symbols are not needed.
   *
   * Values must match the `Language` type exactly (e.g. "python", "lua").
   */
  excludeLanguages?: Language[];
}

const CONFIG_FILENAME = 'config.json';

/**
 * Get the path to the config file.
 */
export function getConfigPath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), CONFIG_FILENAME);
}

/**
 * Load project configuration from `.codegraph/config.json`.
 * Returns default config if the file doesn't exist or is invalid.
 */
export function loadConfig(projectRoot: string): CodeGraphConfig {
  const configPath = getConfigPath(projectRoot);
  try {
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Validate excludeLanguages if present
    if (parsed.excludeLanguages && Array.isArray(parsed.excludeLanguages)) {
      return {
        excludeLanguages: parsed.excludeLanguages.filter((lang: unknown) => typeof lang === 'string'),
      };
    }
    return {};
  } catch {
    // Corrupted or unreadable config — use defaults
    return {};
  }
}

/**
 * Save project configuration to `.codegraph/config.json`.
 * Creates the `.codegraph/` directory if it doesn't exist.
 */
export function saveConfig(projectRoot: string, config: CodeGraphConfig): void {
  const codegraphDir = getCodeGraphDir(projectRoot);
  if (!fs.existsSync(codegraphDir)) {
    fs.mkdirSync(codegraphDir, { recursive: true });
  }
  const configPath = getConfigPath(projectRoot);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Check if a language is excluded by the project config.
 */
export function isLanguageExcluded(language: Language, config: CodeGraphConfig): boolean {
  return config.excludeLanguages?.includes(language) ?? false;
}
