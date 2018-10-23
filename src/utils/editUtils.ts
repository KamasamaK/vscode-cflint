import { TextEdit, TextEditor, TextEditorEdit, Uri, window } from "vscode";

export function createLineComment(text: string, isScript: boolean): string {
    let comment: string;
    if (isScript) {
        comment = "// " + text;
    } else {
        comment = `<!--- ${text} --->`;
    }

    return comment;
}

export function applyTextEdits(uri: Uri, edits: TextEdit[]): void {
    const textEditor: TextEditor = window.activeTextEditor;
    if (textEditor && textEditor.document.uri === uri) {
        textEditor.edit((mutator: TextEditorEdit) => {
            for (let edit of edits) {
                mutator.replace(edit.range, edit.newText);
            }
        }).then((success: boolean) => {
            if (!success) {
                window.showErrorMessage("Failed to apply fixes to the document.");
            }
        });
    }
}
