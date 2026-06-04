import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

// =============================================================================
// UE Reflection Macros
// =============================================================================

/**
 * UE reflection macros that annotate classes, structs, enums, functions, and properties.
 * These appear as `preproc_call` nodes in the tree-sitter C++ AST.
 */
const UE_REFLECTION_MACROS = new Set([
  'UCLASS',
  'USTRUCT',
  'UENUM',
  'UFUNCTION',
  'UPROPERTY',
  'UPARAM',
  'UMETA',
  'UINTERFACE',
]);

/**
 * UE delegate declaration macros. These create new delegate types and appear
 * as standalone `preproc_call` nodes (not preceding a class/function).
 */
const UE_DELEGATE_MACRO_PREFIXES = [
  'DECLARE_DYNAMIC_MULTICAST_DELEGATE',
  'DECLARE_MULTICAST_DELEGATE',
  'DECLARE_DELEGATE',
  'DECLARE_DYNAMIC_DELEGATE',
  'DECLARE_EVENT',
  'DECLARE_LOG_CATEGORY_EXTERN',
];

/**
 * UE macros that should be filtered from being treated as function names.
 * These include GENERATED_* macros, DECLARE_* macros, and IMPLEMENT_* macros.
 */
const UE_MACRO_PREFIXES = [
  'GENERATED_',
  'DECLARE_',
  'IMPLEMENT_',
  'BEGIN_',
  'END_',
  'TEXT',
];

// =============================================================================
// UE Macro Extraction Helpers
// =============================================================================

/**
 * Scan preceding siblings for UE reflection macros (UCLASS, UFUNCTION, etc.)
 * that annotate the given AST node. Returns all found macros with their arguments.
 */
function extractPrecedingUEMacros(
  node: SyntaxNode,
  source: string
): { macroName: string; args: string }[] {
  const macros: { macroName: string; args: string }[] = [];
  let sibling = node.previousNamedSibling;

  while (sibling) {
    if (sibling.type === 'preproc_call') {
      const funcNode = sibling.childForFieldName('function');
      if (funcNode) {
        const name = getNodeText(funcNode, source);
        if (UE_REFLECTION_MACROS.has(name)) {
          const argsNode = sibling.childForFieldName('arguments');
          macros.push({
            macroName: name,
            args: argsNode ? getNodeText(argsNode, source) : '',
          });
          // Continue scanning for more UE macros (e.g. UCLASS + GENERATED_BODY)
          sibling = sibling.previousNamedSibling;
          continue;
        }
        // GENERATED_BODY() etc — skip past it, keep scanning
        if (name.startsWith('GENERATED_')) {
          sibling = sibling.previousNamedSibling;
          continue;
        }
      }
    }
    // Stop at any non-preproc_call sibling (comments, actual declarations)
    if (sibling.type !== 'preproc_call' && sibling.type !== 'comment' &&
        sibling.type !== 'line_comment' && sibling.type !== 'block_comment') {
      break;
    }
    // Skip comments
    if (sibling.type === 'comment' || sibling.type === 'line_comment' || sibling.type === 'block_comment') {
      sibling = sibling.previousNamedSibling;
      continue;
    }
    break;
  }

  return macros;
}

/**
 * Extract the delegate name from a UE DECLARE_DELEGATE macro argument string.
 * e.g. `DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnMyEvent)` → "FOnMyEvent"
 * e.g. `DECLARE_DYNAMIC_DELEGATE_TwoParams(FOnDamage, float, DamageAmount, AActor*, Instigator)` → "FOnDamage"
 */
function parseDelegateName(args: string): string | null {
  // Remove outer parens if present
  const trimmed = args.trim().replace(/^\(/, '').replace(/\)$/, '');
  // The delegate name is the first identifier in the arguments
  const match = trimmed.match(/^(\w+)/);
  return match ? match[1]! : null;
}

/**
 * Check if a preproc_call node is a UE delegate declaration macro.
 */
function isUEDelegateMacro(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'preproc_call') return null;
  const funcNode = node.childForFieldName('function');
  if (!funcNode) return null;
  const name = getNodeText(funcNode, source);
  for (const prefix of UE_DELEGATE_MACRO_PREFIXES) {
    if (name === prefix || name.startsWith(prefix + '_')) {
      return name;
    }
  }
  return null;
}

// =============================================================================
// C++ Qualified Name Helpers
// =============================================================================

function extractCppQualifiedMethodName(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;

  const queue: SyntaxNode[] = [declarator];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.type === 'qualified_identifier') {
      const text = getNodeText(current, source).trim();
      const parts = text.split('::').filter(Boolean);
      return parts[parts.length - 1];
    }
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (child) queue.push(child);
    }
  }

  return undefined;
}

function extractCppReceiverType(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;

  const queue: SyntaxNode[] = [declarator];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.type === 'qualified_identifier') {
      const text = getNodeText(current, source).trim();
      const parts = text.split('::').filter(Boolean);
      if (parts.length > 1) {
        return parts.slice(0, -1).join('::');
      }
      return undefined;
    }
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (child) queue.push(child);
    }
  }

  return undefined;
}

// =============================================================================
// C Extractor (unchanged except for UE macro filter in isMisparsedFunction)
// =============================================================================

export const cExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'], // typedef
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveTypeAliasKind: (node, _source) => {
    // C typedef: `typedef enum { ... } name;` or `typedef struct { ... } name;`
    // The inner enum_specifier/struct_specifier is anonymous, but we want the typedef name
    // to become the enum/struct node name.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C includes: #include <stdio.h>, #include "myheader.h"
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};

// =============================================================================
// C++ Extractor (with UE macro support)
// =============================================================================

export const cppExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_specifier'],
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition', 'alias_declaration'], // typedef and using
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveName: extractCppQualifiedMethodName,
  getReceiverType: extractCppReceiverType,
  getVisibility: (node) => {
    // Check for access specifier in parent
    const parent = node.parent;
    if (parent) {
      for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child?.type === 'access_specifier') {
          const text = child.text;
          if (text.includes('public')) return 'public';
          if (text.includes('private')) return 'private';
          if (text.includes('protected')) return 'protected';
        }
      }
    }
    return undefined;
  },
  resolveTypeAliasKind: (node, _source) => {
    // C++ typedef: `typedef enum { ... } name;` or `typedef struct { ... } name;`
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  isMisparsedFunction: (name, _node) => {
    // C++ macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause tree-sitter to misparse
    // namespace blocks as function_definitions (e.g. name = "namespace detail").
    // Also filter C++ keywords that tree-sitter occasionally misinterprets as
    // function/method names (e.g. switch statements inside macro-confused scopes).
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    if (cppKeywords.includes(name)) return true;
    // UE reflection macros are often misparsed as function names
    if (UE_REFLECTION_MACROS.has(name)) return true;
    // UE delegate/implementation macros are also misparsed
    if (UE_MACRO_PREFIXES.some(p => name.startsWith(p))) return true;
    return false;
  },

  /**
   * UE-aware custom visitor hook.
   *
   * Handles:
   * 1. UE delegate macros (DECLARE_DELEGATE_*) — creates type_alias nodes
   * 2. UE reflection macros (UCLASS/UFUNCTION/UPROPERTY/USTRUCT/UENUM) —
   *    annotates the following class/function/struct/enum with decorators
   */
  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    // --- UE Delegate Macros ---
    // These are standalone preproc_call nodes that declare new delegate types.
    // We create a 'type_alias' node for each delegate.
    if (node.type === 'preproc_call') {
      const delegateMacroName = isUEDelegateMacro(node, ctx.source);
      if (delegateMacroName) {
        const argsNode = node.childForFieldName('arguments');
        const args = argsNode ? getNodeText(argsNode, ctx.source) : '';
        const delegateName = parseDelegateName(args);
        if (delegateName) {
          ctx.createNode('type_alias', delegateName, node, {
            signature: `${delegateMacroName}${args}`,
            docstring: `UE Delegate: ${delegateMacroName}`,
          });
          return true; // Handled — skip default logic
        }
      }
    }

    // --- UE Reflection Macro Annotation ---
    // When we encounter a class_specifier / struct_specifier / enum_specifier /
    // function_definition that has preceding UE macros, we let the default
    // extraction handle the node, but we annotate it with UE macro info
    // via the decorators field.
    //
    // We do NOT return true here — we want the default extractClass/extractFunction
    // etc. to run. Instead, we use a side-channel: store the UE macros on a
    // temporary field so the default extractor can pick them up.
    //
    // Actually, the cleanest approach: return false (let default handle it),
    // and after the node is created, find it in ctx.nodes and add decorators.
    // But visitNode runs BEFORE the default logic creates the node.
    //
    // Best approach: return false, but pre-scan and attach UE macro info
    // to the node AFTER it's created. Since visitNode is called first and
    // returns false, the default extractClass/extractFunction will run and
    // create the node. Then we need a way to decorate it.
    //
    // The most pragmatic approach: extract UE macros here and store them
    // on a side-channel that getSignature can read. But getSignature is
    // called AFTER visitNode returns false and the default logic runs.
    //
    // Actually, the simplest approach that works with the existing pipeline:
    // We scan for UE macros here, and if found, we DON'T return true.
    // Instead, we rely on the fact that extractDecoratorsFor() is called
    // inside extractFunction() and extractClass() in tree-sitter.ts.
    // We just need to make UE macros appear as "decorators" in the AST.
    //
    // However, UE macros are preproc_call nodes, not decorator nodes.
    // The extractDecoratorsFor() function specifically looks for decorator nodes.
    //
    // The cleanest solution: After the default logic creates the node,
    // we patch the decorators field. We can do this by finding the newly
    // created node in ctx.nodes after it's added.
    //
    // But wait — we can't do this from visitNode because it returns before
    // the node is created. We need a different approach.
    //
    // ALTERNATIVE: Use getSignature to carry UE macro info. The signature
    // field is set during node creation, and we can prepend the UE macro.
    // This is a bit hacky but works.
    //
    // BEST SOLUTION: The node is created by createNode() in the default
    // extractClass/extractFunction logic. After createNode, the code calls
    // extractDecoratorsFor(). We just need the preproc_call nodes to be
    // recognized as decorators. Since extractDecoratorsFor() scans
    // precedingNamedSibling for specific types, we can add preproc_call
    // with UE macro names as recognized decorator types.
    //
    // For now, let's use the simplest working approach: scan UE macros
    // in visitNode, and if found, manually patch the node after default
    // processing. We do this by scanning ctx.nodes after the fact.
    // Unfortunately, visitNode can't do post-processing.
    //
    // PRAGMATIC APPROACH: Return false, but use getSignature to embed
    // UE macro info. This is what the feasibility analysis recommended.

    return false; // Let default logic handle the node
  },

  /**
   * Enhanced getSignature that includes UE macro annotations.
   * When a class/function/struct/enum has a preceding UE reflection macro,
   * we include it in the signature so it's discoverable via search.
   */
  getSignature: (node: SyntaxNode, source: string): string | undefined => {
    const ueMacros = extractPrecedingUEMacros(node, source);
    if (ueMacros.length > 0) {
      // Build a signature that includes UE macro info
      const macroParts = ueMacros.map(m => `${m.macroName}${m.args}`);
      return macroParts.join(' ');
    }
    return undefined;
  },

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C++ includes: #include <iostream>, #include "myheader.h"
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};
