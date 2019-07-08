import * as Octokit from "@octokit/rest";
import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as micromatch from "micromatch";
import * as path from "path";
import * as semver from "semver";
import { commands, ConfigurationTarget, Diagnostic, DiagnosticCollection, DocumentFilter, env, ExtensionContext, extensions, languages, OpenDialogOptions, StatusBarAlignment, StatusBarItem, TextDocument, TextDocumentChangeEvent, TextEditor, Uri, window, workspace, WorkspaceConfiguration } from "vscode";
import { CFMLApiV0 } from "../typings/cfmlApi";
import CFLintCodeActionProvider from "./codeActions";
import { addConfigRuleExclusion, CONFIG_FILENAME, createCwdConfig, createRootConfig, getConfigFilePath, showActiveConfig, showRootConfig } from "./config";
import { createDiagnostics } from "./diagnostics";
import { CFLintIssueList } from "./issues";
import { ThrottledDelayer } from "./utils/async";
import { getCurrentDateTimeFormatted } from "./utils/dateUtil";

const octokit = new Octokit();
const gitRepoInfo = {
    owner: "cflint",
    repo: "CFLint",
    defaultBranch: "master"
};
const httpSuccessStatusCode: number = 200;

export let extensionPath: string;
export let logPath: string;
export let cfmlApi: CFMLApiV0;

export const LANGUAGE_IDS = ["cfml"];
let DOCUMENT_SELECTOR: DocumentFilter[] = [];
LANGUAGE_IDS.forEach((languageId: string) => {
    DOCUMENT_SELECTOR.push(
        {
            language: languageId,
            scheme: "file"
        }
    );
    DOCUMENT_SELECTOR.push(
        {
            language: languageId,
            scheme: "untitled"
        }
    );
});

const settingsSection = "cflint";
let minimumTypingDelay: number;
let minimumCooldown: number;

let diagnosticCollection: DiagnosticCollection;
let typingDelayer: Map<Uri, ThrottledDelayer<void>>;
let linterCooldowns: Map<Uri, number>;
let runningLints: Map<Uri, ChildProcess>;
let queuedLints: Map<Uri, TextDocument>;
let statusBarItem: StatusBarItem;
let cflintState: State;
let rulesLastRetrieved: Date;

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

const minimumCFLintVersion: string = "1.4.0";
let versionPrompted: boolean = false;

/**
 * Checks whether the language id is compatible with CFML.
 *
 * @param languageId The VSCode language id to check.
 * @return Indication of whether the language id is compatible with CFML.
 */
function isCfmlLanguage(languageId: string): boolean {
    return LANGUAGE_IDS.includes(languageId);
}

/**
 * Enables linter.
 */
async function enable(): Promise<void> {
    if (!workspace.workspaceFolders) {
        window.showErrorMessage("CFLint can only be enabled if VS Code is opened on a workspace folder.");
        return;
    }
    let cflintSettings: WorkspaceConfiguration = getCFLintSettings(window.activeTextEditor.document.uri);
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
    let cflintSettings: WorkspaceConfiguration = getCFLintSettings(window.activeTextEditor.document.uri);
    cflintSettings.update("enabled", false, ConfigurationTarget.Workspace);
    updateStatusBarItem(window.activeTextEditor);
}

/**
 * Checks whether the linter is enabled.
 *
 * @param resource The Uri of the document to check against
 */
function isLinterEnabled(resource: Uri): boolean {
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(resource);
    return cflintSettings.get<boolean>("enabled", true);
}

/**
 * Checks whether the given document matches the set of excluded globs.
 *
 * @param document The document to check against
 */
function shouldExcludeDocument(document: TextDocument): boolean {
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(document.uri);
    const excludeGlobs = cflintSettings.get<string[]>("exclude", []);
    const relativePath = workspace.asRelativePath(document.uri);

    return micromatch.some(relativePath, excludeGlobs);
}

/**
 * Checks whether the given document should be linted.
 *
 * @param document The document to check against
 */
function shouldLintDocument(document: TextDocument): boolean {
    return isLinterEnabled(document.uri)
        && isCfmlLanguage(document.languageId)
        && !shouldExcludeDocument(document)
        && document.uri.scheme !== "git";
}

/**
 * Checks whether the document is on cooldown.
 * @param document The TextDocument for which to check cooldown status
 */
function isOnCooldown(document: TextDocument): boolean {
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(document.uri);
    let cooldownSetting: number = cflintSettings.get<number>("linterCooldown");
    cooldownSetting = Math.max(cooldownSetting, minimumCooldown);

    const documentCooldown: number = linterCooldowns.get(document.uri);

    if (documentCooldown && (Date.now() - documentCooldown) < cooldownSetting) {
        return true;
    }

    return false;
}

/**
 * Retrieves VSCode settings for CFLint
 *
 * @param resource The Uri of the document to check against
 */
export function getCFLintSettings(resource: Uri = null): WorkspaceConfiguration {
    return workspace.getConfiguration(settingsSection, resource);
}

/**
 * Gets the proper Java bin name for the platform.
 *
 * @param binName The base name for the bin file
 * @return The Java bin name for the current platform.
 */
function correctJavaBinName(binName: string): string {
    if (process.platform === "win32") {
        return binName + ".exe";
    } else {
        return binName;
    }
}

/**
 * Gets the full path to the java executable to be used.
 *
 * @param resource The URI of the resource for which to check the path
 * @return The full path to the java executable.
 */
function findJavaExecutable(resource: Uri): string {
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(resource);
    const javaPath: string = cflintSettings.get<string>("javaPath");
    const javaBinName: string = correctJavaBinName("java");

    // Start with setting
    if (javaPath) {
        if (fs.existsSync(javaPath) && fs.statSync(javaPath).isFile() && path.basename(javaPath) === javaBinName) {
            return javaPath;
        }

        window.showWarningMessage("Ignoring invalid cflint.javaPath setting. Please correct this.");
    }

    // Check back on "find-java-home" using `allowJre: true`?

    // Then search JAVA_HOME
    const envJavaHome = process.env["JAVA_HOME"];
    if (envJavaHome) {
        const javaPath = path.join(envJavaHome, "bin", javaBinName);

        if (javaPath && fs.existsSync(javaPath)) {
            return javaPath;
        }
    }

    // Then search PATH parts
    const envPath = process.env["PATH"];
    if (envPath) {
        const pathParts: string[] = envPath.split(path.delimiter);
        for (const pathPart of pathParts) {
            let javaPath: string = path.join(pathPart, javaBinName);
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
function jarPathExists(resource: Uri): boolean {
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(resource);
    const jarPath: string = cflintSettings.get<string>("jarPath", "");
    return validateFilePath(jarPath) === "";
}

/**
 * Checks to see if cflint.outputDirectory resolves to a valid directory path.
 *
 * @return Whether the output directory path in settings is a valid path.
 */
function outputPathExists(resource: Uri): boolean {
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(resource);
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
 * @param resource The resource being linted when this message was generated
 */
function showInvalidJarPathMessage(resource: Uri): void {
    window.showErrorMessage("You must set cflint.jarPath to a valid path in your settings", "Set now").then(
        (selection: string) => {
            if (selection === "Set now") {
                let cflintSettings: WorkspaceConfiguration = getCFLintSettings(resource);
                const cflintJarPathValues = cflintSettings.inspect<string>("jarPath");
                let configTarget: ConfigurationTarget;
                if (cflintJarPathValues.workspaceFolderValue) {
                    configTarget = ConfigurationTarget.WorkspaceFolder;
                } else if (cflintJarPathValues.workspaceValue) {
                    configTarget = ConfigurationTarget.Workspace;
                } else {
                    configTarget = ConfigurationTarget.Global;
                }
                const jarPath: string = cflintSettings.get<string>("jarPath", "");

                let openDialogOptions: OpenDialogOptions = {
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    openLabel: "Select",
                    filters: { "JAR": ["jar"] }
                };

                if (jarPath) {
                    try {
                        const dirPath: string = path.dirname(jarPath);
                        if (dirPath) {
                            openDialogOptions.defaultUri = Uri.file(dirPath);
                        }
                    } catch (err) {
                        // noop
                    }
                }

                window.showOpenDialog(openDialogOptions).then((uris: Uri[] | undefined) => {
                    if (uris && uris.length === 1) {
                        cflintSettings.update("jarPath", uris[0].fsPath, configTarget);
                    }
                });
            }
        }
    );
}

/**
 * Displays error message indicating that cflint.outputDirectory needs to be set to a valid directory, and optionally prompts for one.
 * @param resource The resource being linted when this message was generated
 */
function showInvalidOutputDirectoryMessage(resource: Uri): void {
    window.showErrorMessage("You must set cflint.outputDirectory to a valid existing directory in your settings", "Set now").then(
        (selection: string) => {
            if (selection === "Set now") {
                let cflintSettings: WorkspaceConfiguration = getCFLintSettings(resource);

                const cflintOutputDirValues = cflintSettings.inspect<string>("outputDirectory");
                let configTarget: ConfigurationTarget;
                if (cflintOutputDirValues.workspaceFolderValue) {
                    configTarget = ConfigurationTarget.WorkspaceFolder;
                } else if (cflintOutputDirValues.workspaceValue) {
                    configTarget = ConfigurationTarget.Workspace;
                } else {
                    configTarget = ConfigurationTarget.Global;
                }
                const outputDirectory: string = cflintSettings.get<string>("outputDirectory", "");

                let openDialogOptions: OpenDialogOptions = {
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: "Select"
                };

                if (outputDirectory) {
                    try {
                        const dirPath: string = path.dirname(outputDirectory);
                        if (dirPath) {
                            openDialogOptions.defaultUri = Uri.file(dirPath);
                        }
                    } catch (err) {
                        // noop
                    }
                }

                window.showOpenDialog(openDialogOptions).then((uris: Uri[] | undefined) => {
                    if (uris && uris.length === 1) {
                        cflintSettings.update("outputDirectory", uris[0].fsPath, configTarget);
                    }
                });
            }
        }
    );
}

/**
 * Lints the given document.
 *
 * @param document The document being linted.
 */
function lintDocument(document: TextDocument): void {
    if (!jarPathExists(document.uri)) {
        showInvalidJarPathMessage(document.uri);
        return;
    }

    if (isOnCooldown(document) || runningLints.has(document.uri) || queuedLints.has(document.uri)) {
        return;
    }

    linterCooldowns.set(document.uri, Date.now());

    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(document.uri);
    const maxSimultaneousLints: number = cflintSettings.get<number>("maxSimultaneousLints");
    if (runningLints.size >= maxSimultaneousLints) {
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
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(document.uri);

    const javaExecutable: string = findJavaExecutable(document.uri);

    const options = workspace.rootPath ? { cwd: workspace.rootPath } : undefined;
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

    const altConfigFile: string = cflintSettings.get<string>("altConfigFile.path", "");
    if (altConfigFile) {
        const configFile: string = getConfigFilePath(document);
        if (configFile) {
            javaArgs.push("-configfile", configFile);
        }
    }

    let output: string = "";

    try {
        let childProcess: ChildProcess = spawn(javaExecutable, javaArgs, options);
        console.log(`[${getCurrentDateTimeFormatted()}] ${javaExecutable} ${javaArgs.join(" ")}`);

        if (childProcess.pid) {
            runningLints.set(document.uri, childProcess);
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
                runningLints.delete(document.uri);
                if (queuedLints.size > 0) {
                    const nextKey: Uri = queuedLints.keys().next().value;
                    onLintDocument(queuedLints.get(nextKey));
                    queuedLints.delete(nextKey);
                }
                if (runningLints.size === 0) {
                    updateState(State.Stopped);
                }
            });
        }

        childProcess.on("error", (err: Error) => {
            window.showErrorMessage(`There was a problem with CFLint. ${err.message}`);
            console.error(`[${getCurrentDateTimeFormatted()}] ${childProcess}`);
            console.error(`[${getCurrentDateTimeFormatted()}] ${err}`);
        });
    } catch (err) {
        console.error(err);
    }
}

/**
 * Lints the given document, outputting to a file.
 *
 * @param document The document being linted.
 * @param format The format of the output.
 */
function outputLintDocument(document: TextDocument, format: OutputFormat = OutputFormat.Html): void {
    if (!jarPathExists(document.uri)) {
        showInvalidJarPathMessage(document.uri);
        return;
    }

    if (!outputPathExists(document.uri)) {
        showInvalidOutputDirectoryMessage(document.uri);
        return;
    }

    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(document.uri);

    const outputDirectory: string = cflintSettings.get<string>("outputDirectory", "");
    let outputFileName: string = `cflint-results-${path.parse(document.fileName).name}-${Date.now()}`;

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

    const javaExecutable: string = findJavaExecutable(document.uri);

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

    const altConfigFile: string = cflintSettings.get<string>("altConfigFile.path", "");
    if (altConfigFile) {
        const configFile: string = getConfigFilePath(document);
        if (configFile) {
            javaArgs.push("-configfile", configFile);
        }
    }

    let childProcess: ChildProcess = spawn(javaExecutable, javaArgs);
    console.log(`[${getCurrentDateTimeFormatted()}] ${javaExecutable} ${javaArgs.join(" ")}`);

    if (childProcess.pid) {
        childProcess.stdin.write(document.getText(), "utf-8");
        childProcess.stdin.end();

        updateState(State.Running);

        childProcess.on("exit", () => {
            if (runningLints.size === 0) {
                updateState(State.Stopped);
            }
        });
    }

    childProcess.on("error", (err: Error) => {
        window.showErrorMessage(`There was a problem with CFLint. ${err.message}`);
        console.error(`[${getCurrentDateTimeFormatted()}] ${childProcess}`);
        console.error(`[${getCurrentDateTimeFormatted()}] ${err}`);
    });
}


/**
 * Displays a notification message recommending an upgrade of CFLint
 */
async function notifyForMinimumVersion(): Promise<void> {
    window.showErrorMessage(`You must upgrade CFLint to ${minimumCFLintVersion} or higher.`, "Download").then(
        (selection: string) => {
            if (selection === "Download") {
                showCFLintReleases();
            }
        }
    );
}

/**
 * Checks for newer version of CFLint
 *
 * @param currentVersion The current version of CFLint being used
 */
async function checkForLatestRelease(currentVersion: string): Promise<void> {
    let cflintSettings: WorkspaceConfiguration = getCFLintSettings();
    let notifyLatestVersion = cflintSettings.get("notify.latestVersion", true);

    if (!notifyLatestVersion) {
        return;
    }

    const latestReleaseResult: Octokit.Response<Octokit.ReposGetLatestReleaseResponse> = await octokit.repos.getLatestRelease({ owner: gitRepoInfo.owner, repo: gitRepoInfo.repo });

    if (latestReleaseResult && latestReleaseResult.hasOwnProperty("status") && latestReleaseResult.status === httpSuccessStatusCode && semver.lt(currentVersion, latestReleaseResult.data.tag_name.replace(/[^\d]*/, ""))) {
        notifyForLatestRelease(latestReleaseResult.data.tag_name);
    }
}

/**
 * Displays a notification message informing of a newer version of CFLint
 *
 * @param tagName The Git tag name for the latest release of CFLint
 */
async function notifyForLatestRelease(tagName: string): Promise<void> {
    // Provide option to disable cflint.notify.latestVersion?
    window.showInformationMessage(`There is a newer release of CFLint available: ${tagName}`, "Download").then(
        (selection: string) => {
            if (selection === "Download") {
                showCFLintReleases();
            }
        }
    );
}

/**
 * Processes CFLint output into Diagnostics
 *
 * @param document Document being linted
 * @param output CFLint JSON output
 */
function cfLintResult(document: TextDocument, output: string): void {
    const parsedOutput = JSON.parse(output);

    if (!versionPrompted) {
        if (!parsedOutput.hasOwnProperty("version") || semver.lt(parsedOutput.version, minimumCFLintVersion)) {
            notifyForMinimumVersion();
        } else {
            checkForLatestRelease(parsedOutput.version);
        }

        versionPrompted = true;
    }

    const issues: CFLintIssueList[] = parsedOutput.issues;
    let diagnostics: Diagnostic[] = [];
    issues.forEach((issue: CFLintIssueList) => {
        diagnostics = diagnostics.concat(createDiagnostics(document, issue));
    });
    diagnosticCollection.set(document.uri, diagnostics);
}

/**
 * Opens a link that describes the rules.
 *
 * @param _ruleId An optional identifer/code for a particular CFLint rule.
 */
async function showRuleDocumentation(_ruleId?: string): Promise<void> {
    const cflintRulesFileName: string = "RULES.md";
    const cflintRulesFilePath: string = path.join(extensionPath, "resources", cflintRulesFileName);
    const millisecondsInHour = 3600000;

    if (!rulesLastRetrieved || (Date.now() - rulesLastRetrieved.getTime()) < millisecondsInHour) {
        try {
            const cflintRulesResult = await octokit.repos.getContents({
                owner: gitRepoInfo.owner,
                repo: gitRepoInfo.repo,
                path: cflintRulesFileName
            });

            if (cflintRulesResult && cflintRulesResult.hasOwnProperty("status") && cflintRulesResult.status === httpSuccessStatusCode && cflintRulesResult.data.type === "file") {
                const resultText: string = Buffer.from(cflintRulesResult.data.content, cflintRulesResult.data.encoding).toString("utf8");

                fs.writeFileSync(cflintRulesFilePath, resultText);

                rulesLastRetrieved = new Date();
            }
        } catch (err) {
            console.error(err);
        }
    }

    const cflintRulesUri: Uri = Uri.file(cflintRulesFilePath);

    commands.executeCommand("markdown.showPreview", cflintRulesUri);
}

/**
 * Opens a link that lists the CFLint releases.
 */
async function showCFLintReleases(): Promise<void> {
    const cflintReleasesURL: string = "https://github.com/cflint/CFLint/releases";
    const cflintReleasesUri: Uri = Uri.parse(cflintReleasesURL);
    env.openExternal(cflintReleasesUri);
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
function updateState(state: State): void {
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

    showStatusBarItem(editor && shouldLintDocument(editor.document));
}

/**
 * Initializes settings helpful to this extension.
 */
function initializeSettings(): void {
    let fileSettings: WorkspaceConfiguration = workspace.getConfiguration("files", null);
    let fileAssociations = fileSettings.get("associations", {});
    fileAssociations[CONFIG_FILENAME] = "json";
    fileSettings.update("associations", fileAssociations, ConfigurationTarget.Global);
}

/**
 * This method is called when the extension is activated.
 *
 * @param context The context object for this extension.
 */
export async function activate(context: ExtensionContext): Promise<void> {
    console.log(`[${getCurrentDateTimeFormatted()}] cflint is active!`);

    const thisExtension = extensions.getExtension("KamasamaK.vscode-cflint");
    minimumTypingDelay = thisExtension.packageJSON.contributes.configuration.properties["cflint.typingDelay"].minimum;
    minimumCooldown = thisExtension.packageJSON.contributes.configuration.properties["cflint.linterCooldown"].minimum;

    initializeSettings();

    extensionPath = context.extensionPath;
    logPath = context.logPath;

    diagnosticCollection = languages.createDiagnosticCollection("cflint");

    typingDelayer = new Map<Uri, ThrottledDelayer<void>>();
    linterCooldowns = new Map<Uri, number>();
    runningLints = new Map<Uri, ChildProcess>();
    queuedLints = new Map<Uri, TextDocument>();

    statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 0);
    statusBarItem.text = "CFLint";

    context.subscriptions.push(
        diagnosticCollection,
        statusBarItem,
        commands.registerCommand("cflint.enable", enable),
        commands.registerCommand("cflint.disable", disable),
        commands.registerCommand("cflint.viewRulesDoc", showRuleDocumentation),
        commands.registerCommand("cflint.createRootConfig", createRootConfig),
        commands.registerCommand("cflint.createCwdConfig", createCwdConfig),
        commands.registerCommand("cflint.openRootConfig", showRootConfig),
        commands.registerCommand("cflint.openActiveConfig", showActiveConfig)
    );

    context.subscriptions.push(commands.registerCommand("cflint.runLinter", () => {
        if (window.activeTextEditor === undefined) {
            window.showErrorMessage("No active text editor to lint");
            return;
        }

        if (!shouldLintDocument(window.activeTextEditor.document)) {
            return;
        }

        lintDocument(window.activeTextEditor.document);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.outputTextFile", async () => {
        outputLintDocument(window.activeTextEditor.document, OutputFormat.Text);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.outputHtmlFile", async () => {
        outputLintDocument(window.activeTextEditor.document, OutputFormat.Html);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.outputJsonFile", async () => {
        outputLintDocument(window.activeTextEditor.document, OutputFormat.Json);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.outputXmlFile", async () => {
        outputLintDocument(window.activeTextEditor.document, OutputFormat.Xml);
    }));

    const cfmlExt = extensions.getExtension("KamasamaK.vscode-cfml");
    if (!cfmlExt.isActive) {
        await cfmlExt.activate();
    }

    try {
        cfmlApi = cfmlExt.exports.getAPI(0);
    } catch (err) {
        console.error(err);
    }

    // TODO: Add command for running linter for all opened CFML files. Needs refactoring. Needs API for opened editors.

    context.subscriptions.push(workspace.onDidOpenTextDocument((document: TextDocument) => {
        let cflintSettings: WorkspaceConfiguration = getCFLintSettings(document.uri);
        let runModes: RunModes = cflintSettings.get("runModes");
        if (!shouldLintDocument(document) || !runModes.onOpen) {
            return;
        }

        if (!document.uri.path || (path.basename(document.uri.path) === document.uri.path && !fs.existsSync(document.uri.path))) {
            return;
        }

        if (cfmlApi && cfmlApi.isBulkCaching()) {
            return;
        }

        // TODO: See https://github.com/Microsoft/vscode/issues/15178 for getting opened editors.

        lintDocument(document);
    }));

    context.subscriptions.push(workspace.onDidSaveTextDocument((document: TextDocument) => {
        let cflintSettings: WorkspaceConfiguration = getCFLintSettings(document.uri);
        let runModes: RunModes = cflintSettings.get("runModes");

        if (!shouldLintDocument(document) || !runModes.onSave) {
            return;
        }

        lintDocument(document);
    }));

    context.subscriptions.push(workspace.onDidChangeTextDocument((evt: TextDocumentChangeEvent) => {
        let cflintSettings: WorkspaceConfiguration = getCFLintSettings(evt.document.uri);
        let runModes: RunModes = cflintSettings.get("runModes");
        if (!shouldLintDocument(evt.document) || !runModes.onChange) {
            return;
        }

        let delayer: ThrottledDelayer<void> = typingDelayer.get(evt.document.uri);
        if (!delayer) {
            let typingDelay: number;
            try {
                typingDelay = cflintSettings.get<number>("typingDelay");
                typingDelay = Math.max(typingDelay, minimumTypingDelay);
            } catch (err) {
                typingDelay = minimumTypingDelay;
            }
            delayer = new ThrottledDelayer<void>(typingDelay);
            typingDelayer.set(evt.document.uri, delayer);
        }

        delayer.trigger(async () => {
            lintDocument(evt.document);
            typingDelayer.delete(evt.document.uri);
        });
    }));

    context.subscriptions.push(workspace.onDidCloseTextDocument((document: TextDocument) => {
        if (!isCfmlLanguage(document.languageId)) {
            return;
        }

        // Exclude files opened by vscode for Git
        if (document.uri.scheme === "git") {
            return;
        }

        // Clear everything for file when closed
        if (runningLints.has(document.uri)) {
            runningLints.get(document.uri).kill();
            runningLints.delete(document.uri);
        }
        diagnosticCollection.delete(document.uri);
        linterCooldowns.delete(document.uri);
        queuedLints.delete(document.uri);

        if (runningLints.size === 0) {
            updateState(State.Stopped);
        }
    }));

    context.subscriptions.push(commands.registerCommand("cflint.clearActiveDocumentProblems", () => {
        diagnosticCollection.delete(window.activeTextEditor.document.uri);
    }));

    context.subscriptions.push(commands.registerCommand("cflint.clearAllProblems", () => {
        diagnosticCollection.clear();
    }));

    context.subscriptions.push(commands.registerCommand("_cflint.addConfigIgnoreRule", addConfigRuleExclusion));

    context.subscriptions.push(languages.registerCodeActionsProvider(DOCUMENT_SELECTOR, new CFLintCodeActionProvider()));

    context.subscriptions.push(window.onDidChangeActiveTextEditor(updateStatusBarItem));

    updateStatusBarItem(window.activeTextEditor);
}

/**
 * This method is called when the extension is deactivated.
 */
export function deactivate(): void {
}
