'use strict';

import * as path from 'path';
import * as fs from 'fs';
import {
    workspace, window, commands, languages, WorkspaceConfiguration, Disposable, ExtensionContext, Uri,
    TextDocument, TextDocumentChangeEvent, TextEditor, Diagnostic, DiagnosticSeverity, DiagnosticCollection, Range, Position
} from 'vscode';
import { Delayer } from './delayer';
import { spawn, ChildProcess } from 'child_process';

const open = require('open');
const findConfig = require('find-config');

const configFileName: string = ".cflintrc";
const configFileDefault: string = [
    '{',
    '   "rule" : [ ],',
    '   "excludes" : [ ],',
    '   "includes" : [ ],',
    '   "inheritParent" : false',
    '}'
].join(process.platform === 'win32' ? '\r\n' : '\n');
const defaultTypingDelay: number = 700;
const defaultCooldown: number = 5000;

let diagnosticCollection: DiagnosticCollection;
let typingDelayer: Map<Uri, Delayer<void>>;
let linterCooldowns: Map<Uri, number>;

interface CFLintIssueList {
    id: string;
    severity: string;
    locations: CFLintIssueLocation[];
}

interface CFLintIssueLocation {
    file: string;
    fileName: string;
    function: string;
    column: number;
    line: number;
    message: string;
    variable: string;
    expression: string;
}

interface CFLintIssue {
    id: string;
    severity: string;
    file: string;
    fileName: string;
    line: number;
    column: number;
    message: string;
    variable: string;
    function: string;
    expression: string;
}

interface RunModes {
    onOpen: boolean;
    onSave: boolean;
    onChange: boolean;
}

/**
 * Checks whether the language id is compatible with CFML.
 *
 * @param languageId The VSCode language id to check.
 * @return Indication of whether the language id is compatible with CFML.
 */
function isCfmlLanguage(languageId: string): boolean {
    return (languageId === 'lang-cfml' ||
        languageId === 'cfml');
}

/**
 * Enables linter.
 */
function enable(): void {
    if (!workspace.rootPath) {
        window.showErrorMessage('cflint can only be enabled if VS Code is opened on a workspace folder.');
        return;
    }
    let settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
    settings.update('enabled', true, false);
}

/**
 * Disables linter.
 */
function disable(): void {
    if (!workspace.rootPath) {
        window.showErrorMessage('cflint can only be disabled if VS Code is opened on a workspace folder.');
        return;
    }
    let settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
    settings.update('enabled', false, false);
}

/**
 * Checks whether the linter is enabled.
 */
function isLinterEnabled(): boolean {
    const settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
    return settings.get("enabled", true);
}

/**
 * Checks whether the document is on cooldown.
 */
function isOnCooldown(document: TextDocument): boolean {
    const settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
    const cooldownSetting = settings.get("linterCooldown", defaultCooldown);
    const documentCooldown: number = linterCooldowns.get(document.uri);

    if (documentCooldown && (Date.now() - documentCooldown) < cooldownSetting) {
        return true;
    }

    return false;
}

/**
 * Gets the current time as a formatted string
 *
 * @return Formatted time
 */
function getCurrentTimeFormatted(): string {
    const currDate = new Date();

    let hours = currDate.getHours().toString();
    hours = (hours.length === 1) ? "0" + hours : hours;
    let minutes = currDate.getMinutes().toString();
    minutes = (minutes.length === 1) ? "0" + minutes : minutes;
    let seconds = currDate.getSeconds().toString();
    seconds = (seconds.length === 1) ? "0" + seconds : seconds;

    return hours + ":" + minutes + ":" + seconds;
}

/**
 * Creates a default configuration file in the workspace root path.
 *
 * @param directory The directory in which to create the config file.
 * @return Indication of whether the file creation was successful.
 */
function createDefaultConfiguration(directory: string): boolean {
    if (!directory) {
        window.showErrorMessage('A CFLint configuration can only be generated if VS Code is opened on a workspace folder.');
        return;
    }
    let cflintConfigFile: string = path.join(directory, configFileName);
    if (!fs.existsSync(cflintConfigFile)) {
        fs.writeFileSync(cflintConfigFile, configFileDefault, { encoding: 'utf8' });
        window.showInformationMessage("Successfully created configuration file", "Open file").then(
            (selection: string) => {
                if (selection === "Open file") {
                    workspace.openTextDocument(cflintConfigFile).then((textDocument: TextDocument) => {
                        if (!textDocument) {
                            console.error('Could not open ' + cflintConfigFile);
                            return;
                        }

                        window.showTextDocument(textDocument).then((editor: TextEditor) => {
                            if (!editor) {
                                console.error('Could not show ' + cflintConfigFile);
                                return;
                            }
                        });
                    });
                }
            }
        );

        return true;
    } else {
        window.showErrorMessage("Configuration file already exists");
    }

    return false;
}

/**
 * Gets the full path to the config file to use for the given document.
 *
 * @param document The document for which the config file will be retrieved.
 * @param fileNames A list of filenames that will be checked.
 * @return The full path to the config file, or undefined if none.
 */
function getConfigFile(document: TextDocument, fileName: string): string {
    const settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
    const altConfigFile: string = settings.get('altConfigFile', '');
    const altConfigFileUsage: string = settings.get('altConfigFile.usage', 'fallback');
    const altConfigFileExists: boolean = alternateConfigFileExists();

    if (altConfigFileExists && altConfigFileUsage === 'always') {
        return altConfigFile;
    }

    const currentWorkingDir: string = path.dirname(document.fileName);
    const projectConfig: string = findConfig(fileName, { cwd: currentWorkingDir });
    if (projectConfig) {
        return projectConfig;
    }

    if (altConfigFileExists && altConfigFileUsage === 'fallback') {
        return altConfigFile;
    }

    return undefined;
}

/**
 * Checks to see if an alternate config file exists.
 *
 * @return Whether cflint.altConfigFile resolves to a valid path.
 */
function alternateConfigFileExists(): boolean {
    const settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
    const altConfigFile: string = settings.get('altConfigFile', '');
    return fs.existsSync(altConfigFile);
}

/**
 * Gets the proper Java bin name for the platform.
 *
 * @param binName
 * @return The Java bin name for the current platform.
 */
function correctJavaBinName(binName: string) {
    if (process.platform === 'win32') {
        return binName + '.exe';
    } else {
        return binName;
    }
}

/**
 * Gets the full path to the java executable to be used.
 *
 * @return The full path to the java executable.
 */
function findJavaExecutable(): string {
    let settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
    let javaPath: string = settings.get("javaPath");
    let javaBinName = correctJavaBinName("java");

    // Start with setting
    if (javaPath && fs.existsSync(javaPath)) {
        return javaPath;
    }

    // Then search JAVA_HOME
    const envJavaHome = process.env['JAVA_HOME'];
    if (envJavaHome) {
        let javaPath = path.join(envJavaHome, 'bin', javaBinName);

        if (javaPath && fs.existsSync(javaPath)) {
            return javaPath;
        }
    }

    // Then search PATH parts
    let envPath = process.env['PATH'];
    if (envPath) {
        let pathParts = envPath.split(path.delimiter);
        for (let pathPart of pathParts) {
            let javaPath = path.join(pathPart, javaBinName);
            if (fs.existsSync(javaPath)) {
                return javaPath;
            }
        }
    }

    return javaBinName;
}

/**
 * Checks to see if cflint.jarPath resolves to a valid path.
 *
 * @return Whether the JAR path in settings is a valid path.
 */
function jarPathExists(): boolean {
    let settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
    const jarPath: string = settings.get("jarPath", "");
    return fs.existsSync(jarPath);
}

/**
 * Checks if the input string resolves to a valid path.
 *
 * @param input The path to check validity.
 * @return Empty string if valid, else an error message.
 */
function validatePath(input: string): string {
    if (fs.existsSync(input)) {
        return "";
    }

    return "This is not a valid path";
}

/**
 * Displays error message indicating that cflint.jarPath needs to be set, and prompts for path.
 */
function showInvalidJarPathMessage(): void {
    let settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
    window.showErrorMessage('You must set cflint.jarPath to a valid path in your settings', "Set now").then(
        (selection: string) => {
            if (selection === "Set now") {
                const jarPath: string = settings.get("jarPath", "");
                window.showInputBox({
                    prompt: "A path to the CFLint standalone JAR file",
                    value: jarPath,
                    ignoreFocusOut: true,
                    validateInput: validatePath
                }).then((val: string) => {
                    settings.update('jarPath', val, true);
                });
            }
        }
    );
}

/**
 * Takes an issue object representing a single issue and create a Diagnostic object from it.
 *
 * @param issue Expected to be in the format returned by CFLint's JSON output.
 * @return A Diagnostic object corresponding to the issue.
 */
function createDiagnostics(issue: CFLintIssueList): Diagnostic[] {

    let diagnosticArr: Diagnostic[] = [];

    let issueSeverity = issue.severity;
    let settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');

    const ignoreInfo: boolean = settings.get("ignoreInfo", false);
    if (ignoreInfo && getDiagnosticSeverity(issueSeverity) === DiagnosticSeverity.Information) {
        return diagnosticArr;
    }

    const ignoreWarnings: boolean = settings.get("ignoreWarnings", false);
    if (ignoreWarnings && getDiagnosticSeverity(issueSeverity) === DiagnosticSeverity.Warning) {
        return diagnosticArr;
    }

    for (let location of issue.locations) {
        const cflintIssue: CFLintIssue = {
            id: issue.id,
            severity: issue.severity,
            file: location.file,
            fileName: location.fileName,
            line: location.line,
            column: location.column,
            message: location.message,
            variable: location.variable,
            function: location.function,
            expression: location.expression
        };

        diagnosticArr.push(makeDiagnostic(cflintIssue));
    }

    return diagnosticArr;
}

/**
 * Takes a CFLintIssue and makes a Diagnostic from it.
 *
 * @param issue The issue structured as a CFLintIssue.
 * @return A Diagnostic object corresponding to the problem.
 */
function makeDiagnostic(issue: CFLintIssue): Diagnostic {
    // Ensure that the start and end are >=0
    if (issue.line <= 0) {
        issue.line = 1;
    }
    if (issue.column <= 0) {
        issue.column = 1;
    }

    let start: Position = new Position(issue.line - 1, issue.column - 1);
    let end: Position = new Position(issue.line - 1, issue.column - 1);

    return {
        message: `${issue.id}: ${issue.message}`,
        severity: getDiagnosticSeverity(issue.severity),
        source: 'cflint',
        code: issue.id,
        range: new Range(start, end)
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
        case 'fatal':
        case 'critical':
        case 'error':
            problemSeverity = DiagnosticSeverity.Error;
            break;
        case 'warning':
        case 'caution':
            problemSeverity = DiagnosticSeverity.Warning;
            break;
        case 'info':
        case 'cosmetic':
            problemSeverity = DiagnosticSeverity.Information;
            break;
        default:
            problemSeverity = DiagnosticSeverity.Information;
    }

    return problemSeverity;
}

/**
 * Lints the given document.
 *
 * @param document The document being linted.
 */
function lintDocument(document: TextDocument): void {
    if (!jarPathExists()) {
        showInvalidJarPathMessage();
        return;
    }

    if (isOnCooldown(document)) {
        return;
    }

    linterCooldowns.set(document.uri, Date.now());

    onLintDocument(document);
}

/**
 * Lints the given document.
 *
 * @param document The document being linted.
 */
function onLintDocument(document: TextDocument): void {
    let settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');

    let javaExecutable: string = findJavaExecutable();

    let javaArgs: string[] = [
        "-jar",
        settings.get("jarPath", ""),
        "-stdin",
        document.fileName,
        "-q",
        "-e",
        "-json",
        "-stdout"
    ];

    // TODO: This should only be necessary for an alternate config file when file can be detected for stdin
    const configFile: string = getConfigFile(document, configFileName);
    const altConfigFile: string = settings.get('altConfigFile', '');
    if (configFile) {
        javaArgs.push("-configfile", configFile);
    }

    for (let idx: number = 0; idx < javaArgs.length; idx++) {
        if (javaArgs[idx].includes(" ")) {
            javaArgs[idx] = `"${javaArgs[idx]}"`;
        }
    }

    let options = workspace.rootPath ? { cwd: workspace.rootPath } : undefined;

    let output: string = '';
    let childProcess = spawn(javaExecutable, javaArgs, options);
    if (childProcess.pid) {
        childProcess.stdin.write(document.getText(), "utf-8");
        childProcess.stdin.end();

        childProcess.stdout.on('data', (data: Buffer) => {
            output += data;
        });
        childProcess.stdout.on('end', () => {
            cfLintResult(document, output);
        });
    }
}

/**
 * Processes CFLint output into Diagnostics
 *
 * @param document Document being linted
 * @param output CFLint JSON output
 */
function cfLintResult(document: TextDocument, output: string): void {
    const parsedOutput = JSON.parse(output);
    const issues: CFLintIssueList[] = parsedOutput.issues;
    let diagnostics: Diagnostic[] = [];
    issues.forEach((issue: CFLintIssueList) => {
        diagnostics = diagnostics.concat(createDiagnostics(issue));
    });
    diagnosticCollection.set(document.uri, diagnostics);
}

/**
 * Opens a link that describes the rules.
 *
 * @param ruleId An optional identifer/code for a particular CFLint rule.
 */
function showRuleDocumentation(ruleId?: string): void {
    let cflintDocBaseURL: string = "https://github.com/cflint/CFLint/blob/master/RULES.md";
    if (ruleId && ruleId.length) {
        cflintDocBaseURL += "#" + ruleId.toLowerCase();
    }
    open(cflintDocBaseURL);
}

/**
 * Initializes settings helpful to this extension.
 */
function initializeSettings(): void {
    let settings: WorkspaceConfiguration = workspace.getConfiguration("files");
    let fileAssociations = settings.get("associations", {});
    fileAssociations[".cflintrc"] = "json";
    settings.update('associations', fileAssociations, true);
}

/**
 * This method is called when the extension is activated.
 *
 * @param context The context object for this extension.
 */
export function activate(context: ExtensionContext): void {

    console.log('cflint is active!');

    initializeSettings();

    diagnosticCollection = languages.createDiagnosticCollection('cflint');
    context.subscriptions.push(diagnosticCollection);

    typingDelayer = new Map<Uri, Delayer<void>>();
    linterCooldowns = new Map<Uri, number>();

    context.subscriptions.push(
        commands.registerCommand('cflint.enable', enable),
        commands.registerCommand('cflint.disable', disable),
        commands.registerCommand('cflint.viewRulesDoc', showRuleDocumentation)
    );

    context.subscriptions.push(commands.registerCommand('cflint.createWorkspaceConfig', () => {
        createDefaultConfiguration(workspace.rootPath);
    }));

    context.subscriptions.push(commands.registerCommand('cflint.openWorkspaceConfig', () => {
        let workspaceConfigPath = path.join(workspace.rootPath, configFileName);

        if (fs.existsSync(workspaceConfigPath)) {
            workspace.openTextDocument(workspaceConfigPath).then((textDocument: TextDocument) => {
                if (!textDocument) {
                    console.error('Could not open ' + workspaceConfigPath);
                    return;
                }

                window.showTextDocument(textDocument).then((editor: TextEditor) => {
                    if (!editor) {
                        console.error('Could not show ' + workspaceConfigPath);
                        return;
                    }
                });
            });
        } else {
            window.showErrorMessage('No config file could be found in the current workspace.');
        }
    }));

    context.subscriptions.push(commands.registerCommand('cflint.openActiveConfig', () => {
        let currentConfigPath = getConfigFile(window.activeTextEditor.document, configFileName);

        if (currentConfigPath) {
            workspace.openTextDocument(currentConfigPath).then((textDocument: TextDocument) => {
                if (!textDocument) {
                    console.error('Could not open ' + currentConfigPath);
                    return;
                }

                window.showTextDocument(textDocument).then((editor: TextEditor) => {
                    if (!editor) {
                        console.error('Could not show ' + currentConfigPath);
                        return;
                    }
                });
            });
        } else {
            window.showErrorMessage('No config file is being used for the currently active document.');
        }
    }));

    context.subscriptions.push(commands.registerCommand('cflint.createCwdConfig', () => {
        createDefaultConfiguration(path.dirname(window.activeTextEditor.document.fileName));
    }));

    context.subscriptions.push(commands.registerCommand('cflint.runLinter', () => {
        if (!isLinterEnabled()) {
            window.showWarningMessage('cflint is disabled');
            return;
        }

        lintDocument(window.activeTextEditor.document);
    }));

    context.subscriptions.push(workspace.onDidOpenTextDocument((evt: TextDocument) => {
        let settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
        let runModes: RunModes = settings.get("runModes");
        if (!isCfmlLanguage(evt.languageId) || !isLinterEnabled() || !runModes.onOpen) {
            return;
        }

        if (!evt.uri.path || (path.basename(evt.uri.path) === evt.uri.path && !fs.existsSync(evt.uri.path))) {
            return;
        }

        // Exclude files opened by vscode for Git
        if (evt.uri.scheme === 'git') {
            return;
        }

        lintDocument(evt);
    }));

    context.subscriptions.push(workspace.onDidSaveTextDocument((evt: TextDocument) => {
        let settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
        let runModes: RunModes = settings.get("runModes");

        if (!isCfmlLanguage(evt.languageId) || !isLinterEnabled() || !runModes.onSave) {
            return;
        }

        lintDocument(evt);
    }));

    context.subscriptions.push(workspace.onDidChangeTextDocument((evt: TextDocumentChangeEvent) => {
        let settings: WorkspaceConfiguration = workspace.getConfiguration('cflint');
        let runModes: RunModes = settings.get("runModes");
        if (!isCfmlLanguage(evt.document.languageId) || !isLinterEnabled() || !runModes.onChange) {
            return;
        }

        // Exclude files opened by vscode for Git
        if (evt.document.uri.scheme === 'git') {
            return;
        }

        let delayer = typingDelayer.get(evt.document.uri);
        if (!delayer) {
            let typingDelay: number = settings.get("typingDelay", defaultTypingDelay);
            delayer = new Delayer<void>(typingDelay);
            typingDelayer.set(evt.document.uri, delayer);
        }
        console.log("[" + getCurrentTimeFormatted() + "] Linter checked");
        delayer.trigger(() => {
            lintDocument(evt.document);
            typingDelayer.delete(evt.document.uri);
        });
    }));

    context.subscriptions.push(workspace.onDidCloseTextDocument((evt: TextDocument) => {
        if (!isCfmlLanguage(evt.languageId)) {
            return;
        }

        // Exclude files opened by vscode for Git
        if (evt.uri.scheme === 'git') {
            return;
        }

        // Clear everything for file when closed
        diagnosticCollection.delete(evt.uri);
        linterCooldowns.delete(evt.uri);
    }));

    // TODO: Add status bar indicator
}

/**
 * This method is called when the extension is deactivated.
 */
export function deactivate(): void {
}
