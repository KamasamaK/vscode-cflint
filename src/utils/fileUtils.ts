import { workspace, Uri } from "vscode";

/**
 * Checks if the file at the given URI exists
 * @param fileUri The file URI to check
 */
export async function fileExists(fileUri: Uri): Promise<boolean> {
    try {
        await workspace.fs.stat(fileUri);
        return true;
    } catch (err) {
        return false;
    }
}

export async function readTextFile(fileUri: Uri): Promise<string> {
    const readData = await workspace.fs.readFile(fileUri);
    return Buffer.from(readData).toString("utf8");
}

export async function writeTextFile(fileUri: Uri, fileText: string): Promise<void> {
    return workspace.fs.writeFile(fileUri, Buffer.from(fileText));
}
