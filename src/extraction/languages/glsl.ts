/**
 * GLSL Language Extractor
 *
 * Extracts symbols from GLSL shader files (.glsl, .vert, .frag, .comp, .geom).
 * Uses tree-sitter-glsl grammar (based on tree-sitter-c).
 *
 * GLSL-specific features:
 * - Layout qualifiers (layout(local_size_x=8) in;)
 * - Shader stage detection from file extension
 * - #version directives
 * - Built-in variable declarations
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const glslExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: [],
  enumMemberTypes: [],
  typeAliasTypes: ['type_definition'],
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',

  /**
   * Extract GLSL function signature.
   * Includes layout qualifiers if present before the function.
   */
  getSignature: (node: SyntaxNode, source: string): string | undefined => {
    const declarator = getChildByField(node, 'declarator');
    if (!declarator) return undefined;

    const paramsNode = getChildByField(declarator, 'parameters');
    return paramsNode ? getNodeText(paramsNode, source) : undefined;
  },

  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // GLSL includes: #include "common.glsl"
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return {
          moduleName: getNodeText(stringContent, source),
          signature: importText,
        };
      }
      return {
        moduleName: getNodeText(stringLiteral, source).replace(/^"|"$|'^|'$/g, ''),
        signature: importText,
      };
    }
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return {
        moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''),
        signature: importText,
      };
    }
    return null;
  },
};
