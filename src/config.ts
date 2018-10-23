import * as fs from "fs";
import * as path from "path";
import { Position, Range, TextDocument, WorkspaceConfiguration, WorkspaceEdit, window, workspace, Uri } from "vscode";
import { getCFLintSettings } from "./extension";

const findup = require("findup-sync");

export const CONFIG_FILENAME: string = ".cflintrc";

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
async function createDefaultConfiguration(directory: string): Promise<boolean> {
    if (!directory) {
        window.showErrorMessage("A CFLint configuration can only be generated if VS Code is opened on a workspace folder.");
        return false;
    }
    let cflintConfigFile: string = path.join(directory, CONFIG_FILENAME);
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
 * Checks to see if an alternate config file exists.
 *
 * @return Whether cflint.altConfigFile resolves to a valid path.
 */
function alternateConfigFileExists(resource: Uri): boolean {
    const cflintSettings: WorkspaceConfiguration = getCFLintSettings(resource);
    const altConfigFile: string = cflintSettings.get<string>("altConfigFile.path", "");
    return fs.existsSync(altConfigFile);
}

/**
 * Returns a configuration object for the given configuration document
 *
 * @param configDocument The document for the config file to parse
 */
export function parseConfig(configDocument: TextDocument): Config {
    const documentText: string = configDocument.getText();
    let parsedConfig: Config;
    try {
        parsedConfig = JSON.parse(documentText);
    } catch (ex) {
        window.showErrorMessage("Unable to parse configuration file.");
        return undefined;
    }

    return parsedConfig;
}

/**
 * Adds the given rule code as an exclusion to the given document
 *
 * @param document The document for the config file to modify
 * @param ruleCode The rule code to be excluded
 */
export async function addConfigRuleExclusion(document: TextDocument, ruleCode: string): Promise<boolean> {
    const configDocument: TextDocument = await getActiveConfig(document);
    const documentText: string = configDocument.getText();
    let parsedConfig: Config = parseConfig(configDocument);

    if (!parsedConfig) {
        return false;
    }

    if (!parsedConfig.hasOwnProperty("excludes")) {
        parsedConfig.excludes = [];
    }

    const foundExclusion: boolean = parsedConfig.excludes.some((rule) => {
        return (rule.hasOwnProperty("code") && rule.code === ruleCode);
    });
    if (foundExclusion) {
        return false;
    }

    let includeIndex: number = -1;
    if (parsedConfig.hasOwnProperty("includes")) {
        includeIndex = parsedConfig.includes.findIndex((rule) => {
            return (rule.hasOwnProperty("code") && rule.code === ruleCode);
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

    let edit: WorkspaceEdit = new WorkspaceEdit();
    const documentStart = new Position(0, 0);
    const documentRange = new Range(documentStart, configDocument.positionAt(documentText.length));
    edit.replace(configDocument.uri, documentRange, JSON.stringify(parsedConfig, null, "\t"));

    workspace.applyEdit(edit).then((success: boolean) => {
        if (success) {
            return configDocument.save();
        }

        return false;
    });
}

/**
 * Creates a config file in the workspace root
 */
export async function createRootConfig(): Promise<boolean> {
    const workspaceFolder = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri);
    return createDefaultConfiguration(workspaceFolder.uri.fsPath);
}

/**
 * Opens the config file in the root
 */
export async function showRootConfig(): Promise<boolean> {
    const workspaceFolder = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri);

    const rootConfigPath = path.join(workspaceFolder.uri.fsPath, CONFIG_FILENAME);

    if (fs.existsSync(rootConfigPath)) {
        const configDocument: TextDocument = await workspace.openTextDocument(rootConfigPath);
        window.showTextDocument(configDocument);
        return true;
    } else {
        window.showErrorMessage("No config file could be found in the current workspace folder.", "Create Root Config").then(
            async (selection: string) => {
                if (selection === "Create Root Config") {
                    return createRootConfig();
                }
            }
        );
    }

    return false;
}

/**
 * Gets the active config document based on the given document
 *
 * @param document The document from which to determine the active config
 */
export async function getActiveConfig(document: TextDocument = window.activeTextEditor.document): Promise<TextDocument | undefined> {
    let currentConfigPath = getConfigFilePath(document);
    if (currentConfigPath) {
        return workspace.openTextDocument(currentConfigPath);
    } else {
        return undefined;
    }
}

/**
 * Shows the active config document
 */
export async function showActiveConfig(): Promise<boolean> {
    const configDocument: TextDocument = await getActiveConfig();

    if (!configDocument) {
        window.showErrorMessage("No config file is being used for the currently active document.", "Create Root Config").then(
            async (selection: string) => {
                if (selection === "Create Root Config") {
                    createRootConfig();
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
 */
export async function createCwdConfig(): Promise<boolean> {
    return createDefaultConfiguration(path.dirname(window.activeTextEditor.document.fileName));
}
