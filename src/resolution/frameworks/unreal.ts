/**
 * Unreal Engine Framework Resolver
 *
 * Handles UE-specific patterns:
 * 1. Module dependency resolution from .Build.cs files
 * 2. Subsystem class hierarchy detection
 * 3. C++ ↔ Shader cross-language associations (DECLARE_GLOBAL_SHADER)
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

// =============================================================================
// UE Module Dependency Extraction
// =============================================================================

/**
 * Extract module name from a .Build.cs class declaration.
 * e.g. `public class MyGame : ModuleRules` → "MyGame"
 */
function extractModuleName(content: string): string | null {
  const match = /public\s+class\s+(\w+)\s*:\s*ModuleRules/.exec(content);
  return match ? match[1]! : null;
}

/**
 * Extract dependency module names from PublicDependencyModuleNames / PrivateDependencyModuleNames.
 * Handles Add(), AddRange(), and direct array assignment patterns.
 */
function extractDependencyModules(content: string): { name: string; isPublic: boolean }[] {
  const deps: { name: string; isPublic: boolean }[] = [];

  // Pattern 1: .Add("ModuleName")
  const addRegex = /(Public|Private)DependencyModuleNames\s*\.\s*Add\s*\(\s*"(\w+)"\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = addRegex.exec(content)) !== null) {
    deps.push({
      name: match[2]!,
      isPublic: match[1] === 'Public',
    });
  }

  // Pattern 2: .AddRange(new string[] { "Module1", "Module2" })
  const addRangeRegex = /(Public|Private)DependencyModuleNames\s*\.\s*AddRange\s*\(\s*(?:new\s+string\[\]\s*)?\{([^}]+)\}/g;
  while ((match = addRangeRegex.exec(content)) !== null) {
    const isPublic = match[1]! === 'Public';
    const moduleList = match[2]!.match(/"(\w+)"/g) ?? [];
    for (const m of moduleList) {
      deps.push({
        name: m.replace(/"/g, ''),
        isPublic,
      });
    }
  }

  // Pattern 3: Direct array assignment = new string[] { "Module1", "Module2" }
  const directAssignRegex = /(Public|Private)DependencyModuleNames\s*=\s*(?:new\s+string\[\]\s*)?\{([^}]+)\}/g;
  while ((match = directAssignRegex.exec(content)) !== null) {
    const isPublic = match[1]! === 'Public';
    const moduleList = match[2]!.match(/"(\w+)"/g) ?? [];
    for (const m of moduleList) {
      deps.push({
        name: m.replace(/"/g, ''),
        isPublic,
      });
    }
  }

  return deps;
}

/**
 * Extract AdditionalPluginDependencies entries.
 */
function extractPluginDependencies(content: string): string[] {
  const plugins: string[] = [];
  const regex = /AdditionalPluginDependencies\s*\.\s*Add\s*\(\s*"(\w+)"\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    plugins.push(match[1]!);
  }
  return plugins;
}

// =============================================================================
// UE Subsystem Detection
// =============================================================================

const UE_SUBSYSTEM_BASE_CLASSES = [
  'UGameInstanceSubsystem',
  'UWorldSubsystem',
  'UEngineSubsystem',
  'USubsystem',
  'UDynamicSubsystem',
  'UTickableWorldSubsystem',
  'UAssetManagerSubsystem',
  'UNetworkSubsystem',
];

// =============================================================================
// UE Shader Cross-Language Association
// =============================================================================

/**
 * Extract shader file path from C++ GetSourceFilename() method body.
 * e.g. `return TEXT("/Engine/Private/MyShader.usf");` → "/Engine/Private/MyShader.usf"
 */
function extractShaderSourceFilename(content: string): string | null {
  const match = /GetSourceFilename\s*\(\s*\)\s*\{[^}]*return\s+TEXT\(\s*"([^"]+)"\s*\)/.exec(content);
  return match ? match[1]! : null;
}

/**
 * Extract shader entry point from C++ GetFunctionName() method body.
 * e.g. `return TEXT("MainPS");` → "MainPS"
 */
function extractShaderEntryPoint(content: string): string | null {
  const match = /GetFunctionName\s*\(\s*\)\s*\{[^}]*return\s+TEXT\(\s*"(\w+)"\s*\)/.exec(content);
  return match ? match[1]! : null;
}

/**
 * Extract DECLARE_GLOBAL_SHADER / IMPLEMENT_SHADER_TYPE patterns.
 */
function extractShaderClassAssociations(content: string): { className: string; shaderFile: string | null; entryPoint: string | null }[] {
  const results: { className: string; shaderFile: string | null; entryPoint: string | null }[] = [];

  // Pattern: class FMyShader : public FGlobalShader / FShader
  const shaderClassRegex = /class\s+(\w+)\s*:\s*public\s+(?:FGlobalShader|FShader|FMeshMaterialShader|FMeshDrawingPolicy|FVertexFactory)/g;
  let match: RegExpExecArray | null;
  while ((match = shaderClassRegex.exec(content)) !== null) {
    const className = match[1]!;
    // Look for GetSourceFilename/GetFunctionName within reasonable distance
    const afterClass = content.substring(match.index);
    const shaderFile = extractShaderSourceFilename(afterClass);
    const entryPoint = extractShaderEntryPoint(afterClass);
    results.push({ className, shaderFile, entryPoint });
  }

  return results;
}

// =============================================================================
// Framework Resolver
// =============================================================================

export const unrealResolver: FrameworkResolver = {
  name: 'unreal',
  languages: ['cpp', 'csharp', 'hlsl'],

  detect(context: ResolutionContext): boolean {
    const allFiles = context.getAllFiles();

    // .uproject file → UE project
    if (allFiles.some(f => f.endsWith('.uproject'))) return true;

    // .Build.cs in Source/ → UE project
    if (allFiles.some(f => /Source\/.*\.Build\.cs$/.test(f))) return true;

    // UE-specific header files
    if (allFiles.some(f => f.endsWith('GameplayStatics.h') || f.endsWith('Engine.h'))) return true;

    // UE shader files
    if (allFiles.some(f => f.endsWith('.usf') || f.endsWith('.ush'))) return true;

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: UE Module dependency resolution
    // When a .Build.cs references a module by name, find the corresponding module node
    const moduleNodes = context.getNodesByKind('module');
    if (moduleNodes.length > 0) {
      const candidates = moduleNodes.filter(n => n.name === ref.referenceName);
      if (candidates.length > 0) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Subsystem base class resolution
    if (UE_SUBSYSTEM_BASE_CLASSES.some(base => ref.referenceName === base || ref.referenceName.endsWith(base))) {
      const candidates = context.getNodesByName(ref.referenceName);
      if (candidates.length > 0) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  /**
   * Extract UE-specific nodes and references from a file.
   */
  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];

    // --- .Build.cs: Module dependencies ---
    if (filePath.endsWith('.Build.cs')) {
      const moduleName = extractModuleName(content) ?? filePath.replace(/.*\/|\..*$/g, '');
      const startLine = content.slice(0, content.indexOf('class')).split('\n').length;

      const moduleNode: Node = {
        id: `module:${filePath}:${moduleName}`,
        kind: 'module',
        name: moduleName,
        qualifiedName: moduleName,
        filePath,
        language: 'csharp',
        startLine,
        endLine: startLine,
        startColumn: 0,
        endColumn: 0,
        docstring: 'UE Build Module',
        isExported: false,
        updatedAt: Date.now(),
      };
      nodes.push(moduleNode);

      // Extract dependency modules
      const deps = extractDependencyModules(content);
      for (const dep of deps) {
        references.push({
          fromNodeId: moduleNode.id,
          referenceName: dep.name,
          referenceKind: 'references',
          line: startLine,
          column: 0,
          filePath,
          language: 'csharp',
        });
      }

      // Extract plugin dependencies
      const pluginDeps = extractPluginDependencies(content);
      for (const plugin of pluginDeps) {
        references.push({
          fromNodeId: moduleNode.id,
          referenceName: plugin,
          referenceKind: 'references',
          line: startLine,
          column: 0,
          filePath,
          language: 'csharp',
        });
      }
    }

    // --- C++ files: Shader cross-language associations ---
    if (filePath.endsWith('.h') || filePath.endsWith('.cpp')) {
      const shaderAssocs = extractShaderClassAssociations(content);
      for (const assoc of shaderAssocs) {
        // Create a reference from the shader class to the shader file
        if (assoc.shaderFile) {
          references.push({
            fromNodeId: `class:${filePath}:${assoc.className}`,
            referenceName: assoc.shaderFile,
            referenceKind: 'references',
            line: 1,
            column: 0,
            filePath,
            language: 'cpp',
          });
        }
        // Create a reference from the shader class to the entry point function
        if (assoc.entryPoint) {
          references.push({
            fromNodeId: `class:${filePath}:${assoc.className}`,
            referenceName: assoc.entryPoint,
            referenceKind: 'calls',
            line: 1,
            column: 0,
            filePath,
            language: 'cpp',
          });
        }
      }
    }

    return { nodes, references };
  },
};
