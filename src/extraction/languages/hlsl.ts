/**
 * HLSL Language Extractor
 *
 * Extracts symbols from HLSL shader files, including:
 * - Functions (vertex/pixel/compute shader entry points)
 * - Structs (cbuffer members, vs_input/ps_output)
 * - CBuffer declarations (via visitNode hook)
 * - HLSL semantics (: SV_Position, : TEXCOORD0, etc.)
 * - #include directives (UE virtual paths)
 *
 * Also handles UE-specific shader macros:
 * - IMPLEMENT_GLOBAL_SHADER, IMPLEMENT_SHADER_TYPE, etc.
 * - UE shader entry point conventions (VSMain, PSMain, CSMain, etc.)
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

// =============================================================================
// UE Shader Constants
// =============================================================================

/**
 * UE Shader entry point naming conventions.
 * Maps common entry point function names to their shader stage.
 * Used by the unreal framework resolver to classify shader entry points.
 */
export const UE_ENTRY_POINT_SEMANTICS: Record<string, string> = {
  VSMain: 'VertexShader',
  MainVS: 'VertexShader',
  PSMain: 'PixelShader',
  MainPS: 'PixelShader',
  CSMain: 'ComputeShader',
  MainCS: 'ComputeShader',
  GSMain: 'GeometryShader',
  MainGS: 'GeometryShader',
  HSMain: 'HullShader',
  MainHS: 'HullShader',
  DSMain: 'DomainShader',
  MainDS: 'DomainShader',
  MainMS: 'MeshShader',
  MainAS: 'AmplificationShader',
};

/**
 * UE shader macros that should be filtered from being treated as function names.
 */
const UE_SHADER_MACROS = new Set([
  'IMPLEMENT_GLOBAL_SHADER',
  'IMPLEMENT_MATERIAL_SHADER_TYPE',
  'IMPLEMENT_SHADER_TYPE',
  'IMPLEMENT_VERTEX_FACTORY_TYPE',
  'IMPLEMENT_GLOBAL_SHADER_PARAMETER_STRUCT',
  'SHADER_USE_PARAMETER_STRUCT',
  'DECLARE_GLOBAL_SHADER',
  'BEGIN_GLOBAL_SHADER_PARAMETER_STRUCT',
  'END_GLOBAL_SHADER_PARAMETER_STRUCT',
]);

// =============================================================================
// HLSL Extractor
// =============================================================================

export const hlslExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'],
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',

  /**
   * Extract HLSL function signature including semantics.
   * e.g. `float4 MainPS(VS_INPUT input) : SV_Target` → "(VS_INPUT input) : SV_Target"
   */
  getSignature: (node: SyntaxNode, source: string): string | undefined => {
    const declarator = getChildByField(node, 'declarator');
    if (!declarator) return undefined;

    const parts: string[] = [];

    // Extract parameters
    const paramsNode = getChildByField(declarator, 'parameters');
    if (paramsNode) {
      parts.push(getNodeText(paramsNode, source));
    }

    // Extract semantics (: SV_Position, : TEXCOORD0, etc.)
    // In tree-sitter-hlsl, semantics appear as 'semantics' nodes
    const semanticsNode = declarator.namedChildren.find(c => c.type === 'semantics');
    if (semanticsNode) {
      parts.push(getNodeText(semanticsNode, source));
    }

    // Check for hlsl_attribute ([numthreads(8,8,1)]) preceding this function
    let sibling = node.previousNamedSibling;
    while (sibling) {
      if (sibling.type === 'hlsl_attribute') {
        parts.unshift(getNodeText(sibling, source));
        break;
      }
      if (sibling.type === 'comment' || sibling.type === 'line_comment') {
        sibling = sibling.previousNamedSibling;
        continue;
      }
      break;
    }

    return parts.length > 0 ? parts.join(' ') : undefined;
  },

  /**
   * Filter UE shader macros that would otherwise be misparsed as functions.
   */
  isMisparsedFunction: (name: string, _node: SyntaxNode): boolean => {
    if (UE_SHADER_MACROS.has(name)) return true;
    if (name.startsWith('IMPLEMENT_') || name.startsWith('DECLARE_') ||
        name.startsWith('BEGIN_') || name.startsWith('END_') ||
        name.startsWith('SHADER_')) return true;
    return false;
  },

  /**
   * Custom visitor for HLSL-specific node types:
   * 1. cbuffer_specifier — creates struct nodes for constant buffers
   * 2. hlsl_attribute — captures [numthreads] etc. for shader metadata
   */
  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    // --- CBuffer handling ---
    // cbuffer_specifier is HLSL-specific and not in the default structTypes
    if (node.type === 'cbuffer_specifier') {
      // Extract cbuffer name (first identifier child)
      const nameNode = node.namedChildren.find(c => c.type === 'identifier');
      if (!nameNode) return false;
      const cbufferName = getNodeText(nameNode, ctx.source);

      // Extract register binding register(bN)
      const nodeText = ctx.source.substring(node.startIndex, node.endIndex);
      const regMatch = nodeText.match(/register\s*\(\s*b(\d+)\s*\)/);
      const registerIndex = regMatch && regMatch[1] ? parseInt(regMatch[1]) : -1;

      const cbufferNode = ctx.createNode('struct', cbufferName, node, {
        signature: registerIndex >= 0 ? `cbuffer : register(b${registerIndex})` : 'cbuffer',
        docstring: `HLSL Constant Buffer${registerIndex >= 0 ? ` at register b${registerIndex}` : ''}`,
      });

      if (cbufferNode) {
        // Visit cbuffer body members
        const body = node.namedChildren.find(c => c.type === 'field_declaration_list');
        if (body) {
          ctx.pushScope(cbufferNode.id);
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (child) ctx.visitNode(child);
          }
          ctx.popScope();
        }
      }
      return true; // Handled
    }

    // --- tbuffer handling (texture buffer, similar to cbuffer) ---
    if (node.type === 'tbuffer_specifier') {
      const nameNode = node.namedChildren.find(c => c.type === 'identifier');
      if (!nameNode) return false;
      const tbufferName = getNodeText(nameNode, ctx.source);

      const nodeText = ctx.source.substring(node.startIndex, node.endIndex);
      const regMatch = nodeText.match(/register\s*\(\s*t(\d+)\s*\)/);
      const registerIndex = regMatch && regMatch[1] ? parseInt(regMatch[1]) : -1;

      const tbufferNode = ctx.createNode('struct', tbufferName, node, {
        signature: registerIndex >= 0 ? `tbuffer : register(t${registerIndex})` : 'tbuffer',
        docstring: `HLSL Texture Buffer${registerIndex >= 0 ? ` at register t${registerIndex}` : ''}`,
      });

      if (tbufferNode) {
        const body = node.namedChildren.find(c => c.type === 'field_declaration_list');
        if (body) {
          ctx.pushScope(tbufferNode.id);
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (child) ctx.visitNode(child);
          }
          ctx.popScope();
        }
      }
      return true; // Handled
    }

    return false;
  },

  /**
   * Extract HLSL #include directives.
   * Handles both system includes (<...>) and UE virtual paths ("/Engine/...").
   */
  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // System/library includes: #include <d3d11.h>
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return {
        moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''),
        signature: importText,
      };
    }

    // Local / UE virtual path includes: #include "/Engine/Public/Platform.ush"
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return {
          moduleName: getNodeText(stringContent, source),
          signature: importText,
        };
      }
      // Fallback: strip quotes
      return {
        moduleName: getNodeText(stringLiteral, source).replace(/^"|"$|'^|'$/g, ''),
        signature: importText,
      };
    }

    return null;
  },
};
