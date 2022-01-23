import { Position, Range, TextDocument, TextEdit, TextLine, WorkspaceEdit } from "vscode";
import { transformTextCase } from "./textUtil";
import { cfmlApi } from "../extension";

export interface AutoFix {
    label: string;
    edits: TextEdit[];
}

/**
 * Construct a label for the config exclude rule autofix
 *
 * @param ruleCode The rule code being excluded
 */
export function constructConfigExcludeRuleLabel(ruleCode: string): string {
    return `Exclude rule "${ruleCode}" in .cflintrc`;
}

// Inline Rule Fix
/**
 * Construct a label for the inline ignore rule autofix
 *
 * @param ruleCode The rule code being ignored
 */
export function constructInlineIgnoreRuleLabel(ruleCode: string): string {
    return `Ignore rule "${ruleCode}" for this line`;
}

/**
 * Creates the ignore rule text for the given rules codes based on whether this is in a script context
 *
 * @param ruleCodes The rule codes to be ignored by this text
 * @param isScript Whether the ignore rule text in the script context
 */
function createInlineIgnoreRuleText(ruleCodes: string[], isScript: boolean): string {
    const createLineComment = (text: string, isScript: boolean): string => {
        return isScript ? `// ${text}` : `<!--- ${text} --->`;
    };

    return createLineComment(`@CFLintIgnore ${ruleCodes.join(",")}`, isScript) + "\n";
}

/**
 * Creates autofix for adding an inline ignore rule
 * @param document The document in which the fix will be applied
 * @param range The range for which the fix will be applied
 * @param ruleCode The rule code to be ignored
 */
function createInlineIgnoreRuleFix(document: TextDocument, range: Range, ruleCode: string): AutoFix {
    // TODO: Check for an existing ignored rule for this line

    const isScript: boolean = cfmlApi.getContextUtils().isPositionScript(document, range.start);
    const newPosition: Position = new Position(range.start.line, 0);

    const inlineIgnoreRuleRange: Range = new Range(newPosition, newPosition);
    let inlineIgnoreRuleText: string = createInlineIgnoreRuleText([ruleCode], isScript);

    // prefix disable comment with same indent as line with the diagnostic
    const ruleLine: TextLine = document.lineAt(inlineIgnoreRuleRange.start.line);
    const prefixIndex: number = ruleLine.firstNonWhitespaceCharacterIndex;
    const prefix: string = ruleLine.text.substr(0, prefixIndex);
    inlineIgnoreRuleText = prefix + inlineIgnoreRuleText;

    const ignoreRuleEdit: TextEdit = new TextEdit(inlineIgnoreRuleRange, inlineIgnoreRuleText);

    const ignoreRuleAutofix: AutoFix = {
        label: constructInlineIgnoreRuleLabel(ruleCode),
        edits: [ignoreRuleEdit]
    };

    return ignoreRuleAutofix;
}

/**
 * Creates workspace edit for adding an inline ignore rule
 * @param document The document in which the fix will be applied
 * @param range The range for which the fix will be applied
 * @param ruleCode The rule code to be ignored
 */
export function createInlineIgnoreRuleEdit(document: TextDocument, range: Range, ruleCode: string): WorkspaceEdit {
    const autofix: AutoFix = createInlineIgnoreRuleFix(document, range, ruleCode);

    const workspaceEdit: WorkspaceEdit = new WorkspaceEdit();
    workspaceEdit.set(document.uri, autofix.edits);

    return workspaceEdit;
}

/**
 * Creates workspace edit for transforming the case of a word
 * @param document The document in which the word appears
 * @param range The range of the word
 * @param textCase The text case to use
 */
export function transformCaseRuleEdit(document: TextDocument, range: Range, textCase: string): WorkspaceEdit {
    const currentWord: string = document.getText(range);
    const transformedWord: string = transformTextCase(currentWord, textCase);

    const workspaceEdit: WorkspaceEdit = new WorkspaceEdit();
    workspaceEdit.replace(document.uri, range, transformedWord);

    return workspaceEdit;
}

/**
 * Creates workspace edit for var scoping a variable
 * @param document The document in which the variable is declared
 * @param range The range of the variable identifier
 */
export function varScopeEdit(document: TextDocument, range: Range): WorkspaceEdit {
    const currentWord: string = document.getText(range);
    const varScopedVariable = `var ${currentWord}`;

    const workspaceEdit: WorkspaceEdit = new WorkspaceEdit();
    workspaceEdit.replace(document.uri, range, varScopedVariable);

    return workspaceEdit;
}

/**
 * Creates workspace edit for local scoping a variable
 * @param document The document in which the variable is declared
 * @param range The range of the variable identifier
 */
export function localScopeEdit(document: TextDocument, range: Range): WorkspaceEdit {
    const currentWord: string = document.getText(range);
    const localScopedVariable = `local.${currentWord}`;

    const workspaceEdit: WorkspaceEdit = new WorkspaceEdit();
    workspaceEdit.replace(document.uri, range, localScopedVariable);

    return workspaceEdit;
}

// TODO: OUTPUT_ATTR
