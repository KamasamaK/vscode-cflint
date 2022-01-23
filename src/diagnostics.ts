import { Diagnostic, DiagnosticSeverity, DiagnosticTag, Position, Range, TextDocument, WorkspaceConfiguration } from "vscode";
import { getCFLintSettings } from "./extension";
import { CFLintIssue, CFLintIssueList } from "./issues";

export const CFLINT_DIAGNOSTIC_SOURCE = "cflint";

/**
 * Takes an issue object representing a single issue and create a Diagnostic object from it.
 *
 * @param document The document in which the issues exists
 * @param issue Expected to be in the format returned by CFLint's JSON output.
 * @return A Diagnostic object corresponding to the issue.
 */
export function createDiagnostics(document: TextDocument, issue: CFLintIssueList): Diagnostic[] {
    const diagnosticArr: Diagnostic[] = [];

    const issueSeverity: string = issue.severity;
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(document.uri);

    const ignoreInfo: boolean = cflintSettings.get<boolean>("ignoreInfo", false);
    if (ignoreInfo && getDiagnosticSeverity(issueSeverity) === DiagnosticSeverity.Information) {
        return diagnosticArr;
    }

    const ignoreWarnings: boolean = cflintSettings.get<boolean>("ignoreWarnings", false);
    if (ignoreWarnings && getDiagnosticSeverity(issueSeverity) === DiagnosticSeverity.Warning) {
        return diagnosticArr;
    }

    for (const location of issue.locations) {
        const cflintIssue: CFLintIssue = {
            id: issue.id,
            severity: issue.severity,
            file: location.file,
            fileName: location.fileName,
            offset: location.offset,
            line: location.line,
            column: location.column,
            message: location.message,
            variable: location.variable,
            function: location.function,
            expression: location.expression
        };

        diagnosticArr.push(makeDiagnostic(document, cflintIssue));
    }

    return diagnosticArr;
}

/**
 * Takes a CFLintIssue and makes a Diagnostic from it.
 *
 * @param document The document in which the issue exists
 * @param issue The issue structured as a CFLintIssue.
 * @return A Diagnostic object corresponding to the problem.
 */
function makeDiagnostic(document: TextDocument, issue: CFLintIssue): Diagnostic {
    // Ensure that the start and end are >=0
    issue.line = Math.max(issue.line, 1);
    issue.column = Math.max(issue.column, 0);

    const start: Position = new Position(issue.line - 1, issue.column);
    // TODO: Try using offset instead
    // const offsetStart: Position = document.positionAt(issue.offset);
    const wordRange: Range = document.getWordRangeAtPosition(start);
    const diagnosticRange: Range = wordRange ?? new Range(start, start);
    const diagnosticTags: DiagnosticTag[] = [];
    // TODO: Include UNUSED_METHOD_ARGUMENT when proper location is provided
    if (issue.id === "UNUSED_LOCAL_VARIABLE") {
        diagnosticTags.push(DiagnosticTag.Unnecessary);
    }

    return {
        message: issue.message,
        severity: getDiagnosticSeverity(issue.severity),
        source: CFLINT_DIAGNOSTIC_SOURCE,
        code: issue.id,
        range: diagnosticRange,
        tags: diagnosticTags
    };
}

/**
 * Takes a CFLint issue severity and gets its corresponding DiagnosticSeverity.
 *
 * @param issueSeverity The CFLint issue severity.
 * @return A DiagnosticSeverity object corresponding to the issue.
 */
function getDiagnosticSeverity(issueSeverity: string): DiagnosticSeverity {
    let problemSeverity: DiagnosticSeverity;
    switch (issueSeverity.toLowerCase()) {
        case "fatal":
        case "critical":
        case "error":
            problemSeverity = DiagnosticSeverity.Error;
            break;
        case "warning":
        case "caution":
            problemSeverity = DiagnosticSeverity.Warning;
            break;
        case "info":
        case "cosmetic":
            problemSeverity = DiagnosticSeverity.Information;
            break;
        default:
            problemSeverity = DiagnosticSeverity.Information;
    }

    return problemSeverity;
}
