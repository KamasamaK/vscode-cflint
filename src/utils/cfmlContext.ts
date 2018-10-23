import * as path from "path";
import { Position, Range, TextDocument } from "vscode";
import { equalsIgnoreCase } from "./textUtil";

const COMPONENT_EXT: string = ".cfc";
const CFM_FILE_EXTS: string[] = [".cfm", ".cfml"];
const COMPONENT_PATTERN: RegExp = /((\/\*\*((?:\*(?!\/)|[^*])*)\*\/\s+)?(<cf)?(component|interface)\b)([^>{]*)/i;

/**
 * Checks whether the given document is a CFM file
 *
 * @param document The document to check
 */
export function isCfmFile(document: TextDocument): boolean {
    const extensionName: string = path.extname(document.fileName);
    for (let currExt of CFM_FILE_EXTS) {
        if (equalsIgnoreCase(extensionName, currExt)) {
            return true;
        }
    }
    return false;
}

/**
 * Checks whether the given document is a CFC file
 *
 * @param document The document to check
 */
export function isCfcFile(document: TextDocument): boolean {
    const extensionName = path.extname(document.fileName);
    return equalsIgnoreCase(extensionName, COMPONENT_EXT);
}

/**
 * Returns all of the ranges in which tagged cfscript is active
 *
 * @param document The document to check
 * @param range Optional range within which to check
 */
export function getCfScriptRanges(document: TextDocument, range?: Range): Range[] {
    let ranges: Range[] = [];
    let documentText: string;
    let textOffset: number;
    if (range && document.validateRange(range)) {
        documentText = document.getText(range);
        textOffset = document.offsetAt(range.start);
    } else {
        documentText = document.getText();
        textOffset = 0;
    }

    const cfscriptTagPattern: RegExp = getTagPattern("cfscript");
    let cfscriptTagMatch: RegExpExecArray = null;
    while (cfscriptTagMatch = cfscriptTagPattern.exec(documentText)) {
        const prefixLen: number = cfscriptTagMatch[1].length + cfscriptTagMatch[2].length + 1;
        const cfscriptBodyText: string = cfscriptTagMatch[3];
        if (cfscriptBodyText) {
            const cfscriptBodyStartOffset: number = textOffset + cfscriptTagMatch.index + prefixLen;
            ranges.push(new Range(
                document.positionAt(cfscriptBodyStartOffset),
                document.positionAt(cfscriptBodyStartOffset + cfscriptBodyText.length)
            ));
        }
    }

    return ranges;
}

/**
 * Returns whether the given position is within a CFScript block
 *
 * @param document The document to check
 * @param position Position at which to check
 */
export function isInCfScript(document: TextDocument, position: Position): boolean {
    return isInRanges(getCfScriptRanges(document), position);
}

/**
 * Returns whether the given document is a script component
 *
 * @param document The document to check
 */
export function isScriptComponent(document: TextDocument): boolean {
    const componentMatch: RegExpExecArray = COMPONENT_PATTERN.exec(document.getText());
    if (!componentMatch) {
        return false;
    }
    const checkTag: string = componentMatch[4];

    return isCfcFile(document) && !checkTag;
}

/**
 * Returns whether the given position is in a CFScript context
 *
 * @param document The document to check
 * @param position Position at which to check
 */
export function isPositionScript(document: TextDocument, position: Position): boolean {
    return (isScriptComponent(document) || isInCfScript(document, position));
}

/**
 * Returns whether the given position is within a set of ranges
 *
 * @param ranges The set of ranges within which to check
 * @param position Position at which to check
 */
export function isInRanges(ranges: Range[], position: Position): boolean {
    return ranges.some((range: Range) => {
        return range.contains(position);
    });
}

/**
 * Returns a pattern that matches tags with the given name.
 * Capture groups
 * 1: Name/Prefix
 * 2: Attributes
 * 3: Body
 *
 * @param tagName The name of the tag to capture
 */
export function getTagPattern(tagName: string): RegExp {
    return new RegExp(`(<${tagName}\\s*)([^>]*?)(?:>([\\s\\S]*?)<\\/${tagName}>|\\/?>)`, "gi");
}
