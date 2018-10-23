export interface CFLintIssueList {
    id: string;
    severity: string;
    locations: CFLintIssueLocation[];
}

export interface CFLintIssueLocation {
    file: string;
    fileName: string;
    function: string;
    offset: number;
    column: number;
    line: number;
    message: string;
    variable: string;
    expression: string;
}

export interface CFLintIssue {
    id: string;
    severity: string;
    file: string;
    fileName: string;
    offset: number;
    line: number;
    column: number;
    message: string;
    variable: string;
    function: string;
    expression: string;
}