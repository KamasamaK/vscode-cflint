import { Position, Range, TextDocument, TextEdit, TextLine, WorkspaceEdit } from "vscode";
import { isPositionScript } from "./cfmlContext";
import { createLineComment } from "./editUtils";
import { transformTextCase } from "./textUtil";

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
    return createLineComment(`@CFLintIgnore ${ruleCodes.join(",")}`, isScript) + "\n";
}

function createInlineIgnoreRuleFix(document: TextDocument, range: Range, ruleCode: string): AutoFix {
    // TODO: Check for an existing ignored rule for this line

    const isScript: boolean = isPositionScript(document, range.start);
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

export function createInlineIgnoreRuleEdit(document: TextDocument, range: Range, ruleCode: string): WorkspaceEdit {
    const autofix: AutoFix = createInlineIgnoreRuleFix(document, range, ruleCode);

    let workspaceEdit: WorkspaceEdit = new WorkspaceEdit();
    workspaceEdit.set(document.uri, autofix.edits);

    return workspaceEdit;
}

export function transformCaseRuleEdit(document: TextDocument, range: Range, textCase: string): WorkspaceEdit {
    const currentWord: string = document.getText(range);
    const transformedWord: string = transformTextCase(currentWord, textCase);

    let workspaceEdit: WorkspaceEdit = new WorkspaceEdit();
    workspaceEdit.replace(document.uri, range, transformedWord);

    return workspaceEdit;
}

export function varScopeEdit(document: TextDocument, range: Range): WorkspaceEdit {
    const currentWord: string = document.getText(range);
    const varScopedVariable: string = "var " + currentWord;

    let workspaceEdit: WorkspaceEdit = new WorkspaceEdit();
    workspaceEdit.replace(document.uri, range, varScopedVariable);

    return workspaceEdit;
}

export function localScopeEdit(document: TextDocument, range: Range): WorkspaceEdit {
    const currentWord: string = document.getText(range);
    const localScopedVariable: string = "local." + currentWord;

    let workspaceEdit: WorkspaceEdit = new WorkspaceEdit();
    workspaceEdit.replace(document.uri, range, localScopedVariable);

    return workspaceEdit;
}
