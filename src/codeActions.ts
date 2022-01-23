import { CancellationToken, CodeAction, CodeActionContext, CodeActionKind, CodeActionProvider, Command, Diagnostic, Range, TextDocument } from "vscode";
import { Config, getActiveConfig, parseConfig } from "./config";
import { CFLINT_DIAGNOSTIC_SOURCE } from "./diagnostics";
import { constructConfigExcludeRuleLabel, localScopeEdit, transformCaseRuleEdit, varScopeEdit } from "./utils/autoFix";

/**
 * The code action provider class implements code actions for CFLint issues.
 */
export default class CFLintCodeActionProvider implements CodeActionProvider {
    /**
     * Provide code actions for the given document and range.
     *
     * @param document The document in which the command was invoked.
     * @param _range The range for which the command was invoked.
     * @param context Context carrying additional information.
     * @param _token A cancellation token.
     * @return An array of commands or a thenable of such.
     */
    public async provideCodeActions(document: TextDocument, _range: Range, context: CodeActionContext, _token: CancellationToken): Promise<CodeAction[]> {
        const configDocument: TextDocument = await getActiveConfig(document);
        let parsedConfig: Config;

        if (configDocument) {
            parsedConfig = parseConfig(configDocument);
        }

        const codeActions: CodeAction[] = [];
        context.diagnostics.filter((diagnostic: Diagnostic) => {
            return diagnostic.source === CFLINT_DIAGNOSTIC_SOURCE;
        }).forEach((diagnostic: Diagnostic) => {
            const ruleCode: string = diagnostic.code as string;

            let caseConvention: string;
            switch (ruleCode) {
                case "VAR_INVALID_NAME": case "VAR_ALLCAPS_NAME":
                    caseConvention = "camelCase";
                    if (parsedConfig?.parameters?.hasOwnProperty("VariableNameChecker.case")) {
                        caseConvention = parsedConfig.parameters["VariableNameChecker.case"];
                    }
                    break;
                case "METHOD_INVALID_NAME": case "METHOD_ALLCAPS_NAME":
                    caseConvention = "camelCase";
                    if (parsedConfig?.parameters?.hasOwnProperty("MethodNameChecker.case")) {
                        caseConvention = parsedConfig.parameters["MethodNameChecker.case"];
                    }
                    break;
                case "ARGUMENT_INVALID_NAME": case "ARGUMENT_ALLCAPS_NAME":
                    caseConvention = "camelCase";
                    if (parsedConfig?.parameters?.hasOwnProperty("ArgumentNameChecker.case")) {
                        caseConvention = parsedConfig.parameters["ArgumentNameChecker.case"];
                    }
                    break;
                case "SCOPE_ALLCAPS_NAME":
                    caseConvention = "lowercase";
                    break;
                default:
                    break;
            }

            if (caseConvention) {
                codeActions.push({
                    title: `Transform to ${caseConvention}`,
                    edit: transformCaseRuleEdit(document, diagnostic.range, caseConvention),
                    diagnostics: [diagnostic],
                    kind: CodeActionKind.QuickFix,
                    isPreferred: true
                });
            } else if (ruleCode === "MISSING_VAR") {
                codeActions.push({
                    title: "Var scope variable",
                    edit: varScopeEdit(document, diagnostic.range),
                    diagnostics: [diagnostic],
                    kind: CodeActionKind.QuickFix
                });

                codeActions.push({
                    title: "Local scope variable",
                    edit: localScopeEdit(document, diagnostic.range),
                    diagnostics: [diagnostic],
                    kind: CodeActionKind.QuickFix
                });
            }

            const configExcludeRuleCommand: Command = {
                title: constructConfigExcludeRuleLabel(ruleCode),
                command: "_cflint.addConfigIgnoreRule",
                arguments: [document, ruleCode]
            };
            codeActions.push({
                title: constructConfigExcludeRuleLabel(ruleCode),
                command: configExcludeRuleCommand,
                diagnostics: [diagnostic],
                kind: CodeActionKind.QuickFix
            });

            /*
            codeActions.push({
                title: constructInlineIgnoreRuleLabel(ruleCode),
                edit: createInlineIgnoreRuleEdit(document, diagnostic.range, ruleCode),
                diagnostics: [diagnostic],
                kind: CodeActionKind.QuickFix
            });
            */
        });

        return codeActions;
    }
}
