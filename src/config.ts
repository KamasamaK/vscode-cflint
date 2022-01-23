import findup from "findup-sync";
import * as fs from "fs";
import * as path from "path";
import { Position, Range, TextDocument, Uri, window, workspace, WorkspaceConfiguration, WorkspaceEdit, TextEditor } from "vscode";
import { getCFLintSettings } from "./extension";
import { fileExists, writeTextFile } from "./utils/fileUtils";

export const CONFIG_FILENAME = ".cflintrc";

const configFileDefault: string = JSON.stringify(
    {
        "rule": [],
        "excludes": [],
        "includes": [],
        "inheritParent": false,
        "parameters": {}
    },
    null,
    "\t"
);

interface PluginMessage {
    code: string;
    messageText?: string;
    severity?: string;
}

interface RuleParameter {
    name: string;
    value;
}

interface Rule {
    name: string;
    className: string;
    message: PluginMessage[];
    parameter: RuleParameter[];
}

interface ConfigParameters {
    [name: string]: string;
}

export interface Config {
    rule?: Rule[];
    excludes?: PluginMessage[];
    includes?: PluginMessage[];
    inheritParent?: boolean;
    parameters?: ConfigParameters;
}

/**
 * Creates a default configuration file in the workspace root path.
 *
 * @param directory The directory in which to create the config file.
 * @return Indication of whether the file creation was successful.
 */
async function createDefaultConfiguration(directory: Uri): Promise<boolean> {
    if (!directory) {
        window.showErrorMessage("A CFLint configuration can only be generated if VS Code is opened on a workspace folder.");
        return false;
    }

    const cflintConfigFileUri = Uri.joinPath(directory, CONFIG_FILENAME);
    if (!await fileExists(cflintConfigFileUri)) {
        await writeTextFile(cflintConfigFileUri, configFileDefault);
        window.showInformationMessage("Successfully created configuration file", "Open file").then(
            async (selection: string) => {
                if (selection === "Open file") {
                    const textDocument: TextDocument = await workspace.openTextDocument(cflintConfigFileUri);
                    window.showTextDocument(textDocument);
                }
            }
        );

        return true;
    } else {
        window.showErrorMessage("Configuration file already exists", "Open file").then(
            async (selection: string) => {
                if (selection === "Open file") {
                    const textDocument: TextDocument = await workspace.openTextDocument(cflintConfigFileUri);
                    window.showTextDocument(textDocument);
                }
            }
        );
    }

    return false;
}

/**
 * Checks to see if an alternate config file exists.
 *
 * @param resource The resource for which to check the settings
 * @return Whether cflint.altConfigFile resolves to a valid path.
 */
function alternateConfigFileExists(resource: Uri): boolean {
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(resource);
    const altConfigFilePath: string = cflintSettings.get<string>("altConfigFile.path", "");

    /* TODO: Replace with fileExists when converted to async
    const altConfigFileUri = Uri.file(altConfigFilePath);
    return fileExists(altConfigFileUri);
    */

    return fs.existsSync(altConfigFilePath);
}

/**
 * Gets the full path to the config file to use for the given document.
 *
 * @param document The document for which the config file will be retrieved.
 * @param fileName The filename that will be checked.
 * @return The full path to the config file, or undefined if none.
 */
export function getConfigFilePath(document: TextDocument, fileName: string = CONFIG_FILENAME): string {
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(document.uri);
    const altConfigFile: string = cflintSettings.get<string>("altConfigFile.path", "");
    const altConfigFileUsage: string = cflintSettings.get<string>("altConfigFile.usage", "fallback");
    const altConfigFileExists: boolean = alternateConfigFileExists(document.uri);

    if (altConfigFileExists && altConfigFileUsage === "always") {
        return altConfigFile;
    }

    const currentWorkingDir: string = path.dirname(document.fileName);
    const projectConfig: string = findup(fileName, { cwd: currentWorkingDir });
    if (projectConfig) {
        return projectConfig;
    }

    if (altConfigFileExists && altConfigFileUsage === "fallback") {
        return altConfigFile;
    }

    return undefined;
}

/**
 * Returns a configuration object for the given configuration document
 *
 * @param configDocument The document for the config file to parse
 */
export function parseConfig(configDocument: TextDocument): Config {
    let parsedConfig: Config;
    try {
        parsedConfig = JSON.parse(configDocument.getText());
    } catch (ex) {
        window.showErrorMessage("Unable to parse configuration file.");
    }

    return parsedConfig;
}

/**
 * Gets the active config document based on the given document
 *
 * @param document The document from which to determine the active config
 */
export async function getActiveConfig(document: TextDocument = window.activeTextEditor.document): Promise<TextDocument | undefined> {
    const currentConfigPath = getConfigFilePath(document);
    if (currentConfigPath) {
        return workspace.openTextDocument(currentConfigPath);
    } else {
        return undefined;
    }
}

/**
 * Adds the given rule code as an exclusion to the given document
 *
 * @param document The document for the config file to modify
 * @param ruleCode The rule code to be excluded
 */
export async function addConfigRuleExclusion(document: TextDocument, ruleCode: string): Promise<boolean> {
    const configDocument: TextDocument = await getActiveConfig(document);

    if (!configDocument) {
        return false;
    }

    const documentText: string = configDocument.getText();
    const parsedConfig: Config = parseConfig(configDocument);

    if (!parsedConfig) {
        return false;
    }

    if (!parsedConfig.hasOwnProperty("excludes")) {
        parsedConfig.excludes = [];
    }

    const foundExclusion: boolean = parsedConfig.excludes.some((rule) => {
        return (rule?.code === ruleCode);
    });
    if (foundExclusion) {
        return false;
    }

    let includeIndex = -1;
    if (parsedConfig.hasOwnProperty("includes")) {
        includeIndex = parsedConfig.includes.findIndex((rule) => {
            return (rule?.code === ruleCode);
        });
    }

    if (includeIndex !== -1) {
        parsedConfig.includes.splice(includeIndex, 1);
    } else {
        parsedConfig.excludes.push(
            {
                "code": ruleCode
            }
        );
    }

    const edit: WorkspaceEdit = new WorkspaceEdit();
    const documentStart = new Position(0, 0);
    const documentRange = new Range(documentStart, configDocument.positionAt(documentText.length));
    edit.replace(configDocument.uri, documentRange, JSON.stringify(parsedConfig, null, "\t"));

    const success: boolean = await workspace.applyEdit(edit);
    if (success) {
        return configDocument.save();
    }

    return false;
}

/**
 * Creates a config file in the workspace root
 * @editor The text editor which represents the document for which to create a root config
 */
export async function createRootConfig(editor: TextEditor = window.activeTextEditor): Promise<boolean> {
    const workspaceFolder = workspace.getWorkspaceFolder(editor.document.uri);
    return createDefaultConfiguration(workspaceFolder.uri);
}

/**
 * Opens the config file in the root
 * @editor The text editor which represents the document for which to show the root config
 */
export async function showRootConfig(editor: TextEditor = window.activeTextEditor): Promise<boolean> {
    const workspaceFolder = workspace.getWorkspaceFolder(editor.document.uri);

    const rootConfigUri = Uri.joinPath(workspaceFolder.uri, CONFIG_FILENAME);

    if (await fileExists(rootConfigUri)) {
        const configDocument: TextDocument = await workspace.openTextDocument(rootConfigUri);
        window.showTextDocument(configDocument);
        return true;
    } else {
        window.showErrorMessage("No config file could be found in the current workspace folder.", "Create Root Config").then(
            async (selection: string) => {
                if (selection === "Create Root Config") {
                    createRootConfig(editor);
                }
            }
        );
    }

    return false;
}

/**
 * Shows the active config document
 * @editor The text editor which represents the document for which to show the config in the current working directory
 */
export async function showActiveConfig(editor: TextEditor = window.activeTextEditor): Promise<boolean> {
    const configDocument: TextDocument = await getActiveConfig(editor.document);

    if (!configDocument) {
        window.showErrorMessage("No config file is being used for the currently active document.", "Create Root Config").then(
            async (selection: string) => {
                if (selection === "Create Root Config") {
                    createRootConfig(editor);
                }
            }
        );

        return false;
    }

    window.showTextDocument(configDocument);

    return true;
}

/**
 * Creates a config file in the current working directory
 * @editor The text editor which represents the document for which to create a config in the current working directory
 */
export async function createCwdConfig(editor: TextEditor = window.activeTextEditor): Promise<boolean> {
    const directory = Uri.file(path.dirname(editor.document.fileName));
    return createDefaultConfiguration(directory);
}
