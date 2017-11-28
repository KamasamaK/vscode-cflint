import * as path from 'path';
import * as fs from 'fs';
import {
    workspace, window, commands, languages, WorkspaceConfiguration, ExtensionContext, Uri, StatusBarAlignment, StatusBarItem,
    TextDocument, TextDocumentChangeEvent, TextEditor, Diagnostic, DiagnosticSeverity, DiagnosticCollection, Range, Position, ConfigurationTarget
} from 'vscode';
import { Delayer } from './delayer';
import { spawn, ChildProcess } from 'child_process';

const findConfig = require('find-config');

const configFileName: string = ".cflintrc";
const configFileDefault: string = [
    '{',
    '   "rule" : [ ],',
    '   "excludes" : [ ],',
    '   "includes" : [ ],',
    '   "inheritParent" : false',
    '}'
].join(process.platform === "win32" ? "\r\n" : "\n");
const minimumTypingDelay: number = 200;
const minimumCooldown: number = 500;

let diagnosticCollection: DiagnosticCollection;
let typingDelayer: Map<Uri, Delayer<void>>;
let linterCooldowns: Map<Uri, number>;
let pendingLints: Map<Uri, ChildProcess>;
let queuedLints: Map<Uri, TextDocument>;
let statusBarItem: StatusBarItem;
let cflintState: State;

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

enum State {
    Stopped = 0,
    Running = 1
}

enum OutputFormat {
    Text = "text",
    Html = "html",
    Json = "json",
    Xml = "xml"
}

/**
 * Checks whether the language id is compatible with CFML.
 *
 * @param languageId The VSCode language id to check.
 * @return Indication of whether the language id is compatible with CFML.
 */
function isCfmlLanguage(languageId: string): boolean {
    return (languageId === "lang-cfml" ||
        languageId === "cfml");
}

/**
 * Enables linter.
 */
async function enable(): Promise<void> {
    if (!workspace.workspaceFolders) {
        window.showErrorMessage("CFLint can only be enabled if VS Code is opened on a workspace folder.");
        return;
    }
    let cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
    cflintSettings.update("enabled", true, ConfigurationTarget.Workspace);
    updateStatusBarItem(window.activeTextEditor);
}

/**
 * Disables linter.
 */
async function disable(): Promise<void> {
    if (!workspace.workspaceFolders) {
        window.showErrorMessage("CFLint can only be disabled if VS Code is opened on a workspace folder.");
        return;
    }
    let cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
    cflintSettings.update("enabled", false, ConfigurationTarget.Workspace);
    updateStatusBarItem(window.activeTextEditor);
}

/**
 * Checks whether the linter is enabled.
 */
function isLinterEnabled(): boolean {
    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
    return cflintSettings.get<boolean>("enabled", true);
}

/**
 * Checks whether the document is on cooldown.
 */
function isOnCooldown(document: TextDocument): boolean {
    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
    let cooldownSetting: number = cflintSettings.get<number>("linterCooldown");
    cooldownSetting = Math.max(cooldownSetting, minimumCooldown);

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
async function createDefaultConfiguration(directory: string): Promise<boolean> {
    if (!directory) {
        window.showErrorMessage("A CFLint configuration can only be generated if VS Code is opened on a workspace folder.");
        return false;
    }
    let cflintConfigFile: string = path.join(directory, configFileName);
    if (!fs.existsSync(cflintConfigFile)) {
        fs.writeFileSync(cflintConfigFile, configFileDefault, { encoding: "utf8" });
        window.showInformationMessage("Successfully created configuration file", "Open file").then(
            async (selection: string) => {
                if (selection === "Open file") {
                    const textDocument: TextDocument = await workspace.openTextDocument(cflintConfigFile);
                    window.showTextDocument(textDocument);
                }
            }
        );

        return true;
    } else {
        window.showErrorMessage("Configuration file already exists", "Open file").then(
            async (selection: string) => {
                if (selection === "Open file") {
                    const textDocument: TextDocument = await workspace.openTextDocument(cflintConfigFile);
                    window.showTextDocument(textDocument);
                }
            }
        );
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
    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
    const altConfigFile: string = cflintSettings.get<string>("altConfigFile.path", "");
    const altConfigFileUsage: string = cflintSettings.get<string>("altConfigFile.usage", "fallback");
    const altConfigFileExists: boolean = alternateConfigFileExists();

    if (altConfigFileExists && altConfigFileUsage === "always") {
        return altConfigFile;
    }

    const currentWorkingDir: string = path.dirname(document.fileName);
    const projectConfig: string = findConfig(fileName, { cwd: currentWorkingDir });
    if (projectConfig) {
        return projectConfig;
    }

    if (altConfigFileExists && altConfigFileUsage === "fallback") {
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
    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
    const altConfigFile: string = cflintSettings.get<string>("altConfigFile.path", "");
    return fs.existsSync(altConfigFile);
}

/**
 * Gets the proper Java bin name for the platform.
 *
 * @param binName
 * @return The Java bin name for the current platform.
 */
function correctJavaBinName(binName: string) {
    if (process.platform === "win32") {
        return binName + ".exe";
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
    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
    const javaPath: string = cflintSettings.get<string>("javaPath");
    const javaBinName = correctJavaBinName("java");

    // Start with setting
    if (javaPath) {
        if (fs.existsSync(javaPath) && fs.statSync(javaPath).isFile() && path.basename(javaPath) === javaBinName) {
            return javaPath;
        }

        window.showWarningMessage("Ignoring invalid cflint.javaPath setting. Please correct this.");
    }

    // Then search JAVA_HOME
    const envJavaHome = process.env["JAVA_HOME"];
    if (envJavaHome) {
        let javaPath = path.join(envJavaHome, "bin", javaBinName);

        if (javaPath && fs.existsSync(javaPath)) {
            return javaPath;
        }
    }

    // Then search PATH parts
    const envPath = process.env["PATH"];
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
 * Checks to see if cflint.jarPath resolves to a valid file path.
 *
 * @return Whether the JAR path in settings is a valid path.
 */
function jarPathExists(): boolean {
    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
    const jarPath: string = cflintSettings.get<string>("jarPath", "");
    return validateFilePath(jarPath) === "";
}

/**
 * Checks to see if cflint.outputDirectory resolves to a valid directory path.
 *
 * @return Whether the output directory path in settings is a valid path.
 */
function outputPathExists(): boolean {
    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
    const outputDirectory: string = cflintSettings.get<string>("outputDirectory", "");
    return validateDirectoryPath(outputDirectory) === "";
}

/**
 * Checks if the input string resolves to a valid file path.
 *
 * @param input The path to check validity.
 * @return Empty string if valid, else an error message.
 */
function validateFilePath(input: string): string {
    if (fs.existsSync(input) && fs.statSync(input).isFile()) {
        return "";
    }

    return "This is not a valid file path";
}

/**
 * Checks if the input string resolves to a valid directory path.
 *
 * @param input The path to check validity.
 * @return Empty string if valid, else an error message.
 */
function validateDirectoryPath(input: string): string {
    if (fs.existsSync(input) && fs.statSync(input).isDirectory()) {
        return "";
    }

    return "This is not a valid directory path";
}

/**
 * Displays error message indicating that cflint.jarPath needs to be set to a valid path, and optionally prompts for path.
 */
function showInvalidJarPathMessage(): void {
    window.showErrorMessage("You must set cflint.jarPath to a valid path in your settings", "Set now").then(
        (selection: string) => {
            if (selection === "Set now") {
                let cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
                const jarPath: string = cflintSettings.get<string>("jarPath", "");
                window.showInputBox({
                    prompt: "A path to the CFLint standalone JAR file",
                    value: jarPath,
                    ignoreFocusOut: true,
                    validateInput: validateFilePath
                }).then((val: string) => {
                    cflintSettings.update("jarPath", val, ConfigurationTarget.Global);
                });
            }
        }
    );
}

/**
 * Displays error message indicating that cflint.outputDirectory needs to be set to a valid directory, and optionally prompts for one.
 */
function showInvalidOutputDirectoryMessage(): void {
    window.showErrorMessage("You must set cflint.outputDirectory to a valid directory in your settings", "Set now").then(
        (selection: string) => {
            if (selection === "Set now") {
                let cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
                const outputDirectory: string = cflintSettings.get<string>("outputDirectory", "");
                window.showInputBox({
                    prompt: "A directory in which to place output files",
                    value: outputDirectory,
                    ignoreFocusOut: true,
                    validateInput: validateDirectoryPath
                }).then((val: string) => {
                    cflintSettings.update("outputDirectory", val, ConfigurationTarget.Global);
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

    const issueSeverity = issue.severity;
    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");

    const ignoreInfo: boolean = cflintSettings.get<boolean>("ignoreInfo", false);
    if (ignoreInfo && getDiagnosticSeverity(issueSeverity) === DiagnosticSeverity.Information) {
        return diagnosticArr;
    }

    const ignoreWarnings: boolean = cflintSettings.get<boolean>("ignoreWarnings", false);
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

    const start: Position = new Position(issue.line - 1, issue.column - 1);
    const end: Position = new Position(issue.line - 1, issue.column - 1);

    return {
        message: `${issue.id}: ${issue.message}`,
        severity: getDiagnosticSeverity(issue.severity),
        source: "cflint",
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

    if (isOnCooldown(document) || pendingLints.has(document.uri) || queuedLints.has(document.uri)) {
        return;
    }

    linterCooldowns.set(document.uri, Date.now());

    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
    const maxSimultaneousLints: number = cflintSettings.get<number>("maxSimultaneousLints");
    if (pendingLints.size > maxSimultaneousLints) {
        queuedLints.set(document.uri, document);
        return;
    }

    onLintDocument(document);
}

/**
 * Lints the given document, outputting to Diagnostics.
 *
 * @param document The document being linted.
 */
function onLintDocument(document: TextDocument): void {
    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");

    const javaExecutable: string = findJavaExecutable();

    let javaArgs: string[] = [
        "-jar",
        cflintSettings.get<string>("jarPath", ""),
        "-stdin",
        document.fileName,
        "-q",
        "-e",
        "-json",
        "-stdout"
    ];

    // TODO: This should only be necessary for an alternate config file when file can be detected for stdin
    const configFile: string = getConfigFile(document, configFileName);
    // const altConfigFile: string = cflintSettings.get<string>("altConfigFile.path", "");
    if (configFile) {
        javaArgs.push("-configfile", configFile);
    }

    let output: string = "";
    let childProcess: ChildProcess = spawn(javaExecutable, javaArgs);
    console.log(`[${getCurrentTimeFormatted()}] ${javaExecutable} ${javaArgs.join(" ")}`);

    if (childProcess.pid) {
        pendingLints.set(document.uri, childProcess);
        childProcess.stdin.write(document.getText(), "utf-8");
        childProcess.stdin.end();
        updateState(State.Running);

        childProcess.stdout.on("data", (data: Buffer) => {
            output += data;
        });
        childProcess.stdout.on("end", () => {
            if (output && output.length > 0) {
                cfLintResult(document, output);
            }
            pendingLints.delete(document.uri);
            if (queuedLints.size > 0) {
                const nextKey: Uri = queuedLints.keys().next().value;
                onLintDocument(queuedLints.get(nextKey));
                queuedLints.delete(nextKey);
            }
            if (pendingLints.size === 0) {
                updateState(State.Stopped);
            }
        });
    }

    childProcess.on("error", (err: Error) => {
        window.showErrorMessage("There was a problem with CFLint. " + err.message);
        console.error(`[${getCurrentTimeFormatted()}] ${childProcess}`);
        console.error(`[${getCurrentTimeFormatted()}] ${err}`);
    });
}

/**
 * Lints the given document, outputting to a file.
 *
 * @param document The document being linted.
 * @param format The format of the output.
 */
function outputLintDocument(document: TextDocument, format: OutputFormat = OutputFormat.Html): void {
    if (!jarPathExists()) {
        showInvalidJarPathMessage();
        return;
    }

    if (!outputPathExists()) {
        showInvalidOutputDirectoryMessage();
        return;
    }

    const cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");

    // TODO: Prompt if not valid
    const outputDirectory = cflintSettings.get<string>("outputDirectory", "");
    let outputFileName = `cflint-results-${path.parse(document.fileName).name}-${Date.now()}`;

    let fileCommand: string;
    switch (format) {
        case OutputFormat.Text:
            fileCommand = "-textfile";
            outputFileName += ".txt";
            break;
        case OutputFormat.Html:
            fileCommand = "-htmlfile";
            outputFileName += ".html";
            break;
        case OutputFormat.Json:
            fileCommand = "-jsonfile";
            outputFileName += ".json";
            break;
        case OutputFormat.Xml:
            fileCommand = "-xmlfile";
            outputFileName += ".xml";
            break;
        default:
            fileCommand = "-htmlfile";
            outputFileName += ".html";
            break;
    }

    const fullOutputPath: string = path.join(outputDirectory, outputFileName);

    const javaExecutable: string = findJavaExecutable();

    let javaArgs: string[] = [
        "-jar",
        cflintSettings.get<string>("jarPath", ""),
        "-stdin",
        document.fileName,
        "-q",
        "-e",
        `-${format}`,
        fileCommand,
        fullOutputPath
    ];

    // TODO: This should only be necessary for an alternate config file when file can be detected for stdin
    const configFile: string = getConfigFile(document, configFileName);
    // const altConfigFile: string = cflintSettings.get<string>("altConfigFile.path", "");
    if (configFile) {
        javaArgs.push("-configfile", configFile);
    }

    let childProcess: ChildProcess = spawn(javaExecutable, javaArgs);
    console.log(`[${getCurrentTimeFormatted()}] ${javaExecutable} ${javaArgs.join(" ")}`);

    if (childProcess.pid) {
        childProcess.stdin.write(document.getText(), "utf-8");
        childProcess.stdin.end();

        updateState(State.Running);

        childProcess.on("exit", () => {
            if (pendingLints.size === 0) {
                updateState(State.Stopped);
            }
        });
    }

    childProcess.on("error", (err: Error) => {
        window.showErrorMessage("There was a problem with CFLint. " + err.message);
        console.error(`[${getCurrentTimeFormatted()}] ${childProcess}`);
        console.error(`[${getCurrentTimeFormatted()}] ${err}`);
    });
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
async function showRuleDocumentation(ruleId?: string): Promise<void> {
    let cflintRulesDocURL: string = "https://github.com/cflint/CFLint/blob/master/RULES.md";

    if (ruleId) {
        cflintRulesDocURL += "#" + ruleId.toLowerCase();
    }
    const cflintRulesUri: Uri = Uri.parse(cflintRulesDocURL);

    // commands.executeCommand('markdown.showPreview', cflintRulesUri);
    commands.executeCommand('vscode.open', cflintRulesUri);
}

/**
 * Displays or hides CFLint status bar item
 *
 * @param show If true, status bar item is shown, else it's hidden
 */
function showStatusBarItem(show: boolean): void {
    if (show) {
        statusBarItem.show();
    } else {
        statusBarItem.hide();
    }
}

/**
 * Updates the CFLint state
 *
 * @param state enum representing the new state of CFLint
 */
function updateState(state: State) {
    cflintState = state;
    updateStatusBarItem(window.activeTextEditor);
}

/**
 * Updates CFLint status bar item based on current settings and state
 *
 * @param editor The active text editor
 */
function updateStatusBarItem(editor: TextEditor): void {
    switch (cflintState) {
        case State.Running:
            statusBarItem.text = "CFLint $(pulse)";
            statusBarItem.tooltip = "Linter is running.";
            break;
        case State.Stopped:
            statusBarItem.text = "CFLint";
            statusBarItem.tooltip = "Linter is stopped.";
            break;
    }

    showStatusBarItem(
        isLinterEnabled() && editor && isCfmlLanguage(editor.document.languageId) && editor.document.uri.scheme !== "git"
    );
}

/**
 * Initializes settings helpful to this extension.
 */
function initializeSettings(): void {
    let fileSettings: WorkspaceConfiguration = workspace.getConfiguration("files");
    let fileAssociations = fileSettings.get("associations", {});
    fileAssociations[".cflintrc"] = "json";
    fileSettings.update("associations", fileAssociations, ConfigurationTarget.Global);
}

/**
 * This method is called when the extension is activated.
 *
 * @param context The context object for this extension.
 */
export function activate(context: ExtensionContext): void {

    console.log(`[${getCurrentTimeFormatted()}] cflint is active!`);

    initializeSettings();

    diagnosticCollection = languages.createDiagnosticCollection("cflint");

    typingDelayer = new Map<Uri, Delayer<void>>();
    linterCooldowns = new Map<Uri, number>();
    pendingLints = new Map<Uri, ChildProcess>();
    queuedLints = new Map<Uri, TextDocument>();

    statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 0);
    statusBarItem.text = "CFLint";

    context.subscriptions.push(
        commands.registerCommand("cflint.enable", enable),
        commands.registerCommand("cflint.disable", disable),
        commands.registerCommand("cflint.viewRulesDoc", showRuleDocumentation),
        diagnosticCollection,
        statusBarItem
    );

    context.subscriptions.push(commands.registerCommand("cflint.createRootConfig", () => {
        const workspaceFolder = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri);
        createDefaultConfiguration(workspaceFolder.uri.fsPath);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.openRootConfig", async () => {
        const workspaceFolder = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri);

        let rootConfigPath = path.join(workspaceFolder.uri.fsPath, configFileName);

        if (fs.existsSync(rootConfigPath)) {
            const textDocument: TextDocument = await workspace.openTextDocument(rootConfigPath);
            window.showTextDocument(textDocument);
        } else {
            window.showErrorMessage("No config file could be found in the current workspace folder.");
        }
    }));

    context.subscriptions.push(commands.registerCommand("cflint.openActiveConfig", async () => {
        let currentConfigPath = getConfigFile(window.activeTextEditor.document, configFileName);

        if (currentConfigPath) {
            const textDocument: TextDocument = await workspace.openTextDocument(currentConfigPath);
            window.showTextDocument(textDocument);
        } else {
            window.showErrorMessage("No config file is being used for the currently active document.");
        }
    }));

    context.subscriptions.push(commands.registerCommand("cflint.createCwdConfig", () => {
        createDefaultConfiguration(path.dirname(window.activeTextEditor.document.fileName));
    }));

    context.subscriptions.push(commands.registerCommand("cflint.runLinter", () => {
        if (!isLinterEnabled()) {
            window.showWarningMessage("cflint is disabled");
            return;
        }

        lintDocument(window.activeTextEditor.document);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.outputTextFile", () => {
        outputLintDocument(window.activeTextEditor.document, OutputFormat.Text);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.outputHtmlFile", () => {
        outputLintDocument(window.activeTextEditor.document, OutputFormat.Html);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.outputJsonFile", () => {
        outputLintDocument(window.activeTextEditor.document, OutputFormat.Json);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.outputXmlFile", () => {
        outputLintDocument(window.activeTextEditor.document, OutputFormat.Xml);
    }));

    // TODO: Add command for running linter for all opened CFML files. Needs refactoring.

    context.subscriptions.push(workspace.onDidOpenTextDocument((evt: TextDocument) => {
        let cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
        let runModes: RunModes = cflintSettings.get("runModes");
        if (!isCfmlLanguage(evt.languageId) || !isLinterEnabled() || !runModes.onOpen) {
            return;
        }

        if (!evt.uri.path || (path.basename(evt.uri.path) === evt.uri.path && !fs.existsSync(evt.uri.path))) {
            return;
        }

        // Exclude files opened by vscode for Git
        if (evt.uri.scheme === "git") {
            return;
        }

        lintDocument(evt);
    }));

    context.subscriptions.push(workspace.onDidSaveTextDocument((evt: TextDocument) => {
        let cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
        let runModes: RunModes = cflintSettings.get("runModes");

        if (!isCfmlLanguage(evt.languageId) || !isLinterEnabled() || !runModes.onSave) {
            return;
        }

        lintDocument(evt);
    }));

    context.subscriptions.push(workspace.onDidChangeTextDocument((evt: TextDocumentChangeEvent) => {
        let cflintSettings: WorkspaceConfiguration = workspace.getConfiguration("cflint");
        let runModes: RunModes = cflintSettings.get("runModes");
        if (!isCfmlLanguage(evt.document.languageId) || !isLinterEnabled() || !runModes.onChange) {
            return;
        }

        // Exclude files opened by vscode for Git
        if (evt.document.uri.scheme === "git") {
            return;
        }

        let delayer = typingDelayer.get(evt.document.uri);
        if (!delayer) {
            let typingDelay: number = cflintSettings.get<number>("typingDelay");
            typingDelay = Math.max(typingDelay, minimumTypingDelay);
            delayer = new Delayer<void>(typingDelay);
            typingDelayer.set(evt.document.uri, delayer);
        }

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
        if (evt.uri.scheme === "git") {
            return;
        }

        // Clear everything for file when closed
        if (pendingLints.has(evt.uri)) {
            pendingLints.get(evt.uri).kill();
            pendingLints.delete(evt.uri);
        }
        diagnosticCollection.delete(evt.uri);
        linterCooldowns.delete(evt.uri);
        queuedLints.delete(evt.uri);

        if (pendingLints.size === 0) {
            updateState(State.Stopped);
        }
    }));

    context.subscriptions.push(commands.registerCommand("cflint.clearActiveDocumentProblems", () => {
        diagnosticCollection.delete(window.activeTextEditor.document.uri);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.clearAllProblems", () => {
        diagnosticCollection.clear();
    }));

    context.subscriptions.push(window.onDidChangeActiveTextEditor(updateStatusBarItem));

    updateStatusBarItem(window.activeTextEditor);
}

/**
 * This method is called when the extension is deactivated.
 */
export function deactivate(): void {
}
